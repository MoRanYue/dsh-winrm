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
  winrmExecTool,
  winrmListTool,
  winrmProcessTool,
  winrmServiceTool,
  winrmUploadTool,
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
