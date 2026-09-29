import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENVELOPE_MARKER,
  STDIN_CHUNK_CHARS,
  encodeCommand,
  parseEnvelope,
  powershellCommandLine,
  psReadChunk,
  psServiceAction,
  psWriteChunk,
  scriptPayload,
  splitScriptPayload,
  sq,
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
