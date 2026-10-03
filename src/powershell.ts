/**
 * PowerShell snippet builders and the WinRM UTF-8 envelope.
 *
 * The user script is delivered on the WinRS **stdin** stream, not on the
 * command line. WinRS hands the command line to cmd.exe, which caps it at
 * ~8191 characters; `-EncodedCommand` inflates a script by 2.67x
 * (UTF-16LE → base64), so the command line can carry only about 1.5 KB of
 * script. That silently broke every large payload — most visibly the 48 KiB
 * transfer chunk, whose embedded base64 alone is ~65K characters.
 *
 * So the command line is now a *constant* outer script and the user script
 * rides stdin, which has no such limit (verified to 200 KB).
 *
 * The outer script reads a byte count, then that many bytes, starts a child
 * `powershell.exe` and feeds it the script on its stdin. The process boundary
 * is what makes `exit N` and an uncaught `throw` survivable: they terminate
 * the *child*, and the outer script is still alive to print the envelope.
 * `-EncodedCommand` for the child also sidesteps the execution policy
 * entirely — the policy governs `.ps1` files, not encoded commands — so no
 * temp file is written and no policy block can lose the envelope.
 *
 * The child body is `& (...) 2>&1 | Out-String -Stream`. Both halves matter:
 * `2>&1` pulls error records into the success stream, `Out-String -Stream`
 * stringifies them onto stdout *line by line*. Plain `Out-String` would also
 * stringify them but buffers the whole pipeline, discarding everything
 * produced before a mid-script `exit`; bare `2>&1` without `Out-String`
 * leaves the records to be re-serialized as CLIXML on stderr, where the
 * envelope's CLIXML stripping deletes the text outright.
 *
 * The envelope is three lines — a marker with the exit code, then one base64
 * line per stream:
 *
 *     __DSH_WINRM__<code>
 *     O:<base64 of UTF-8 stdout>
 *     E:<base64 of UTF-8 stderr>
 *
 * Every payload is ASCII, so the transport cannot corrupt it and Chinese
 * output survives losslessly. The `O:` / `E:` labels are load-bearing: the
 * WinRM client trims each response chunk, which can eat the newline between
 * two lines, and base64 never contains `:`, so the labels stay parseable
 * even when the separators vanish.
 */

/** Marker line prefix carrying the exit code: '__DSH_WINRM__<code>'. */
export const ENVELOPE_MARKER = '__DSH_WINRM__'

/** Max characters per stdin Send; split on code points, never mid-surrogate-pair. */
export const STDIN_CHUNK_CHARS = 16_384

/** PS single-quoted literal (doubles embedded quotes). */
export function sq(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** Base64 of a UTF-16LE PowerShell script, for -EncodedCommand. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Child script: reads the user script from its own stdin, runs it, and lets
 * `exit` end *this* process with the right code.
 *
 * The output shape is fixed by how PowerShell surfaces errors. A terminating
 * `throw` is reported by the `catch`; a non-terminating error only reaches the
 * success stream via `2>&1`, and `Out-String -Stream` turns each such record
 * into text as it arrives. `$LASTEXITCODE` is preferred over the accumulated
 * code so `cmd /c exit 7` reports 7 rather than 0.
 */
const CHILD_SCRIPT = [
  "$ErrorActionPreference='Continue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$i=[Console]::OpenStandardInput()',
  '$m=New-Object System.IO.MemoryStream',
  '$i.CopyTo($m)',
  '$s=[Text.Encoding]::UTF8.GetString($m.ToArray())',
  'if($s.Length -gt 0 -and [int]$s[0] -eq 0xFEFF){$s=$s.Substring(1)}',
  '$c=0',
  'try{ &([scriptblock]::Create($s)) 2>&1 | Out-String -Stream -Width 4096',
  'if($null -ne $LASTEXITCODE){$c=$LASTEXITCODE}',
  '}catch{ $_|Out-String; $c=1 }',
  'exit $c',
  '',
].join('\r\n')

/**
 * Outer script (constant, so the command line never grows with the payload):
 * read `<byteCount>\n<utf8 script>` from stdin, run it in a child
 * powershell.exe, then print the three-line envelope.
 *
 * The child is started with redirected streams *before* anything is written to
 * its stdin, and both readers are started before the write, so a child that
 * fills a pipe buffer cannot deadlock the outer script. Closing the writer is
 * what gives the child a real EOF — without it the child would block forever
 * on `CopyTo`.
 */
const OUTER_SCRIPT = [
  "$ErrorActionPreference='Continue'",
  "$z=@'",
  CHILD_SCRIPT,
  "'@",
  "$a=''",
  "$e=''",
  '$c=0',
  'try{',
  '  $i=[Console]::OpenStandardInput()',
  "  $d=''",
  '  while($true){$b=$i.ReadByte();if($b -lt 0 -or $b -eq 10){break};if($b -ne 13){$d+=[char]$b}}',
  '  $n=[int]$d',
  '  $u=New-Object byte[] $n',
  '  $r=0',
  '  while($r -lt $n){$k=$i.Read($u,$r,$n-$r);if($k -le 0){break};$r+=$k}',
  '  $s=[Text.Encoding]::UTF8.GetString($u,0,$r)',
  '  $p=New-Object System.Diagnostics.ProcessStartInfo',
  "  $p.FileName='powershell.exe'",
  '  $p.UseShellExecute=$false',
  '  $p.RedirectStandardOutput=$true',
  '  $p.RedirectStandardError=$true',
  '  $p.RedirectStandardInput=$true',
  '  $p.StandardOutputEncoding=[Text.Encoding]::UTF8',
  '  $p.StandardErrorEncoding=[Text.Encoding]::UTF8',
  '  $p.CreateNoWindow=$true',
  "  $p.Arguments='-NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($z))",
  '  $q=[System.Diagnostics.Process]::Start($p)',
  '  $x=$q.StandardOutput.ReadToEndAsync()',
  '  $y=$q.StandardError.ReadToEndAsync()',
  '  $w=New-Object System.IO.StreamWriter($q.StandardInput.BaseStream,(New-Object System.Text.UTF8Encoding($false)))',
  '  $w.Write($s)',
  '  $w.Flush()',
  '  $w.Close()',
  '  $q.WaitForExit()',
  '  $a=[string]$x.Result',
  '  $e=[string]$y.Result',
  '  $c=$q.ExitCode',
  '}catch{',
  '  $a=[string]$a+[string]($_|Out-String)',
  '  $c=1',
  '}',
  sq(ENVELOPE_MARKER) + '+[string]$c',
  "'O:'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$a))",
  "'E:'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$e))",
  '',
].join('\r\n')

/**
 * The constant powershell.exe command line that runs the envelope.
 *
 * Deliberately takes no payload: keeping the command line under cmd.exe's
 * ~8191-character cap is the whole point of the stdin channel.
 */
export function powershellCommandLine(): string {
  return 'powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand ' + encodeCommand(OUTER_SCRIPT)
}

/**
 * Bootstrap for the streaming upload path: read `<byteCount>\n<script>` from
 * stdin, then run that script **in this process** so it can keep draining the
 * same stdin stream.
 *
 * This exists because {@link psReceiveStream} outgrew the command line. WinRS
 * hands the command line to cmd.exe, whose limit is about 8191 characters, and
 * the receiver is 3424 characters of PowerShell — 9206 once base64-of-UTF-16
 * expands it, over the cap. Shipping the receiver on stdin instead costs one
 * extra `Send` and keeps the command line a constant 1154 characters no matter
 * how the receiver grows.
 *
 * Running the receiver in-process (rather than in a child, as
 * {@link OUTER_SCRIPT} does) is what makes the handoff work: the child would
 * need its own stdin, and the payload has to keep flowing into whatever reads
 * the file. A fresh `[Console]::OpenStandardInput()` inside the receiver picks
 * up exactly where this bootstrap stopped reading, because `Read` on the raw
 * stream never buffers ahead of the count it was asked for.
 */
const STREAM_BOOTSTRAP = [
  "$ErrorActionPreference='Continue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$i=[Console]::OpenStandardInput()',
  "$d=''",
  'while($true){$b=$i.ReadByte();if($b -lt 0 -or $b -eq 10){break};if($b -ne 13){$d+=[char]$b}}',
  '$n=[int]$d',
  '$u=New-Object byte[] $n',
  '$r=0',
  'while($r -lt $n){$k=$i.Read($u,$r,$n-$r);if($k -le 0){break};$r+=$k}',
  '$s=[Text.Encoding]::UTF8.GetString($u,0,$r)',
  '$c=0',
  'try{',
  '  &([scriptblock]::Create($s))',
  '}catch{',
  '  [Console]::Error.WriteLine([string]($_|Out-String))',
  '  $c=1',
  '}',
  'exit $c',
  '',
].join('\r\n')

/**
 * The constant powershell.exe command line for a streaming upload.
 *
 * The receiver travels on stdin right behind it, so this stays well clear of
 * cmd.exe's cap and does not change when the receiver does.
 */
export function streamCommandLine(): string {
  return 'powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand ' + encodeCommand(STREAM_BOOTSTRAP)
}

/**
 * The stdin payload for one command: the UTF-8 **byte** count, a newline, then
 * the raw script.
 *
 * The count is in bytes, not characters, because the outer script sizes its
 * receive buffer from it — a script with multi-byte characters would otherwise
 * be truncated mid-character.
 * @param userScript - the PowerShell script to run.
 * @returns the payload to send on WinRS stdin.
 */
export function scriptPayload(userScript: string): string {
  return String(Buffer.byteLength(userScript, 'utf8')) + '\n' + userScript
}

/**
 * Split a payload into Send-sized pieces without cutting a surrogate pair.
 *
 * `Command.doSendInput` encodes each piece to UTF-8 independently, so a lone
 * surrogate at a chunk boundary would be replaced with U+FFFD and corrupt the
 * script. Iterating with `for…of` yields whole code points, so a pair always
 * stays in one piece.
 * @param payload - the full stdin payload.
 * @returns the pieces to send in order; never empty.
 */
export function splitScriptPayload(payload: string): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const ch of payload) {
    if (piece.length + ch.length > STDIN_CHUNK_CHARS) {
      pieces.push(piece)
      piece = ''
    }
    piece += ch
  }
  if (piece !== '' || pieces.length === 0) pieces.push(piece)
  return pieces
}

// ------------------------------------------------------------ snippets

/** JSON: full service table (CIM). */
export function psListServices(): string {
  return [
    '$__s = Get-CimInstance Win32_Service | Select-Object Name, DisplayName, State, StartMode, StartName | ForEach-Object {',
    '  [PSCustomObject]@{ name=$_.Name; displayName=$_.DisplayName; status=[string]$_.State; startMode=[string]$_.StartMode; startName=[string]$_.StartName }',
    '}',
    'ConvertTo-Json -InputObject $__s -Compress -Depth 3',
    '',
  ].join('\r\n')
}

/** JSON: one service after an action. */
export function psServiceAction(name: string, action: 'start' | 'stop' | 'restart' | 'set-auto' | 'set-manual' | 'set-disabled'): string {
  const statements: string[] = []
  if (action === 'start') statements.push('Start-Service -Name ' + sq(name) + ' -ErrorAction Stop')
  if (action === 'stop') statements.push('Stop-Service -Name ' + sq(name) + ' -Force -ErrorAction Stop')
  if (action === 'restart') statements.push('Restart-Service -Name ' + sq(name) + ' -Force -ErrorAction Stop')
  if (action === 'set-auto') statements.push('Set-Service -Name ' + sq(name) + ' -StartupType Automatic -ErrorAction Stop')
  if (action === 'set-manual') statements.push('Set-Service -Name ' + sq(name) + ' -StartupType Manual -ErrorAction Stop')
  if (action === 'set-disabled') statements.push('Set-Service -Name ' + sq(name) + ' -StartupType Disabled -ErrorAction Stop')
  statements.push('$__s = Get-CimInstance Win32_Service -Filter ' + sq('Name=' + name.replace(/'/g, "''")) + ' | Select-Object Name, DisplayName, State, StartMode, StartName')
  statements.push('ConvertTo-Json -InputObject $__s -Compress -Depth 3')
  return statements.join('\r\n')
}

/** JSON: process table. */
export function psListProcesses(): string {
  return [
    '$__p = Get-Process | Sort-Object Id | Select-Object Id, ProcessName, CPU, WS, StartTime, Path | ForEach-Object {',
    '  [PSCustomObject]@{ id=$_.Id; name=$_.ProcessName; cpu=if($null -eq $_.CPU){$null}else{[math]::Round([double]$_.CPU,1)}; memMB=[math]::Round($_.WS/1MB,1); startTime=if($_.StartTime){$_.StartTime.ToString(\'yyyy-MM-dd HH:mm:ss\')}else{$null}; path=[string]$_.Path }',
    '}',
    'ConvertTo-Json -InputObject $__p -Compress -Depth 3',
    '',
  ].join('\r\n')
}

/** Kill one process by id. */
export function psKillProcess(id: number): string {
  return 'Stop-Process -Id ' + String(id) + ' -Force -ErrorAction Stop; "killed " + ' + String(id)
}

/** JSON: directory listing. */
export function psListDir(dir: string): string {
  return [
    '$__d = ' + sq(dir),
    '$__items = Get-ChildItem -LiteralPath $__d -Force -ErrorAction Stop | Select-Object Name, PSIsContainer, Length, LastWriteTime | ForEach-Object {',
    '  [PSCustomObject]@{ name=[string]$_.Name; type=if($_.PSIsContainer){\'dir\'}elseif(-not $_.PSIsContainer -and $_.Length -ge 0){\'file\'}else{\'other\'}; size=if($_.PSIsContainer){0}else{[long]$_.Length}; mtimeMs=[long](([DateTimeOffset]$_.LastWriteTime).ToUnixTimeMilliseconds()) }',
    '}',
    'ConvertTo-Json -InputObject $__items -Compress -Depth 3',
    '',
  ].join('\r\n')
}

/**
 * Plain: remote file size in bytes. Emits nothing at all when the path is
 * missing or is a directory, so the caller can tell "absent" from "empty" —
 * both used to collapse to the string "0", which made a download of a
 * nonexistent file look like a successful transfer of a zero-byte one.
 */
export function psFileSize(p: string): string {
  return [
    '$__f = Get-Item -LiteralPath ' + sq(p) + ' -ErrorAction SilentlyContinue',
    'if ($null -ne $__f -and -not $__f.PSIsContainer) { [string]$__f.Length }',
    '',
  ].join('\r\n')
}

/** Plain: base64 of up to `count` bytes at `offset` (download chunk). */
export function psReadChunk(p: string, offset: number, count: number): string {
  return [
    '$__p = ' + sq(p),
    '$__fs = [System.IO.File]::OpenRead($__p)',
    'try {',
    '  $__fs.Position = [long]' + String(offset),
    '  $__buf = New-Object byte[] ' + String(count),
    '  $__n = $__fs.Read($__buf, 0, $__buf.Length)',
    '  [System.Convert]::ToBase64String($__buf, 0, $__n)',
    '} finally { $__fs.Dispose() }',
    '',
  ].join('\r\n')
}

/**
 * Plain: append `b64` bytes to `p` (Create on first chunk, Append after),
 * prints the number of bytes written.
 */
export function psWriteChunk(p: string, b64: string, append: boolean): string {
  return [
    '$__p = ' + sq(p),
    '$__d = [System.IO.Path]::GetDirectoryName($__p)',
    'if (-not [string]::IsNullOrEmpty($__d)) { [System.IO.Directory]::CreateDirectory($__d) | Out-Null }',
    '$__b = [System.Convert]::FromBase64String(' + sq(b64) + ')',
    '$__mode = ' + (append ? '[System.IO.FileMode]::Append' : '[System.IO.FileMode]::Create'),
    '$__fs = New-Object System.IO.FileStream($__p, $__mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)',
    'try { $__fs.Write($__b, 0, $__b.Length) } finally { $__fs.Dispose() }',
    '[string]$__b.Length',
    '',
  ].join('\r\n')
}

/** Magic stamped into the frame header that precedes every stream chunk. */
export const STREAM_FRAME_MAGIC = 'DSHZ'

/** Frame header size: 4 magic bytes + 4 little-endian length bytes + 1 mode byte + 1 reserved. */
export const STREAM_FRAME_HEADER_BYTES = 10

/** Frame mode: the payload after the header is a gzip member. */
export const STREAM_FRAME_GZIP = 1

/** Frame mode: the payload after the header is raw file bytes. */
export const STREAM_FRAME_RAW = 0

/** Frame mode: the payload after the header is the transfer's metadata. */
export const STREAM_FRAME_HEADER = 2

/** Remote-side buffer used while draining stdin (or inflating a frame) into the file. */
const STREAM_BUFFER_BYTES = 262_144

/**
 * Wrap one payload in a stream frame: `DSHZ` + uint32LE length + mode + pad.
 *
 * The frame is what makes a compressed stream legal on a pipe. stdin cannot
 * seek, so the receiver has to be handed the exact byte count of the next gzip
 * member before it lets `GZipStream` touch it; otherwise the inflater would
 * read into the member that follows and the stream would desynchronize. The
 * mode byte travels with the payload so the client can switch between gzip and
 * raw per chunk.
 * @param payload - gzip member bytes or raw file bytes.
 * @param mode - `STREAM_FRAME_GZIP` or `STREAM_FRAME_RAW`.
 * @returns the framed chunk to place on the stdin stream.
 */
export function buildStreamFrame(payload: Buffer, mode: number): Buffer {
  const frame = Buffer.alloc(STREAM_FRAME_HEADER_BYTES + payload.length)
  frame.write(STREAM_FRAME_MAGIC, 0, 'ascii')
  frame.writeUInt32LE(payload.length, 4)
  frame[8] = mode
  frame[9] = 0
  payload.copy(frame, STREAM_FRAME_HEADER_BYTES)
  return frame
}

/**
 * Streaming receiver: drain framed stdin chunks into the file named by the
 * header frame, until the declared byte count lands.
 *
 * This is the fast upload path. Instead of shipping base64 text inside a
 * PowerShell script — which costs one full shell create/command/delete cycle
 * per 48 KiB — the remote shell starts this script once and the client then
 * pushes bytes straight down the WinRS stdin stream. The only per-chunk cost
 * left is a single `Send`, so a whole file costs one shell and one command no
 * matter how large it is.
 *
 * The script deliberately takes **no arguments**. The destination path and
 * total byte count arrive as the first frame on stdin, which keeps the command
 * line a constant size: WinRS hands the command line to cmd.exe, whose limit
 * is about 8191 characters, and a long remote path interpolated into the
 * script would eat into that budget (the script is base64-of-UTF-16 on the
 * wire, so every character costs 2.67). Reading them from the stream removes
 * the limit entirely and mirrors how `powershellCommandLine` stays constant.
 *
 * Every wire chunk is a frame: `DSHZ` + 4-byte little-endian payload length +
 * 1 mode byte + 1 reserved, followed by exactly that many payload bytes. The
 * explicit frame is what makes a *pipe* usable for a compressed stream: stdin
 * cannot seek, so the receiver must be told how long the next gzip member is
 * before it hands the bytes to `GZipStream`, or the inflater would read into
 * the member that follows. The mode byte lets the client pick per chunk — gzip
 * when it actually shrinks the data, raw bytes when it would not — so
 * incompressible files never pay compression overhead.
 *
 * The script prints the three-line envelope on stdout with the byte count as
 * its payload, so the caller can prove the transfer landed complete.
 * @returns a PowerShell script suitable for `-EncodedCommand`.
 */
export function psReceiveStream(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$__a = ''",
    "$__e = ''",
    '$__c = 0',
    'try {',
    '  $__i = [Console]::OpenStandardInput()',
    '  $__hdr = New-Object byte[] ' + String(STREAM_FRAME_HEADER_BYTES),
    '  $__got = 0',
    '  while ($__got -lt $__hdr.Length) {',
    '    $__k = $__i.Read($__hdr, $__got, $__hdr.Length - $__got)',
    '    if ($__k -le 0) { break }',
    '    $__got += $__k',
    '  }',
    '  if ($__got -lt $__hdr.Length) { throw ' + sq('upload stream ended before its header') + ' }',
    '  if (-not ($__hdr[0] -eq 68 -and $__hdr[1] -eq 83 -and $__hdr[2] -eq 72 -and $__hdr[3] -eq 90)) { throw ' + sq('upload stream lost frame alignment') + ' }',
    '  if ($__hdr[8] -ne ' + String(STREAM_FRAME_HEADER) + ') { throw ' + sq('upload stream started without a header frame') + ' }',
    '  $__size = 0',
    '  for ($__j = 0; $__j -lt 4; $__j++) { $__size = $__size -bor ([int]$__hdr[4 + $__j] -shl (8 * $__j)) }',
    '  $__meta = New-Object byte[] $__size',
    '  $__got = 0',
    '  while ($__got -lt $__size) {',
    '    $__k = $__i.Read($__meta, $__got, $__size - $__got)',
    '    if ($__k -le 0) { break }',
    '    $__got += $__k',
    '  }',
    '  if ($__got -lt $__size) { throw ' + sq('upload stream truncated its header frame') + ' }',
    '  $__text = [System.Text.Encoding]::UTF8.GetString($__meta)',
    '  $__cut = $__text.IndexOf([char]10)',
    '  if ($__cut -lt 0) { throw ' + sq('upload header frame is malformed') + ' }',
    '  $__n = [long]$__text.Substring(0, $__cut)',
    '  $__p = $__text.Substring($__cut + 1)',
    '  $__d = [System.IO.Path]::GetDirectoryName($__p)',
    '  if (-not [string]::IsNullOrEmpty($__d)) { [System.IO.Directory]::CreateDirectory($__d) | Out-Null }',
    '  $__fs = New-Object System.IO.FileStream($__p, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)',
    '  $__w = 0',
    '  try {',
    '    $__buf = New-Object byte[] ' + String(STREAM_BUFFER_BYTES),
    '    while ($__w -lt $__n) {',
    '      $__got = 0',
    '      while ($__got -lt $__hdr.Length) {',
    '        $__k = $__i.Read($__hdr, $__got, $__hdr.Length - $__got)',
    '        if ($__k -le 0) { break }',
    '        $__got += $__k',
    '      }',
    '      if ($__got -lt $__hdr.Length) { break }',
    '      if (-not ($__hdr[0] -eq 68 -and $__hdr[1] -eq 83 -and $__hdr[2] -eq 72 -and $__hdr[3] -eq 90)) { throw ' + sq('upload stream lost frame alignment') + ' }',
    '      $__size = 0',
    '      for ($__j = 0; $__j -lt 4; $__j++) { $__size = $__size -bor ([int]$__hdr[4 + $__j] -shl (8 * $__j)) }',
    '      $__mode = $__hdr[8]',
    '      $__blob = New-Object byte[] $__size',
    '      $__got = 0',
    '      while ($__got -lt $__size) {',
    '        $__k = $__i.Read($__blob, $__got, $__size - $__got)',
    '        if ($__k -le 0) { break }',
    '        $__got += $__k',
    '      }',
    '      if ($__got -lt $__size) { break }',
    '      if ($__mode -eq ' + String(STREAM_FRAME_GZIP) + ') {',
    '        $__ms = New-Object System.IO.MemoryStream(, $__blob)',
    '        $__gz = New-Object System.IO.Compression.GZipStream($__ms, [System.IO.Compression.CompressionMode]::Decompress)',
    '        try {',
    '          while ($true) {',
    '            $__k = $__gz.Read($__buf, 0, $__buf.Length)',
    '            if ($__k -le 0) { break }',
    '            $__fs.Write($__buf, 0, $__k)',
    '            $__w += $__k',
    '          }',
    '        } finally { $__gz.Dispose(); $__ms.Dispose() }',
    '      } else {',
    '        $__fs.Write($__blob, 0, $__blob.Length)',
    '        $__w += $__blob.Length',
    '      }',
    '    }',
    '  } finally { $__fs.Dispose() }',
    '  $__a = [string]$__w',
    '} catch {',
    '  $__a = [string]$__a + [string]($_.Exception.Message)',
    '  $__c = 1',
    '}',
    sq(ENVELOPE_MARKER) + ' + [string]$__c',
    "'O:' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$__a))",
    "'E:' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$__e))",
    '',
  ].join('\r\n')
}

/** Remote-side read buffer used by {@link psSendStream} while draining the file to stdout. */
const SEND_BUFFER_BYTES = 262_144

/**
 * Streaming sender: write one byte range of the file to standard output,
 * gzip-compressed, for the download path.
 *
 * This is the mirror of {@link psReceiveStream}. The old download path asked
 * for 48 KiB at a time, and every chunk cost a full shell create / command /
 * delete cycle — five HTTP round trips each — so a 2 MiB file took 129 s. Here
 * the shell is created once and the client then simply receives; the only
 * per-chunk cost left is one `Receive`, and the target streams the file as fast
 * as the transport will drain it.
 *
 * Two details make this work:
 *
 * - **Only stderr may carry text.** Anything written to the PowerShell success
 *   stream would be merged into the payload and corrupt the file, so the byte
 *   count and any error go to `[Console]::Error` and the exit code, not stdout.
 * - **The range is positional.** `Position` plus a byte count lets several
 *   shells serve different parts of one file concurrently; each writes to its
 *   own offset on the client, so completion order does not matter.
 *
 * Output is gzip-compressed unconditionally. Measured against this target, a
 * compressible 16 MiB file collapsed from 121 round trips to 1 (2.0 s), and an
 * incompressible 2 MiB file was no slower than raw (9457 ms vs 9582 ms), so the
 * compression pays for itself or costs nothing.
 * @param remotePath - file to read on the target.
 * @param start - first byte offset of this worker's range.
 * @param length - number of bytes this worker must send.
 * @returns a PowerShell script suitable for `-EncodedCommand`.
 */
export function psSendStream(remotePath: string, start: number, length: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$__o = [Console]::OpenStandardOutput()',
    '$__n = 0',
    'try {',
    '  $__fs = [System.IO.File]::OpenRead(' + sq(remotePath) + ')',
    '  try {',
    '    $__fs.Position = [long]' + String(start),
    '    $__left = [long]' + String(length),
    '    $__gz = New-Object System.IO.Compression.GZipStream($__o, [System.IO.Compression.CompressionMode]::Compress, $true)',
    '    try {',
    '      $__buf = New-Object byte[] ' + String(SEND_BUFFER_BYTES),
    '      while ($__left -gt 0) {',
    '        $__want = [int][Math]::Min([long]$__buf.Length, $__left)',
    '        $__k = $__fs.Read($__buf, 0, $__want)',
    '        if ($__k -le 0) { break }',
    '        $__gz.Write($__buf, 0, $__k)',
    '        $__n += $__k',
    '        $__left -= $__k',
    '      }',
    '      $__gz.Flush()',
    '    } finally { $__gz.Dispose() }',
    '    $__o.Flush()',
    '  } finally { $__fs.Dispose() }',
    "  [Console]::Error.WriteLine('__DSH_DL__ OK ' + [string]$__n)",
    '} catch {',
    "  [Console]::Error.WriteLine('__DSH_DL__ ERR ' + [string]($_.Exception.Message))",
    '  throw',
    '}',
    '',
  ].join('\r\n')
}

/**
 * Wrap an arbitrary script in the constant powershell.exe invocation.
 *
 * Only safe for scripts that fit cmd.exe's ~8191 character command line (the
 * script is base64-of-UTF-16 on the wire, so it costs 2.67 characters each);
 * {@link psReceiveStream} outgrew that and travels on stdin instead.
 * @param script - the PowerShell script to run.
 * @returns the command line to hand to WinRS.
 */
export function scriptCommandLine(script: string): string {
  return 'powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand ' + encodeCommand(script)
}

/** Decode one base64 envelope field, tolerating whitespace the transport added. */
function decodeField(base64: string): string {
  return Buffer.from(base64.replace(/\s+/g, ''), 'base64').toString('utf8')
}

/**
 * Parse the three-line envelope: { exitCode, stdout, stderr } or null when absent.
 *
 * Fields are located by their `O:` / `E:` labels rather than by splitting on
 * newlines, because the WinRM client trims every response chunk and can drop
 * the newline that separated two lines. base64's alphabet has no colon, so a
 * label can only ever be a delimiter and the search cannot land on payload
 * data. The exit code is signed because `$LASTEXITCODE` can be negative.
 * @param output - the raw stdout accumulated from the WinRS stdout stream.
 * @returns the decoded envelope, or null when the marker is missing.
 */
export function parseEnvelope(output: string): { exitCode: number; stdout: string; stderr: string } | null {
  const text = output.trim()
  const head = new RegExp('^' + ENVELOPE_MARKER + '(-?\\d+)').exec(text)
  if (head === null) return null
  const stdoutAt = text.indexOf('O:')
  const stderrAt = stdoutAt === -1 ? -1 : text.indexOf('E:', stdoutAt + 2)
  return {
    exitCode: Number.parseInt(head[1], 10),
    stdout: stdoutAt === -1 ? '' : decodeField(text.slice(stdoutAt + 2, stderrAt === -1 ? undefined : stderrAt)),
    stderr: stderrAt === -1 ? '' : decodeField(text.slice(stderrAt + 2)),
  }
}

/** The `#< CLIXML` stream header PowerShell writes once before its serialized records. */
const CLIXML_HEADER = /^#< CLIXML\r?$/gm

/** One serialized record block (`<Objs …>…</Objs>`) holding host progress/verbose records. */
const CLIXML_RECORDS = /<Objs\b[^>]*>[\s\S]*?<\/Objs>\r?\n?/g

/**
 * Remove PowerShell's CLIXML host records from a stderr stream.
 *
 * PowerShell marks its stderr stream with a `#< CLIXML` header line and
 * serializes the remote host's own progress/verbose records into `<Objs>`
 * blocks. Both are removed here. Anything else on the stream is genuine
 * process-level stderr and is preserved verbatim — text written between the
 * header and a record block (for example `[Console]::Error`) is real output,
 * not part of the CLIXML payload.
 *
 * The script's own PowerShell errors are already stringified into the
 * envelope's stdout by `Out-String -Stream`, so this only removes
 * transport-level noise such as module-load progress.
 * @param stderr - raw stderr text captured from the WinRS stream or the envelope.
 * @returns the stderr text without CLIXML host records.
 */
export function stripClixml(stderr: string): string {
  return stderr.replace(CLIXML_HEADER, '').replace(CLIXML_RECORDS, '').trim()
}
