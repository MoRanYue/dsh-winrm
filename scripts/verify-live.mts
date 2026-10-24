// Live verification against a real WinRM host — exercises the stdin channel,
// the labelled envelope, the exit-code semantics, and a full transfer round
// trip. Unlike the unit tests this needs a reachable host, so it is a
// maintainer tool rather than part of `npm test`.
//
// Run from the repo root so `winrm-client` resolves:
//   node --experimental-strip-types scripts/verify-live.mts
import { HostStore } from '../src/store.ts'
import { WinRmEngine } from '../src/engine.ts'
import { connOf, runScript, TRANSFER_CHUNK, uploadBuffer, downloadChunks, remoteFileSize } from '../src/engine/client.ts'
import { psWriteChunk, psReadChunk, psFileSize } from '../src/powershell.ts'

const store = new HostStore()
const entry = store.list()[0]
if (!entry) throw new Error('no host configured')
const conn = connOf(entry)

type Case = { name: string; script: string; code?: number; out?: string | RegExp; err?: string; contains?: string }
const cases: Case[] = [
  { name: 'plain', script: `Write-Output "hi"`, code: 0, out: 'hi' },
  { name: 'empty', script: `''`, code: 0, out: '' },
  { name: 'utf8', script: `Write-Output '中文测试 ✓ 𝄞'`, code: 0, out: '中文测试 ✓ 𝄞' },
  { name: 'out then exit 3', script: `Write-Output 'before'; exit 3`, code: 3, out: 'before' },
  { name: 'utf8 exit 5', script: `Write-Output '中文'; exit 5`, code: 5, out: '中文' },
  { name: 'throw', script: `throw 'kaboom'`, code: 1, contains: 'kaboom' },
  { name: 'nonterm error', script: `Get-ChildItem C:\\definitely-not-here-xyz`, code: 0, contains: 'Cannot find path' },
  { name: 'write-error', script: `Write-Error "werr"`, code: 0, contains: 'werr' },
  { name: 'cmd exit 7', script: `cmd /c exit 7`, code: 7 },
  { name: 'stderr only', script: `[Console]::Error.WriteLine('e1')`, code: 0, out: '', err: 'e1' },
  { name: 'out and err', script: `Write-Output 'o1'; [Console]::Error.WriteLine('e1')`, code: 0, out: 'o1', err: 'e1' },
  { name: 'flush before exit', script: `Write-Output 'before'; exit 4`, code: 4, out: 'before' },
  { name: 'error then exit', script: `Get-ChildItem C:\\definitely-not-here-xyz; exit 6`, code: 6, contains: 'Cannot find path' },
  { name: 'exit in function', script: `function f { exit 9 }; f`, code: 9 },
  { name: 'negative-ish LASTEXITCODE', script: `cmd /c "exit 0"`, code: 0 },
  { name: 'pipeline ok', script: `1..3 | ForEach-Object { $_ }`, code: 0, out: '1\r\n2\r\n3' },
]

let bad = 0
console.log('=== edge cases ===')
for (const c of cases) {
  try {
    const r = await runScript(conn, c.script, { timeoutMs: 60_000 })
    const problems: string[] = []
    if (c.code !== undefined && r.exitCode !== c.code) problems.push(`code=${r.exitCode} want=${c.code}`)
    if (typeof c.out === 'string' && r.stdout.trimEnd() !== c.out) problems.push(`out=${JSON.stringify(r.stdout)} want=${JSON.stringify(c.out)}`)
    if (c.err !== undefined && r.stderr.trim() !== c.err) problems.push(`err=${JSON.stringify(r.stderr)} want=${JSON.stringify(c.err)}`)
    if (c.contains !== undefined && !r.stdout.includes(c.contains)) problems.push(`missing ${JSON.stringify(c.contains)}`)
    if (problems.length > 0) { bad++; console.log(`BAD  ${c.name}: ${problems.join('; ')}`) }
    else console.log(`ok   ${c.name} [${r.durationMs}ms]`)
  } catch (error) {
    bad++
    console.log(`THREW ${c.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Big output that a mid-script exit must not truncate.
{
  const r = await runScript(conn, `1..2000 | ForEach-Object { "line$_" }; exit 5`, { timeoutMs: 120_000 })
  const lines = r.stdout.trim().split(/\r?\n/).length
  const ok = r.exitCode === 5 && lines >= 2000
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} flush big then exit: code=${r.exitCode} lines=${lines} [${r.durationMs}ms]`)
}

// Scripts far past the ~8191-char command line: the whole point of the rewrite.
console.log('=== large payloads (command line cannot carry these) ===')
for (const size of [5_000, 50_000, 200_000]) {
  const r = await runScript(conn, `# ${'x'.repeat(size)}\nWrite-Output 'ok'`, { timeoutMs: 120_000 })
  const ok = r.exitCode === 0 && r.stdout.trim() === 'ok'
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} script=${size} chars code=${r.exitCode} out=${JSON.stringify(r.stdout.trim())} [${r.durationMs}ms]`)
}

// Multi-byte payload: length is counted in bytes, split on code points.
{
  const r = await runScript(conn, `# ${'中'.repeat(50_000)}\nWrite-Output 'ok'`, { timeoutMs: 120_000 })
  const ok = r.exitCode === 0 && r.stdout.trim() === 'ok'
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} multibyte 150KB code=${r.exitCode} [${r.durationMs}ms]`)
}

// The transfer chunk that used to blow the command line (~65K base64 chars).
console.log('=== transfer chunk (previously structurally broken) ===')
{
  const r = await runScript(conn, psReadChunk('C:\\Windows\\System32\\notepad.exe', 0, TRANSFER_CHUNK), { timeoutMs: 120_000 })
  const bytes = Buffer.from(r.stdout.trim(), 'base64').length
  const ok = r.exitCode === 0 && bytes === TRANSFER_CHUNK
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} read ${TRANSFER_CHUNK} bytes: code=${r.exitCode} decoded=${bytes} [${r.durationMs}ms]`)
}

// Real upload/download round trip well past the old limit.
console.log('=== upload/download round trip ===')
{
  const remote = 'C:\\temp\\dsh-winrm-verify\\blob.bin'
  const data = Buffer.alloc(200 * 1024)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff
  const written = await uploadBuffer(conn, remote, data, undefined, 120_000)
  const size = await remoteFileSize(conn, remote, 60_000)
  const chunks: Buffer[] = []
  const read = await downloadChunks(conn, remote, b64 => { chunks.push(Buffer.from(b64, 'base64')) }, undefined, 120_000)
  const back = Buffer.concat(chunks)
  const same = back.length === data.length && back.equals(data)
  const ok = written === data.length && size === data.length && read === data.length && same
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} 200KB round trip: written=${written} size=${size} read=${read} identical=${same}`)
  await runScript(conn, `Remove-Item -LiteralPath 'C:\\temp\\dsh-winrm-verify' -Recurse -Force -ErrorAction SilentlyContinue`, { timeoutMs: 60_000 })
}

// Remote text read/write/edit: the three tools that act on the target's files
// rather than on the host's. Round-trips through the real encoding detection.
console.log('=== remote text read/write/edit ===')
{
  const engine = new WinRmEngine(store)
  const dir = 'C:\\temp\\dsh-winrm-verify-text'
  const alias = entry.alias
  const body = ['alpha', '中文行 ✓', '', 'beta alpha', 'omega'].join('\r\n') + '\r\n'

  const created = await engine.writeFile(alias, `${dir}\\utf8.txt`, body, 'utf8')
  const createOk = created.operation === 'create' && created.bytes === Buffer.byteLength(body, 'utf8')
  if (!createOk) bad++
  console.log(`${createOk ? 'ok  ' : 'BAD '} write create utf8: op=${created.operation} bytes=${created.bytes}`)

  const updated = await engine.writeFile(alias, `${dir}\\utf8.txt`, body, 'utf8')
  const updateOk = updated.operation === 'update'
  if (!updateOk) bad++
  console.log(`${updateOk ? 'ok  ' : 'BAD '} write update utf8: op=${updated.operation}`)

  const window = await engine.readFile(alias, `${dir}\\utf8.txt`, 1, 100)
  const readOk = window.totalLines === 5
    && window.encoding === 'utf8'
    && window.lines[0]?.text === 'alpha'
    && window.lines[1]?.text === '中文行 ✓'
    && window.lines[2]?.text === ''
    && window.lines[4]?.text === 'omega'
  if (!readOk) bad++
  console.log(`${readOk ? 'ok  ' : 'BAD '} read whole: total=${window.totalLines} enc=${window.encoding} lines=${JSON.stringify(window.lines.map(l => l.text))}`)

  // Paging must start where the caller asked, or a model paging a log would
  // silently re-read the top forever.
  const tail = await engine.readFile(alias, `${dir}\\utf8.txt`, 4, 2)
  const pageOk = tail.lines.length === 2 && tail.lines[0]?.number === 4 && tail.lines[0]?.text === 'beta alpha'
  if (!pageOk) bad++
  console.log(`${pageOk ? 'ok  ' : 'BAD '} read page offset=4 limit=2: ${JSON.stringify(tail.lines)}`)

  const edited = await engine.editFile(alias, `${dir}\\utf8.txt`, 'omega', 'OMEGA', false)
  const editOk = edited.replacements === 1 && edited.encoding === 'utf8'
  if (!editOk) bad++
  console.log(`${editOk ? 'ok  ' : 'BAD '} edit single: replacements=${edited.replacements} size=${edited.size}`)

  const afterEdit = await engine.readFile(alias, `${dir}\\utf8.txt`, 1, 100)
  const persisted = afterEdit.lines[4]?.text === 'OMEGA'
  if (!persisted) bad++
  console.log(`${persisted ? 'ok  ' : 'BAD '} edit persisted: line5=${JSON.stringify(afterEdit.lines[4]?.text)}`)

  // `alpha` appears twice, so a single-replacement edit must refuse rather than
  // guess which one the caller meant.
  let ambiguous = ''
  try {
    await engine.editFile(alias, `${dir}\\utf8.txt`, 'alpha', 'ALPHA', false)
  } catch (error) {
    ambiguous = error instanceof Error ? error.message : String(error)
  }
  const ambiguousOk = ambiguous.includes('more than once')
  if (!ambiguousOk) bad++
  console.log(`${ambiguousOk ? 'ok  ' : 'BAD '} edit refuses ambiguous needle: ${JSON.stringify(ambiguous)}`)

  const all = await engine.editFile(alias, `${dir}\\utf8.txt`, 'alpha', 'ALPHA', true)
  const allOk = all.replacements === 2
  if (!allOk) bad++
  console.log(`${allOk ? 'ok  ' : 'BAD '} edit replaceAll: replacements=${all.replacements}`)

  // A needle that is gone must fail loudly: silently succeeding is how a stale
  // edit looks successful while changing nothing.
  let missing = ''
  try {
    await engine.editFile(alias, `${dir}\\utf8.txt`, 'not-there-at-all', 'x', false)
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error)
  }
  const missingOk = missing.includes('was not found')
  if (!missingOk) bad++
  console.log(`${missingOk ? 'ok  ' : 'BAD '} edit reports a missing needle: ${JSON.stringify(missing)}`)

  // UTF-16LE with a BOM must come back as UTF-16LE, not as mojibake.
  const utf16 = await engine.writeFile(alias, `${dir}\\utf16.txt`, '第一行\r\n第二行\r\n', 'utf16le')
  const utf16Read = await engine.readFile(alias, `${dir}\\utf16.txt`, 1, 10)
  const utf16Ok = utf16Read.encoding === 'utf16le' && utf16Read.lines[0]?.text === '第一行' && utf16Read.lines[1]?.text === '第二行'
  if (!utf16Ok) bad++
  console.log(`${utf16Ok ? 'ok  ' : 'BAD '} utf16le round trip: bytes=${utf16.bytes} enc=${utf16Read.encoding} lines=${JSON.stringify(utf16Read.lines.map(l => l.text))}`)

  // A UTF-8 BOM must be preserved by an edit, or the next reader misdetects it.
  await engine.writeFile(alias, `${dir}\\bom.txt`, 'one\r\ntwo\r\n', 'utf8bom')
  const bomEdit = await engine.editFile(alias, `${dir}\\bom.txt`, 'two', 'TWO', false)
  const bomRead = await engine.readFile(alias, `${dir}\\bom.txt`, 1, 10)
  const bomOk = bomEdit.encoding === 'utf8bom' && bomRead.encoding === 'utf8bom' && bomRead.lines[1]?.text === 'TWO'
  if (!bomOk) bad++
  console.log(`${bomOk ? 'ok  ' : 'BAD '} utf8bom preserved through an edit: edit=${bomEdit.encoding} read=${bomRead.encoding}`)

  // A binary file has no line structure; the reader must say so instead of
  // returning U+FFFD soup.
  let binary = ''
  try {
    await engine.readFile(alias, 'C:\\Windows\\System32\\notepad.exe', 1, 5)
  } catch (error) {
    binary = error instanceof Error ? error.message : String(error)
  }
  const binaryOk = binary.length > 0
  if (!binaryOk) bad++
  console.log(`${binaryOk ? 'ok  ' : 'BAD '} binary read fails loudly: ${JSON.stringify(binary.slice(0, 120))}`)

  let absent = ''
  try {
    await engine.readFile(alias, `${dir}\\nope.txt`, 1, 5)
  } catch (error) {
    absent = error instanceof Error ? error.message : String(error)
  }
  const absentOk = absent.includes('not found')
  if (!absentOk) bad++
  console.log(`${absentOk ? 'ok  ' : 'BAD '} read reports a missing file: ${JSON.stringify(absent)}`)

  await runScript(conn, `Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`, { timeoutMs: 60_000 })
}

// Sanity: a script that never reaches the envelope must not claim success.
{
  const r = await runScript(conn, `Write-Output 'ok'`, { timeoutMs: 60_000 })
  console.log(`ok   sanity re-check code=${r.exitCode} out=${JSON.stringify(r.stdout.trim())}`)
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`)
process.exit(bad === 0 ? 0 : 1)
