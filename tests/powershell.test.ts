import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeCommand, parseEnvelope, psReadChunk, psServiceAction, psWriteChunk, sq, stripClixml, wrapEnvelope } from '../src/powershell.ts'

test('PowerShell literals and envelopes preserve Unicode safely', () => {
  assert.equal(sq("a'b"), "'a''b'")
  const script = wrapEnvelope("Write-Output '中文'")
  assert.match(script, /ToBase64String/)
  assert.ok(encodeCommand(script).length > script.length)
  const payload = Buffer.from('中文输出', 'utf8').toString('base64')
  assert.deepEqual(parseEnvelope(`__DSH_WINRM__0\n${payload}`), { exitCode: 0, text: '中文输出' })
})

test('service and transfer snippets quote user-controlled paths and names', () => {
  assert.match(psServiceAction("svc'name", 'restart'), /svc''name/)
  assert.match(psReadChunk("C:\\a'b.bin", 48, 96), /a''b\.bin/)
  assert.match(psWriteChunk("C:\\a'b.bin", 'YQ==', false), /FileMode\]::Create/)
})

test('envelope parsing tolerates an empty body, a trimmed newline, and a negative code', () => {
  // A command that printed nothing emits the marker alone; a transport that
  // trims each response may also drop the separating newline.
  assert.deepEqual(parseEnvelope('__DSH_WINRM__0'), { exitCode: 0, text: '' })
  assert.deepEqual(parseEnvelope('__DSH_WINRM__0\r\n'), { exitCode: 0, text: '' })
  assert.deepEqual(parseEnvelope('__DSH_WINRM__-1\n'), { exitCode: -1, text: '' })
  assert.deepEqual(parseEnvelope('not an envelope'), null)
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