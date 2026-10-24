import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENVELOPE_MARKER,
  STDIN_CHUNK_CHARS,
  STREAM_FRAME_GZIP,
  STREAM_FRAME_HEADER,
  STREAM_FRAME_HEADER_BYTES,
  STREAM_FRAME_MAGIC,
  STREAM_FRAME_RAW,
  buildStreamFrame,
  encodeCommand,
  parseEnvelope,
  powershellCommandLine,
  psFileSize,
  psReadChunk,
  psReadTextWindow,
  psEditText,
  psReceiveStream,
  psSendStream,
  psServiceAction,
  psWriteChunk,
  scriptCommandLine,
  scriptPayload,
  splitScriptPayload,
  sq,
  streamCommandLine,
  stripClixml,
} from '../src/powershell.ts'

/** Build the three-line envelope exactly as the outer script prints it. */
function envelope(exitCode: number, stdout: string, stderr: string): string {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
  return `${ENVELOPE_MARKER}${exitCode}\r\nO:${b64(stdout)}\r\nE:${b64(stderr)}`
}

test('envelope round-trips both streams as UTF-8 without loss', () => {
  assert.deepEqual(parseEnvelope(envelope(0, '中文输出', '')), { exitCode: 0, stdout: '中文输出', stderr: '' })
  assert.deepEqual(parseEnvelope(envelope(3, '', 'boom-console')), { exitCode: 3, stdout: '', stderr: 'boom-console' })
  assert.deepEqual(parseEnvelope(envelope(1, 'o1\r\n', 'e1')), { exitCode: 1, stdout: 'o1\r\n', stderr: 'e1' })
})

test('envelope parsing survives a transport that trims each chunk', () => {
  // WinRS trims every response chunk, so the newlines between the three lines
  // can vanish entirely. The `O:`/`E:` labels are the real delimiters.
  assert.deepEqual(parseEnvelope(envelope(0, 'hi', 'x').replace(/\r\n/g, '')), { exitCode: 0, stdout: 'hi', stderr: 'x' })
  assert.deepEqual(parseEnvelope('__DSH_WINRM__0'), { exitCode: 0, stdout: '', stderr: '' })
  assert.deepEqual(parseEnvelope('__DSH_WINRM__-1\n'), { exitCode: -1, stdout: '', stderr: '' })
  // Trailing whitespace is transport noise, not payload.
  assert.deepEqual(parseEnvelope(envelope(0, 'ok', '') + '\r\n'), { exitCode: 0, stdout: 'ok', stderr: '' })
  assert.equal(parseEnvelope('not an envelope'), null)
})

test('PowerShell literals and encoded commands are quote-safe', () => {
  assert.equal(sq("a'b"), "'a''b'")
  const script = "Write-Output '中文'"
  const encoded = encodeCommand(script)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
  // UTF-16LE → base64 inflates by 8/3, which is exactly why the script cannot
  // ride the command line: WinRS hands it to cmd.exe, capped at ~8191 chars.
  assert.ok(encoded.length > script.length)
})

test('service and transfer snippets quote user-controlled paths and names', () => {
  assert.match(psServiceAction("svc'name", 'restart'), /svc''name/)
  assert.match(psReadChunk("C:\\a'b.bin", 48, 96), /a''b\.bin/)
  assert.match(psWriteChunk("C:\\a'b.bin", 'YQ==', false), /FileMode\]::Create/)
})

test('stdin payload counts UTF-8 bytes, not characters', () => {
  // The outer script sizes its receive buffer from this count, so a character
  // count would truncate a multi-byte script mid-character.
  assert.equal(scriptPayload('中文'), '6\n中文')
  assert.equal(scriptPayload("Write-Output 'ok'"), "17\nWrite-Output 'ok'")
  assert.equal(scriptPayload(''), '0\n')
})

test('payload splitting keeps every piece sendable and reassembles losslessly', () => {
  const payload = scriptPayload('# ' + 'x'.repeat(50_000) + '中文𝄞' + 'y'.repeat(500) + '\nWrite-Output ok')
  const pieces = splitScriptPayload(payload)
  assert.ok(pieces.length > 1)
  assert.equal(pieces.join(''), payload)
  for (const piece of pieces) {
    assert.ok(piece.length > 0, 'no empty Send')
    assert.ok(piece.length <= STDIN_CHUNK_CHARS, 'piece exceeds the Send size')
    // A piece must not end on a lone high surrogate: doSendInput encodes each
    // piece independently, so a split pair would become U+FFFD.
    const last = piece.charCodeAt(piece.length - 1)
    assert.ok(last < 0xd800 || last > 0xdbff, 'piece ends mid-surrogate-pair')
  }
  // An empty payload still needs one Send, or the outer script never sees a count.
  assert.deepEqual(splitScriptPayload('0\n'), ['0\n'])
})

test('the command line stays constant, ASCII, and under cmd.exe cap', () => {
  const line = powershellCommandLine()
  assert.equal(line, powershellCommandLine())
  assert.match(line, /^powershell\.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/)
  assert.ok(line.length < 8191, `command line is ${line.length} chars, over the ~8191 cap`)
  // The child is started with -EncodedCommand, which the execution policy does
  // not govern, so a locked-down policy cannot lose the envelope.
  const decoded = Buffer.from(line.slice(line.indexOf(' -EncodedCommand ') + ' -EncodedCommand '.length), 'base64').toString('utf16le')
  assert.match(decoded, /-ExecutionPolicy Bypass -EncodedCommand/)
  assert.match(decoded, /Out-String -Stream/)
})

test('CLIXML host records are stripped without dropping real stderr', () => {
  // Shapes captured from a live WinRS stderr stream: PowerShell writes a
  // `#< CLIXML` header line once, and serializes its own progress/verbose
  // records into `<Objs>` blocks.
  const header = '#< CLIXML\r\n'
  const records = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    + '<Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>'
  // A normal command leaves the header and the host records and nothing else.
  assert.equal(stripClixml(header + records), '')
  assert.equal(stripClixml(header + records + '\r\n'), '')
  assert.equal(stripClixml(''), '')
  // Genuine process-level stderr sits BETWEEN the header and a record block
  // and must survive; it is output, not part of the CLIXML payload.
  assert.equal(stripClixml(header + 'boom-console\r\n' + records), 'boom-console')
  assert.equal(stripClixml('plain stderr'), 'plain stderr')
})

test('stream frames carry magic, length, mode and the payload verbatim', () => {
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef])
  const frame = buildStreamFrame(payload, STREAM_FRAME_GZIP)
  assert.equal(frame.length, STREAM_FRAME_HEADER_BYTES + payload.length)
  assert.equal(frame.subarray(0, 4).toString('ascii'), STREAM_FRAME_MAGIC)
  // Little-endian length: the receiver rebuilds it with `-shl (8 * $j)`.
  assert.equal(frame.readUInt32LE(4), payload.length)
  assert.equal(frame[8], STREAM_FRAME_GZIP)
  assert.deepEqual(frame.subarray(STREAM_FRAME_HEADER_BYTES), payload)
  // A frame of nothing is still a frame: the receiver uses it to size reads.
  assert.equal(buildStreamFrame(Buffer.alloc(0), STREAM_FRAME_RAW).length, STREAM_FRAME_HEADER_BYTES)
  // The length field is what keeps a gzip member from bleeding into the next
  // one, so it must survive payloads larger than one byte of length.
  assert.equal(buildStreamFrame(Buffer.alloc(70_000), STREAM_FRAME_RAW).readUInt32LE(4), 70_000)
})

test('the streaming receiver takes no arguments and stays path-independent', () => {
  // The path and byte count arrive as the first stdin frame. Interpolating
  // them into the script would push the command line toward cmd.exe's ~8191
  // cap (base64-of-UTF-16 costs 2.67x per character), so the script must be a
  // constant that mentions no destination at all.
  const script = psReceiveStream()
  assert.equal(script, psReceiveStream())
  assert.ok(!script.includes('C:\\'), 'receiver must not embed a path')
  assert.match(script, /OpenStandardInput/)
  // It reads a header frame first, then framed data, and reports the count.
  assert.match(script, /upload stream ended before its header/)
  assert.match(script, /upload stream lost frame alignment/)
  assert.match(script, /upload stream started without a header frame/)
  assert.match(script, /GZipStream/)
  assert.match(script, /FileMode\]::Create/)
  // Same envelope contract as every other snippet, so runScript can parse it.
  assert.ok(script.includes(sq(ENVELOPE_MARKER)))
  assert.match(script, /'O:' \+ \[System\.Convert\]::ToBase64String/)
})

test('the stream command line is a constant bootstrap under the cmd.exe cap', () => {
  const line = streamCommandLine()
  assert.equal(line, streamCommandLine())
  assert.match(line, /^powershell\.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/)
  assert.ok(line.length < 8191, `stream command line is ${line.length} chars, over the ~8191 cap`)
  // The receiver script is far too big to ride the command line; it is read
  // from stdin instead. This is why the two lines differ.
  assert.notEqual(line, powershellCommandLine())
  const decoded = Buffer.from(line.slice(line.indexOf(' -EncodedCommand ') + ' -EncodedCommand '.length), 'base64').toString('utf16le')
  // The bootstrap reads "<byteCount>\n<script>" from stdin, then runs the
  // script in-process so it can keep draining the same stream.
  assert.match(decoded, /OpenStandardInput/)
  assert.match(decoded, /scriptblock\]::Create/)
  assert.match(decoded, /exit \$c/)
  // It must NOT start a child process: a child would inherit its own stdin and
  // the data frames that follow would be lost.
  assert.ok(!decoded.includes('ProcessStartInfo'), 'bootstrap must not spawn a child')
})

test('the streaming sender reads an absolute byte range and compresses it', () => {
  const script = psSendStream('C:\\temp\\a.bin', 1_048_576, 262_144)
  // Positional range, so several shells can serve one file concurrently and
  // the client can place each piece by offset regardless of arrival order.
  assert.match(script, /\$__fs\.Position = \[long\]1048576/)
  assert.match(script, /\$__left = \[long\]262144/)
  assert.match(script, /OpenRead\('C:\\temp\\a\.bin'\)/)
  assert.match(script, /CompressionMode\]::Compress/)
  // Leave-open, or closing the gzip stream would close the shell's stdout and
  // truncate the response the client is still reading.
  assert.match(script, /Compress, \$true/)
  // Nothing may go to the success stream: it carries the payload, and any
  // status line would be spliced into the file.
  assert.ok(!script.includes('Write-Output'), 'sender must not write to stdout')
  assert.ok(!script.includes('Write-Host'), 'sender must not write to stdout')
  assert.match(script, /\[Console\]::Error\.WriteLine\('__DSH_DL__ OK '/)
  assert.match(script, /throw/)
})

test('the sender escapes quotes in the remote path', () => {
  // A single quote in the path would otherwise close the PowerShell literal and
  // turn the rest of the path into code.
  assert.match(psSendStream("C:\\it's\\a.bin", 0, 1), /OpenRead\('C:\\it''s\\a\.bin'\)/)
})

test('scriptCommandLine wraps any script and stays inside the cmd.exe cap', () => {
  const line = scriptCommandLine('Write-Output ok')
  assert.match(line, /^powershell\.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/)
  const decoded = Buffer.from(line.slice(line.indexOf(' -EncodedCommand ') + ' -EncodedCommand '.length), 'base64').toString('utf16le')
  assert.equal(decoded, 'Write-Output ok')
  // The sender is small enough to ride the command line, unlike the receiver.
  const sender = scriptCommandLine(psSendStream('C:\\temp\\a.bin', 0, 262_144))
  assert.ok(sender.length < 8191, `sender command line is ${sender.length} chars, over the ~8191 cap`)
})

test('the size probe distinguishes an absent path from an empty file', () => {
  const script = psFileSize("C:\\a'b.bin")
  // A missing path and a directory must both emit nothing: printing "0" for
  // them made a download of a nonexistent file look like a successful copy of a
  // zero-byte one, and left an empty local file behind as proof.
  assert.match(script, /Get-Item -LiteralPath 'C:\\a''b\.bin' -ErrorAction SilentlyContinue/)
  assert.match(script, /if \(\$null -ne \$__f -and -not \$__f\.PSIsContainer\) \{ \[string\]\$__f\.Length \}/)
  assert.doesNotMatch(script, /"\s*0\s*"/)
})

test('the text reader is bounded, encoding-aware, and quote-safe', () => {
  const script = psReadTextWindow("C:\\it's\\app.log", 5, 100, 2_000, 524_288)
  // Path goes through the single-quote escaper, or it would close the literal.
  assert.match(script, /\$__p = 'C:\\it''s\\app\.log'/)
  assert.match(script, /Get-Item -LiteralPath \$__p -ErrorAction SilentlyContinue/)
  // Paging bounds are numeric literals, never quoted strings: `-lt '5'` would
  // compare a number to a string and silently select the wrong window.
  assert.match(script, /if \(\$__total -lt 5\) \{ continue \}/)
  assert.match(script, /if \(\$__sel\.Count -ge 100\) \{ \$__cut = \$true; continue \}/)
  assert.match(script, /\$__t\.Length -gt 2001\) \{ \$__t = \$__t\.Substring\(0, 2001\) \}/)
  assert.match(script, /\$__used \+ \$__b -gt 524288/)
  // BOM detection drives both the reported encoding and the decoder.
  assert.match(script, /\$__b0\[0\] -eq 255 -and \$__b0\[1\] -eq 254/)
  assert.match(script, /\$__b0\[0\] -eq 254 -and \$__b0\[1\] -eq 255/)
  assert.match(script, /\$__b0\[0\] -eq 239 -and \$__b0\[1\] -eq 187 -and \$__b0\[2\] -eq 191/)
  // Invalid UTF-8 must throw rather than decode to U+FFFD: a binary file has to
  // fail loudly instead of arriving as plausible-looking text.
  assert.match(script, /New-Object System\.Text\.UTF8Encoding\(\$false, \$true\)/)
  // Both outcomes are JSON so the Node half never has to parse an error record.
  assert.match(script, /exists = \$false/)
  assert.match(script, /exists = \$true/)
  assert.match(script, /\[pscustomobject\]@\{ error = \$__err \} \| ConvertTo-Json -Compress/)
  // The caller's path must appear only in the escaped literal.
  assert.equal(script.split("C:\\it''s\\app.log").length - 1, 1)
})

test('the text editor searches ordinally and refuses an ambiguous needle', () => {
  const oldB64 = Buffer.from('a.b', 'utf8').toString('base64')
  const newB64 = Buffer.from('a.c', 'utf8').toString('base64')

  const once = psEditText("C:\\it's\\app.config", oldB64, newB64, false)
  // Both payloads ride base64 through the single-quote escaper, so a needle
  // containing quotes, newlines or `$` cannot become PowerShell code.
  assert.match(once, new RegExp(`FromBase64String\\('${oldB64}'\\)`))
  assert.match(once, new RegExp(`FromBase64String\\('${newB64}'\\)`))
  assert.match(once, /Get-Item -LiteralPath \$__p -ErrorAction SilentlyContinue/)
  // Ordinal, not regex: `.` in a needle must stay a literal dot.
  assert.match(once, /IndexOf\(\$__old, \[System\.StringComparison\]::Ordinal\)/)
  assert.doesNotMatch(once, /-replace|-match|-cmatch/)
  // A second hit is an error, which is what stops a stale needle from
  // rewriting the wrong region.
  assert.match(once, /oldString appears more than once in /)
  // The bulk body must not ship at all: a message that can never fire reads
  // like a live rule to anyone auditing the wire.
  assert.doesNotMatch(once, /Replace\(\$__old, \$__new\)/)

  const all = psEditText('C:\\a.txt', oldB64, newB64, true)
  assert.match(all, /Replace\(\$__old, \$__new\)/)
  assert.doesNotMatch(all, /oldString appears more than once/)
  assert.doesNotMatch(all, /StringComparison\]::Ordinal/)
  // Every branch rewrites through the encoding the file already had, so a
  // UTF-16 file does not silently become UTF-8 after one edit.
  assert.match(all, /New-Object System\.Text\.UTF8Encoding\(\$true\)/)
  assert.match(all, /\[System\.Text\.Encoding\]::Unicode\)/)
  assert.match(all, /\[System\.Text\.Encoding\]::BigEndianUnicode\)/)
  assert.match(all, /New-Object System\.Text\.UTF8Encoding\(\$false\)/)
})
