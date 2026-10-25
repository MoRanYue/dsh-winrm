/**
 * Guard: every tool's declared output schema must accept the values its
 * execute() actually returns. The harness validates output against these
 * schemas with `additionalProperties: false`, so a field emitted by the engine
 * but absent from the schema fails the whole call at runtime
 * (`tool "winrm_list" returned invalid output`). These tests drive the real
 * tools against a stubbed engine, so an engine field added later without its
 * schema entry fails here instead of in production.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  winrmClusterTool,
  winrmDownloadTool,
  winrmEditTool,
  winrmExecTool,
  winrmListTool,
  winrmProcessTool,
  winrmReadTool,
  winrmServiceTool,
  winrmUploadTool,
  winrmWriteTool,
} from '../src/tools.ts'

/**
 * Fail unless `value` satisfies the tool's own declared output schema.
 * `defineTool` already compiled the authored spec, so `output.schema` is the
 * raw enforced schema the runtime validates against.
 */
function assertValidOutput(tool: { output: { schema: unknown } }, value: unknown): void {
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema as never, value, 'value'), [])
}

/** A host summary carrying every optional field the store can emit. */
const FULL_SUMMARY = {
  alias: 'og.caughtwind.top',
  host: 'og.caughtwind.top',
  port: 5986,
  user: 'Administrator',
  auth: 'password',
  transport: 'https',
  rejectUnauthorized: false,
  description: 'prod box',
  environment: 'production',
  tags: ['prod', 'cn'],
  location: 'rack 3',
  createdAt: 1,
  updatedAt: 2,
}

/** A host summary carrying none of the optional fields. */
const MINIMAL_SUMMARY = {
  alias: 'min',
  host: '10.0.0.1',
  port: 5985,
  user: 'Administrator',
  auth: 'password',
  transport: 'http',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

/** Minimal engine stub; each test overrides only what it exercises. */
function stubEngine(overrides: Record<string, unknown>): never {
  return overrides as never
}

test('winrm_list output schema accepts host summaries with and without optional fields', async () => {
  const tool = winrmListTool(stubEngine({ list: () => [FULL_SUMMARY, MINIMAL_SUMMARY] }))
  assertValidOutput(tool, await tool.execute({}))
})

test('winrm_list output schema accepts rejectUnauthorized explicitly', async () => {
  // Regression: rejectUnauthorized is emitted by HostStore.summarize() whenever
  // the stored entry sets it, and was missing from the declared schema.
  const tool = winrmListTool(stubEngine({ list: () => [{ ...MINIMAL_SUMMARY, rejectUnauthorized: true }] }))
  const value = await tool.execute({})
  assert.equal(value.hosts[0]?.rejectUnauthorized, true)
  assertValidOutput(tool, value)
})

test('winrm_exec output schema accepts success and failure values', async () => {
  const tool = winrmExecTool(stubEngine({
    exec: async () => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: 'ok',
      stderr: '',
      durationMs: 12,
    }),
  }))
  assertValidOutput(tool, await tool.execute({ alias: 'a', command: 'b' }))

  const failed = winrmExecTool(stubEngine({
    exec: async () => ({
      success: false,
      exitCode: null,
      timedOut: true,
      stdout: '',
      stderr: '',
      durationMs: 12,
      error: 'timed out',
    }),
  }))
  assertValidOutput(failed, await failed.execute({ alias: 'a', command: 'b' }))
})

test('winrm_service output schema accepts list, action, and error values', async () => {
  const listed = winrmServiceTool(stubEngine({
    listServices: async () => [
      { name: 'spooler', displayName: 'Print Spooler', status: 'Running', startMode: 'Auto', startName: 'LocalSystem' },
      { name: 'bare', displayName: 'Bare', status: 'Stopped', startMode: 'Manual' },
    ],
  }))
  assertValidOutput(listed, await listed.execute({ alias: 'a' }))

  const acted = winrmServiceTool(stubEngine({
    serviceAction: async () => ({ name: 'spooler', displayName: 'Print Spooler', status: 'Stopped', startMode: 'Manual' }),
  }))
  assertValidOutput(acted, await acted.execute({ alias: 'a', name: 'spooler', action: 'stop' }))

  const errored = winrmServiceTool(stubEngine({
    listServices: async () => { throw new Error('unreachable') },
  }))
  assertValidOutput(errored, await errored.execute({ alias: 'a' }))
})

test('winrm_process output schema accepts list, kill, and error values', async () => {
  const listed = winrmProcessTool(stubEngine({
    listProcesses: async () => [
      { id: 4, name: 'System', cpu: 1.5, memMB: 12.25, startTime: '2026-01-01T00:00:00Z', path: 'C:\\x.exe' },
      { id: 8, name: 'bare' },
    ],
  }))
  assertValidOutput(listed, await listed.execute({ alias: 'a' }))

  const killed = winrmProcessTool(stubEngine({ killProcess: async () => undefined }))
  assertValidOutput(killed, await killed.execute({ alias: 'a', action: 'kill', id: 999999 }))

  const errored = winrmProcessTool(stubEngine({
    killProcess: async () => { throw new Error('failed to kill process') },
  }))
  assertValidOutput(errored, await errored.execute({ alias: 'a', action: 'kill', id: 999999 }))
})

test('winrm_upload and winrm_download output schemas accept both channels and errors', async () => {
  for (const channel of ['smb', 'winrm'] as const) {
    const up = winrmUploadTool(stubEngine({ upload: async () => ({ bytes: 444, channel }) }))
    assertValidOutput(up, await up.execute({ alias: 'a', localPath: 'l', remotePath: 'r' }))

    const down = winrmDownloadTool(stubEngine({ download: async () => ({ bytes: 444, channel }) }))
    assertValidOutput(down, await down.execute({ alias: 'a', remotePath: 'r', localPath: 'l' }))
  }

  const upFailed = winrmUploadTool(stubEngine({ upload: async () => { throw new Error('no route') } }))
  assertValidOutput(upFailed, await upFailed.execute({ alias: 'a', localPath: 'l', remotePath: 'r' }))

  const downFailed = winrmDownloadTool(stubEngine({ download: async () => { throw new Error('no route') } }))
  assertValidOutput(downFailed, await downFailed.execute({ alias: 'a', remotePath: 'r', localPath: 'l' }))
})

test('winrm_cluster output schema accepts full and sparse results', async () => {
  const tool = winrmClusterTool(stubEngine({
    cluster: async () => [
      { alias: 'a', ok: true, exitCode: 0, timedOut: false, stdout: 'x', stderr: '', durationMs: 5 },
      { alias: 'b', ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '', durationMs: 5, error: 'timed out' },
      { alias: 'c', ok: false },
    ],
  }))
  assertValidOutput(tool, await tool.execute({ command: 'hostname' }))
})

test('winrm_read output schema accepts a window, an empty file, and errors', async () => {
  const window = winrmReadTool(stubEngine({
    readFile: async () => ({
      path: 'C:\\temp\\app.log',
      offset: 1,
      lines: [{ number: 1, text: 'first' }, { number: 2, text: '' }],
      totalLines: 2,
      encoding: 'utf8bom',
      truncatedByBytes: false,
    }),
  }))
  const value = await window.execute({ alias: 'a', remotePath: 'C:\\temp\\app.log' })
  assertValidOutput(window, value)
  // The rendered text must stay in the numbered envelope the local read tool
  // uses, or a model reading both tools gets two different shapes.
  const rendered = window.output.render?.({}, value) ?? []
  const body = rendered.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(body, /<path>C:\\temp\\app\.log<\/path>/)
  assert.match(body, /<type>file<\/type>/)
  assert.match(body, /1: first/)
  assert.match(body, /2: $/m)
  assert.match(body, /\(End of file - total 2 lines, encoding utf8bom\)/)

  const empty = winrmReadTool(stubEngine({
    readFile: async () => ({ path: 'C:\\e.txt', offset: 1, lines: [], totalLines: 0, encoding: 'utf8', truncatedByBytes: false }),
  }))
  const emptyValue = await empty.execute({ alias: 'a', remotePath: 'C:\\e.txt' })
  assertValidOutput(empty, emptyValue)
  const emptyBody = (empty.output.render?.({}, emptyValue) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  // Plain UTF-8 gets no encoding suffix, so this exact footer also pins that.
  assert.match(emptyBody, /\(End of file - total 0 lines\)/)

  // A byte-budget stop is not the end of the file; the footer must say so or
  // the model stops paging early.
  const cut = winrmReadTool(stubEngine({
    readFile: async () => ({ path: 'C:\\big.log', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 9_000, encoding: 'utf8', truncatedByBytes: true }),
  }))
  const cutValue = await cut.execute({ alias: 'a', remotePath: 'C:\\big.log' })
  assertValidOutput(cut, cutValue)
  const cutBody = (cut.output.render?.({}, cutValue) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(cutBody, /byte budget — continue with offset=2/)

  // Hitting the requested line count is not a byte-budget stop, and the footer
  // must not claim one: the caller asked for this many lines.
  const paged = winrmReadTool(stubEngine({
    readFile: async () => ({ path: 'C:\\b.log', offset: 3, lines: [{ number: 3, text: 'a' }, { number: 4, text: 'b' }], totalLines: 6, encoding: 'utf8', truncatedByBytes: false }),
  }))
  const pagedValue = await paged.execute({ alias: 'a', remotePath: 'C:\\b.log', offset: 3, limit: 2 })
  assertValidOutput(paged, pagedValue)
  const pagedBody = (paged.output.render?.({}, pagedValue) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(pagedBody, /\(Showing lines 3-4 of 6\. Continue with offset=5\.\)/)
  assert.doesNotMatch(pagedBody, /byte budget/)

  // A non-UTF-8 file has to say so: the caller's next write would otherwise
  // replace the encoding without any way to notice first.
  const wide = winrmReadTool(stubEngine({
    readFile: async () => ({ path: 'C:\\w.ps1', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1, encoding: 'utf16le', truncatedByBytes: false }),
  }))
  const wideValue = await wide.execute({ alias: 'a', remotePath: 'C:\\w.ps1' })
  assertValidOutput(wide, wideValue)
  const wideBody = (wide.output.render?.({}, wideValue) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(wideBody, /\(End of file - total 1 lines, encoding utf16le\)/)

  const failed = winrmReadTool(stubEngine({
    readFile: async () => { throw new Error('remote file not found: C:\\nope.txt') },
  }))
  assertValidOutput(failed, await failed.execute({ alias: 'a', remotePath: 'C:\\nope.txt' }))
})

test('winrm_read clamps offset and limit before calling the engine', async () => {
  const seen: Array<{ offset: number; limit: number }> = []
  const tool = winrmReadTool(stubEngine({
    readFile: async (_alias: string, _path: string, offset: number, limit: number) => {
      seen.push({ offset, limit })
      return { path: 'p', offset, lines: [], totalLines: 0, encoding: 'utf8', truncatedByBytes: false }
    },
  }))
  // A negative or zero offset would make the remote `-lt` test skip nothing and
  // return the whole file; a huge limit would exceed the transport budget.
  await tool.execute({ alias: 'a', remotePath: 'p', offset: 0, limit: 10_000_000 })
  await tool.execute({ alias: 'a', remotePath: 'p', offset: -5, limit: 0 })
  await tool.execute({ alias: 'a', remotePath: 'p' })
  assert.deepEqual(seen[0], { offset: 1, limit: 5_000 })
  assert.deepEqual(seen[1], { offset: 1, limit: 1 })
  assert.deepEqual(seen[2], { offset: 1, limit: 2_000 })
})

test('winrm_write output schema accepts create, update, and errors', async () => {
  for (const encoding of ['utf8', 'utf8bom', 'utf16le'] as const) {
    const tool = winrmWriteTool(stubEngine({
      writeFile: async () => ({ path: 'C:\\t\\a.ps1', operation: 'create', bytes: 44, encoding }),
    }))
    const value = await tool.execute({ alias: 'a', remotePath: 'C:\\t\\a.ps1', content: 'x', encoding })
    assertValidOutput(tool, value)
    const body = (tool.output.render?.({}, value) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
    assert.match(body, /<content>\nCreated file \(44 bytes\)\n<\/content>/)
  }

  const updated = winrmWriteTool(stubEngine({
    writeFile: async () => ({ path: 'C:\\t\\a.ps1', operation: 'update', bytes: 7, encoding: 'utf8' }),
  }))
  const updatedValue = await updated.execute({ alias: 'a', remotePath: 'C:\\t\\a.ps1', content: 'x' })
  assertValidOutput(updated, updatedValue)
  const updatedBody = (updated.output.render?.({}, updatedValue) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(updatedBody, /Updated file \(7 bytes\)/)

  const failed = winrmWriteTool(stubEngine({
    writeFile: async () => { throw new Error('SMB is not reachable on h:445') },
  }))
  assertValidOutput(failed, await failed.execute({ alias: 'a', remotePath: 'r', content: 'x' }))
})

test('winrm_edit output schema accepts single, multiple, and error values', async () => {
  const single = winrmEditTool(stubEngine({
    editFile: async () => ({ path: 'C:\\t\\a.config', encoding: 'utf8', replacements: 1, size: 120 }),
  }))
  const singleValue = await single.execute({ alias: 'a', remotePath: 'C:\\t\\a.config', oldString: 'x', newString: 'y' })
  assertValidOutput(single, singleValue)
  const singleBody = (single.output.render?.({}, singleValue) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.equal(singleBody, 'The file C:\\t\\a.config has been updated successfully.')

  const many = winrmEditTool(stubEngine({
    editFile: async () => ({ path: 'C:\\t\\a.config', encoding: 'utf16le', replacements: 3, size: 90 }),
  }))
  const manyValue = await many.execute({ alias: 'a', remotePath: 'C:\\t\\a.config', oldString: 'x', newString: 'y', replaceAll: true })
  assertValidOutput(many, manyValue)
  const manyBody = (many.output.render?.({}, manyValue) ?? []).map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(manyBody, /All 3 occurrences were successfully replaced/)

  const failed = winrmEditTool(stubEngine({
    editFile: async () => { throw new Error('oldString appears more than once') },
  }))
  assertValidOutput(failed, await failed.execute({ alias: 'a', remotePath: 'r', oldString: 'x', newString: 'y' }))
})
