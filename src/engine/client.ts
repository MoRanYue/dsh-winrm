/**
 * WinRM transport bridge.
 *
 * Runs each PowerShell payload over a native Node.js WinRM client
 * (winrm-client) — no Python/pywinrm subprocess. The script rides the
 * UTF-8 base64 envelope (marker + base64 of UTF-8 output) so Chinese and
 * any codepage output survives the WinRM transport losslessly; the envelope
 * is base64-encoded with `-EncodedCommand`, keeping the command line a
 * single ASCII-safe line that WinRS/cmd.exe cannot mangle.
 *
 * Auth is chosen per attempt (HTTPS: Basic first, then NTLM; HTTP: NTLM
 * first, then Basic) with fallback, so a host that only enables one scheme
 * still connects. Credentials are passed to the library in-process — they
 * never appear in a child-process argument list.
 */

import { Command, Shell } from 'winrm-client'
import type { WinHostEntry } from '../protocol.ts'
import { parseEnvelope, powershellCommandLine, psFileSize, psReadChunk, psWriteChunk, stripClixml, winrmPowerShellScript } from '../powershell.ts'

/** Connection parameters for one target (transport-agnostic projection of a host entry). */
export interface WinRMParams {
  host: string
  port: number
  path: string
  username: string
  password: string
  useHttps?: boolean
  rejectUnauthorized?: boolean
}

/** winrm-client auth schemes (mirrors its `AuthMethod`). */
type WinrmAuth = 'basic' | 'ntlm'

/** Extra wall-clock budget so connection setup does not eat the command's timeout window. */
const SETUP_GRACE_MS = 5_000

/** Upper bound on the best-effort shell-delete round trip after a timed-out call. */
const DELETE_TIMEOUT_MS = 10_000

/** Sentinel: the command exceeded its deadline (distinct from auth/transport errors). */
class WinrmTimedOut extends Error {
  constructor() {
    super('WinRM request timed out')
    this.name = 'WinrmTimedOut'
  }
}

/** Small cancellable delay used to bound the shell-delete cleanup. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Race a promise against a deadline; the loser's later settlement is
 * ignored (Promise.race attaches a handler to both), so a hung WinRM call
 * cannot surface as an unhandled rejection.
 * @param promise - the operation to bound.
 * @param ms - milliseconds before rejecting with {@link WinrmTimedOut}.
 * @returns the operation result, or rejects with WinrmTimedOut on deadline.
 */
async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new WinrmTimedOut()) }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Build winrm-client's base params for one auth scheme. */
function baseParams(conn: WinRMParams, authMethod: WinrmAuth) {
  return {
    host: conn.host,
    port: conn.port,
    path: conn.path,
    username: conn.username,
    password: conn.password,
    authMethod,
    useHttps: conn.useHttps ?? false,
    rejectUnauthorized: conn.rejectUnauthorized ?? true,
  }
}

/**
 * One shell lifecycle: create → run the encoded script → receive until the
 * command completes → delete. Bounded by an overall deadline; on timeout the
 * delete is fired without blocking the caller.
 * @param conn - connection parameters.
 * @param envelope - the wrapped UTF-8 envelope script (already prepared).
 * @param timeoutMs - command execution budget measured from just after Execute.
 * @param authMethod - the auth scheme for this attempt.
 * @returns stdout/stderr captured from the WinRS streams.
 * @throws WinrmTimedOut when the deadline passes; other errors are auth/transport failures.
 */
async function attemptOnce(
  conn: WinRMParams,
  envelope: string,
  timeoutMs: number,
  authMethod: WinrmAuth,
): Promise<{ stdout: string; stderr: string }> {
  const base = baseParams(conn, authMethod)
  const hardDeadline = Date.now() + timeoutMs + SETUP_GRACE_MS
  const state = { shellId: undefined as string | undefined, timedOut: false, settled: false }

  const inner = (async (): Promise<{ stdout: string; stderr: string }> => {
    const shellId = await Shell.doCreateShell(base)
    state.shellId = shellId
    // The deadline can fire while the shell is still being created, in which
    // case this attempt has already settled and its `finally` ran without a
    // shell id: abandon the request and remove the shell here so a slow
    // handshake cannot leak it or run the command after the timeout.
    if (state.settled) {
      void Shell.doDeleteShell({ ...base, shellId }).catch(() => undefined)
      throw new WinrmTimedOut()
    }
    const command = powershellCommandLine(envelope)
    const commandId = await Command.doExecuteCommand({ ...base, shellId, command })
    const receive = { ...base, shellId, commandId }
    const commandDeadline = Date.now() + timeoutMs
    let stdout = ''
    let stderr = ''
    for (;;) {
      if (state.settled || Date.now() >= commandDeadline) throw new WinrmTimedOut()
      const chunk = await Command.doReceiveOutputNonBlocking(receive)
      stdout += chunk.output
      stderr += chunk.stderr
      if (chunk.isComplete) return { stdout, stderr }
    }
  })()

  try {
    return await raceDeadline(inner, hardDeadline - Date.now())
  } catch (error) {
    if (error instanceof WinrmTimedOut || Date.now() >= hardDeadline) {
      state.timedOut = true
      throw error instanceof WinrmTimedOut ? error : new WinrmTimedOut()
    }
    throw error
  } finally {
    state.settled = true
    const shellId = state.shellId
    if (shellId !== undefined) {
      const deletion = Shell.doDeleteShell({ ...base, shellId }).catch(() => undefined)
      if (state.timedOut) void deletion
      else await Promise.race([deletion, sleep(DELETE_TIMEOUT_MS)])
    }
  }
}

/**
 * Run one envelope over WinRM, trying each auth scheme in order until one
 * succeeds. A timeout aborts immediately (retrying auth would waste the
 * remaining budget on a reachable-but-slow host).
 * @param conn - connection parameters.
 * @param envelope - the wrapped UTF-8 envelope script.
 * @param timeoutMs - command execution budget.
 * @returns captured stdout/stderr.
 * @throws WinrmTimedOut on deadline; the last auth/transport error when every scheme fails.
 */
async function runWinrm(
  conn: WinRMParams,
  envelope: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const candidates: WinrmAuth[] = conn.useHttps ? ['basic', 'ntlm'] : ['ntlm', 'basic']
  let lastError: unknown
  for (const authMethod of candidates) {
    try {
      return await attemptOnce(conn, envelope, timeoutMs, authMethod)
    } catch (error) {
      if (error instanceof WinrmTimedOut) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all WinRM authentication methods failed')
}

export async function runScript(
  conn: WinRMParams,
  script: string,
  options: { timeoutMs?: number; onChunk?: (chunk: { output: string; stderr: string }) => void } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 60_000
  const envelope = winrmPowerShellScript(script)

  let outcome: { stdout: string; stderr: string }
  try {
    outcome = await runWinrm(conn, envelope, timeoutMs)
  } catch (error) {
    if (error instanceof WinrmTimedOut) {
      return { stdout: '', stderr: '', exitCode: null, timedOut: true, durationMs: Date.now() - started }
    }
    throw error
  }

  const raw = outcome.stdout
  const parsed = parseEnvelope(raw)
  // The envelope is the wrapper's completion signal, and it always prints —
  // even for output that is empty. Its absence therefore means the script
  // never ran to completion (a parse error, or an aborted shell), which is a
  // failure; the raw stream is still returned as evidence.
  const exitCode = parsed !== null ? parsed.exitCode : 1
  // A script that reached the envelope leaves only the host's CLIXML records
  // on stderr; an aborted one keeps its stderr untouched for diagnosis.
  const stderr = parsed !== null ? stripClixml(outcome.stderr) : outcome.stderr
  options.onChunk?.({ output: raw, stderr })
  return {
    stdout: parsed !== null ? parsed.text : raw,
    stderr,
    exitCode,
    timedOut: false,
    durationMs: Date.now() - started,
  }
}

export function connOf(entry: WinHostEntry): WinRMParams {
  return {
    host: entry.host,
    port: entry.port,
    path: '/wsman',
    username: entry.user,
    password: entry.auth.password ?? '',
    useHttps: entry.transport === 'https',
    rejectUnauthorized: entry.rejectUnauthorized ?? true,
  }
}

export async function testConnection(conn: WinRMParams): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    const result = await runScript(conn, 'Write-Output ok', { timeoutMs: 30_000 })
    return { ok: result.exitCode === 0 && result.stdout.trim() !== '', latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}

export const TRANSFER_CHUNK = 48 * 1024

export async function remoteFileSize(conn: WinRMParams, remotePath: string, timeoutMs = 60_000): Promise<number> {
  const result = await runScript(conn, psFileSize(remotePath), { timeoutMs })
  const value = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(value) ? value : 0
}

export async function downloadChunks(
  conn: WinRMParams,
  remotePath: string,
  onChunk: (b64: string, bytes: number) => void,
  onProgress?: (transferred: number, total: number) => void,
  timeoutMs = 60_000,
): Promise<number> {
  const total = await remoteFileSize(conn, remotePath, timeoutMs)
  if (total === 0) return 0
  let offset = 0
  for (;;) {
    const result = await runScript(conn, psReadChunk(remotePath, offset, TRANSFER_CHUNK), { timeoutMs })
    const b64 = result.stdout.trim()
    const bytes = Buffer.from(b64, 'base64').length
    if (bytes === 0) break
    onChunk(b64, bytes)
    offset += bytes
    onProgress?.(offset, total)
    if (offset >= total || bytes < TRANSFER_CHUNK) break
  }
  return offset
}

export async function uploadBuffer(
  conn: WinRMParams,
  remotePath: string,
  data: Buffer,
  onProgress?: (transferred: number, total: number) => void,
  timeoutMs = 60_000,
): Promise<number> {
  let written = 0
  let first = true
  for (let offset = 0; offset < data.length; offset += TRANSFER_CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + TRANSFER_CHUNK, data.length))
    await runScript(conn, psWriteChunk(remotePath, chunk.toString('base64'), !first), { timeoutMs })
    written += chunk.length
    first = false
    onProgress?.(written, data.length)
  }
  return written
}
