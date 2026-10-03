/**
 * WinRM transport bridge.
 *
 * Runs each PowerShell payload over a native Node.js WinRM client
 * (winrm-client) — no Python/pywinrm subprocess. The script is delivered on
 * the WinRS **stdin** stream and answers on the UTF-8 base64 envelope, so
 * Chinese and any codepage output survives the transport losslessly and the
 * command line stays a constant, ASCII-safe line that WinRS/cmd.exe cannot
 * mangle. See powershell.ts for why the command line cannot carry the script.
 *
 * Auth is chosen per attempt (HTTPS: Basic first, then NTLM; HTTP: NTLM
 * first, then Basic) with fallback, so a host that only enables one scheme
 * still connects. Credentials are passed to the library in-process — they
 * never appear in a child-process argument list.
 */

import { createGunzip, gzipSync } from 'node:zlib'
import { Command, Shell } from 'winrm-client'
import type { WinHostEntry } from '../protocol.ts'
import {
  buildStreamFrame,
  parseEnvelope,
  powershellCommandLine,
  psFileSize,
  psReadChunk,
  psReceiveStream,
  psSendStream,
  psWriteChunk,
  scriptCommandLine,
  scriptPayload,
  splitScriptPayload,
  STREAM_FRAME_GZIP,
  STREAM_FRAME_HEADER,
  STREAM_FRAME_RAW,
  streamCommandLine,
  stripClixml,
} from '../powershell.ts'
import { isEnvelopeTooLarge, loadSendHttp, receiveOutput, sendStdinChunk, type WsmanTarget } from './wsman.ts'
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
 * One shell lifecycle: create → run the constant envelope script → push the
 * payload on stdin → receive until the command completes → delete. Bounded by
 * an overall deadline; on timeout the delete is fired without blocking.
 * @param conn - connection parameters.
 * @param payload - the stdin payload (`<byteCount>\n<script>`).
 * @param timeoutMs - command execution budget measured from just after Execute.
 * @param authMethod - the auth scheme for this attempt.
 * @returns stdout/stderr captured from the WinRS streams.
 * @throws WinrmTimedOut when the deadline passes; other errors are auth/transport failures.
 */
async function attemptOnce(
  conn: WinRMParams,
  payload: string,
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
    const commandId = await Command.doExecuteCommand({ ...base, shellId, command: powershellCommandLine() })
    for (const piece of splitScriptPayload(payload)) {
      await Command.doSendInput({ ...base, shellId, commandId, input: piece })
    }
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
 * @param payload - the stdin payload (`<byteCount>\n<script>`).
 * @param timeoutMs - command execution budget.
 * @returns captured stdout/stderr.
 * @throws WinrmTimedOut on deadline; the last auth/transport error when every scheme fails.
 */
async function runWinrm(
  conn: WinRMParams,
  payload: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const candidates: WinrmAuth[] = conn.useHttps ? ['basic', 'ntlm'] : ['ntlm', 'basic']
  let lastError: unknown
  for (const authMethod of candidates) {
    try {
      return await attemptOnce(conn, payload, timeoutMs, authMethod)
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
  const payload = scriptPayload(script)

  let outcome: { stdout: string; stderr: string }
  try {
    outcome = await runWinrm(conn, payload, timeoutMs)
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
  const stderr = parsed !== null ? stripClixml(parsed.stderr) : outcome.stderr
  options.onChunk?.({ output: raw, stderr })
  return {
    stdout: parsed !== null ? parsed.stdout : raw,
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

/**
 * Size of a remote file, or null when the path does not exist or is a
 * directory. The distinction matters: a caller that treats "absent" as "empty"
 * writes an empty local file and reports success for a download that copied
 * nothing.
 */
export async function remoteFileSize(conn: WinRMParams, remotePath: string, timeoutMs = 60_000): Promise<number | null> {
  const result = await runScript(conn, psFileSize(remotePath), { timeoutMs })
  const text = result.stdout.trim()
  if (text === '') return null
  const value = Number.parseInt(text, 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export async function downloadChunks(
  conn: WinRMParams,
  remotePath: string,
  onChunk: (b64: string, bytes: number) => void,
  onProgress?: (transferred: number, total: number) => void,
  timeoutMs = 60_000,
): Promise<number> {
  const total = await remoteFileSize(conn, remotePath, timeoutMs)
  if (total === null) throw new Error(`remote file not found: ${remotePath}`)
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

/** Raw slice size for the streaming path: 256 KiB, comfortably inside `MAX_SEND_SLICE_BYTES`. */
const STREAM_CHUNK_BYTES = 262_144

/**
 * Compress a slice only when it actually shrinks.
 *
 * Gzip on already-compressed input (zips, images, installers) produces output
 * marginally *larger* than its input, and the remote side then pays to inflate
 * it for nothing — measured at ~3.8x the wall time of sending the same bytes
 * raw. Local compression is cheap (~3.4 ms per 256 KiB even when it fails to
 * compress), so probing every slice costs almost nothing and the ratio is the
 * only thing that decides.
 */
const STREAM_GZIP_MIN_RATIO = 0.85

/** Per-Send HTTP budget; a single slice is small, so this only bounds a stalled connection. */
const STREAM_SEND_TIMEOUT_MS = 120_000

/**
 * One streaming transfer over a single shell: create → run the receiver →
 * push the receiver script, the header frame and every data frame down stdin →
 * receive the envelope → delete the shell.
 *
 * The receiver script is the first thing on stdin because it does not fit the
 * command line (see `streamCommandLine`); the bootstrap in the command line
 * reads it and runs it in-process so it can keep reading the same stream.
 * @param conn - connection parameters.
 * @param remotePath - destination path on the target.
 * @param data - the file contents to send.
 * @param onProgress - called with cumulative bytes after each frame.
 * @param timeoutMs - whole-transfer budget.
 * @param authMethod - the auth scheme for this attempt.
 * @param sendHttp - the resolved library send function.
 * @returns the number of file bytes the receiver acknowledged writing.
 * @throws WinrmTimedOut when the deadline passes; other errors are transport failures.
 */
async function streamOnce(
  conn: WinRMParams,
  remotePath: string,
  data: Buffer,
  onProgress: ((transferred: number, total: number) => void) | undefined,
  timeoutMs: number,
  authMethod: WinrmAuth,
  sendHttp: ReturnType<typeof loadSendHttp> & object,
): Promise<number> {
  const base = baseParams(conn, authMethod)
  const target: WsmanTarget = {
    host: conn.host,
    port: conn.port,
    path: conn.path,
    username: conn.username,
    password: conn.password,
    authMethod,
    useHttps: conn.useHttps ?? false,
    rejectUnauthorized: conn.rejectUnauthorized ?? true,
  }
  const hardDeadline = Date.now() + timeoutMs + SETUP_GRACE_MS
  const state = { shellId: undefined as string | undefined, timedOut: false, settled: false }
  const total = data.length

  const inner = async (): Promise<number> => {
    const shellId = await Shell.doCreateShell(base)
    state.shellId = shellId
    if (state.settled) {
      void Shell.doDeleteShell({ ...base, shellId }).catch(() => undefined)
      throw new WinrmTimedOut()
    }
    const commandId = await Command.doExecuteCommand({ ...base, shellId, command: streamCommandLine() })

    // 1. The receiver itself, in the `<byteCount>\n<script>` shape the
    //    bootstrap expects. This is not a DSHZ frame — it is what the
    //    command line's bootstrap reads before any framing starts.
    await sendStdinChunk(target, shellId, commandId, Buffer.from(scriptPayload(psReceiveStream()), 'utf8'), sendHttp, STREAM_SEND_TIMEOUT_MS)

    // 2. The transfer header: total byte count and destination path, which is
    //    how the receiver learns both without them touching the command line.
    const header = Buffer.from(String(total) + '\n' + remotePath, 'utf8')
    await sendStdinChunk(target, shellId, commandId, buildStreamFrame(header, STREAM_FRAME_HEADER), sendHttp, STREAM_SEND_TIMEOUT_MS)

    // 3. Data frames. Slice size halves on a size rejection and recovers
    //    afterwards, so a host with a smaller envelope ceiling still converges
    //    without the caller knowing its limit.
    let offset = 0
    let slice = STREAM_CHUNK_BYTES
    let ceiling = STREAM_CHUNK_BYTES
    while (offset < total) {
      if (state.settled || Date.now() >= hardDeadline) throw new WinrmTimedOut()
      const take = Math.min(slice, total - offset)
      const chunk = data.subarray(offset, offset + take)
      const gz = gzipSync(chunk, { level: 6 })
      const compress = gz.length < chunk.length * STREAM_GZIP_MIN_RATIO
      const frame = buildStreamFrame(compress ? gz : chunk, compress ? STREAM_FRAME_GZIP : STREAM_FRAME_RAW)
      try {
        await sendStdinChunk(target, shellId, commandId, frame, sendHttp, STREAM_SEND_TIMEOUT_MS)
      } catch (error) {
        if (isEnvelopeTooLarge(error) && slice > 16_384) {
          slice = Math.max(16_384, Math.floor(slice / 2))
          ceiling = slice
          continue
        }
        throw error
      }
      offset += take
      onProgress?.(offset, total)
      if (slice < ceiling) slice = Math.min(ceiling, slice * 2)
    }

    // 4. The receiver stops on its own once the declared byte count lands, so
    //    there is nothing to close — just wait for its envelope.
    const receive = { ...base, shellId, commandId }
    const commandDeadline = Date.now() + timeoutMs
    let stdout = ''
    let stderr = ''
    for (;;) {
      if (state.settled || Date.now() >= commandDeadline) throw new WinrmTimedOut()
      const chunk = await Command.doReceiveOutputNonBlocking(receive)
      stdout += chunk.output
      stderr += chunk.stderr
      if (chunk.isComplete) break
    }

    const parsed = parseEnvelope(stdout)
    if (parsed === null) {
      throw new Error('streaming upload did not report completion: ' + (stripClixml(stderr) || stdout).trim())
    }
    if (parsed.exitCode !== 0) {
      throw new Error('streaming upload failed on the target: ' + parsed.stdout.trim())
    }
    const written = Number.parseInt(parsed.stdout.trim(), 10)
    if (!Number.isFinite(written) || written !== total) {
      throw new Error(`streaming upload wrote ${parsed.stdout.trim()} of ${total} bytes`)
    }
    return written
  }

  try {
    return await raceDeadline(inner(), hardDeadline - Date.now())
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
 * Upload a buffer over a single WinRS stdin stream.
 *
 * This replaces the per-chunk shell cycle: one shell, one command and one
 * `Send` per 256 KiB, against a receiver that drains the stream straight into
 * the file. Measured at ~10 s for 2 MiB where the old path took 310 s.
 *
 * Returns null — rather than throwing — when the transport this path depends
 * on is unavailable (a future `winrm-client` layout that drops the internal
 * module it borrows), so the caller can fall back to {@link uploadBuffer}
 * instead of failing the transfer.
 * @param conn - connection parameters.
 * @param remotePath - destination path on the target.
 * @param data - the file contents to send.
 * @param onProgress - called with cumulative bytes after each frame.
 * @param timeoutMs - whole-transfer budget.
 * @returns bytes written, or null when the streaming path is unavailable.
 */
export async function uploadStream(
  conn: WinRMParams,
  remotePath: string,
  data: Buffer,
  onProgress?: (transferred: number, total: number) => void,
  timeoutMs = 600_000,
): Promise<number | null> {
  const sendHttp = loadSendHttp()
  if (sendHttp === null) return null
  const candidates: WinrmAuth[] = conn.useHttps ? ['basic', 'ntlm'] : ['ntlm', 'basic']
  let lastError: unknown
  for (const authMethod of candidates) {
    try {
      return await streamOnce(conn, remotePath, data, onProgress, timeoutMs, authMethod, sendHttp)
    } catch (error) {
      if (error instanceof WinrmTimedOut) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all WinRM authentication methods failed')
}

/** Smallest byte range worth giving a worker; below this the shell setup dominates. */
const DOWNLOAD_MIN_RANGE_BYTES = 524_288
/** Most shells to open for one download. Measured 3.9x on 16 MiB at four; more adds target load. */
const DOWNLOAD_MAX_WORKERS = 4
/** Per-Receive HTTP timeout. The server long-polls, so this only bounds a stalled transport. */
const DOWNLOAD_RECEIVE_TIMEOUT_MS = 120_000

/**
 * One worker's slice of a download: own shell, own command, own byte range.
 * @param conn - connection parameters.
 * @param remotePath - file being read.
 * @param start - first byte offset of this worker's range.
 * @param length - bytes this worker must deliver.
 * @param onData - receives each decompressed piece together with its file offset.
 * @param timeoutMs - budget for the whole range.
 * @param authMethod - the auth scheme for this attempt.
 * @param sendHttp - the resolved library HTTP function.
 * @returns the number of file bytes this worker delivered.
 */
async function downloadWorkerOnce(
  conn: WinRMParams,
  remotePath: string,
  start: number,
  length: number,
  onData: (offset: number, data: Buffer) => void,
  timeoutMs: number,
  authMethod: WinrmAuth,
  sendHttp: ReturnType<typeof loadSendHttp> & object,
): Promise<number> {
  const base = baseParams(conn, authMethod)
  const target: WsmanTarget = {
    host: conn.host,
    port: conn.port,
    path: conn.path,
    username: conn.username,
    password: conn.password,
    authMethod,
    useHttps: conn.useHttps ?? false,
    rejectUnauthorized: conn.rejectUnauthorized ?? true,
  }
  const hardDeadline = Date.now() + timeoutMs + SETUP_GRACE_MS
  const state = { shellId: undefined as string | undefined, timedOut: false, settled: false }

  const inner = async (): Promise<number> => {
    const shellId = await Shell.doCreateShell(base)
    state.shellId = shellId
    if (state.settled) {
      void Shell.doDeleteShell({ ...base, shellId }).catch(() => undefined)
      throw new WinrmTimedOut()
    }
    const commandId = await Command.doExecuteCommand({
      ...base,
      shellId,
      command: scriptCommandLine(psSendStream(remotePath, start, length)),
    })
    // Each worker decompresses its own gzip stream as it arrives, so memory
    // stays bounded by one Receive response rather than by the file size. The
    // error listener is attached up front: a decompression failure during the
    // loop would otherwise surface as an unhandled 'error' event and kill the
    // process instead of failing this transfer. `written` is only trusted once
    // the inflater has ended, since 'data' fires asynchronously.
    const inflater = createGunzip()
    let inflateError: Error | undefined
    inflater.on('error', (error: Error) => { inflateError = error })
    let written = 0
    let stderr = ''
    inflater.on('data', (piece: Buffer) => {
      onData(start + written, piece)
      written += piece.length
    })
    let stdoutEnded = false
    let exitCode: number | undefined
    while (!stdoutEnded) {
      // A worker that lost the deadline race keeps running in the background
      // unless it checks; without this it would go on fetching and pushing
      // bytes into a file the caller has already given up on.
      if (state.settled || Date.now() >= hardDeadline) throw new WinrmTimedOut()
      const result = await receiveOutput(target, shellId, commandId, sendHttp, DOWNLOAD_RECEIVE_TIMEOUT_MS)
      let sawData = false
      for (const stream of result.streams) {
        if (stream.data.length === 0) {
          if (stream.name === 'stdout' && stream.end) stdoutEnded = true
          continue
        }
        sawData = true
        if (stream.name === 'stdout') {
          inflater.write(stream.data)
          if (stream.end) stdoutEnded = true
        } else {
          stderr += stream.data.toString('utf8')
        }
      }
      if (inflateError !== undefined) throw inflateError
      if (result.exitCode !== undefined) exitCode = result.exitCode
      // A finished command whose final response carried nothing means the
      // streams are drained; without this the loop would spin on CommandState
      // alone when the payload ended exactly on a response boundary.
      if (!sawData && exitCode !== undefined) break
    }
    await new Promise<void>((resolve, reject) => {
      inflater.on('error', reject)
      inflater.on('end', resolve)
      inflater.end()
    })
    if (inflateError !== undefined) throw inflateError
    if (exitCode !== undefined && exitCode !== 0) {
      throw new Error('streaming download failed on the target: ' + stderr.trim())
    }
    if (written !== length) {
      throw new Error(`streaming download delivered ${written} of ${length} bytes`)
    }
    return written
  }

  try {
    return await raceDeadline(inner(), hardDeadline - Date.now())
  } catch (error) {
    state.timedOut = error instanceof WinrmTimedOut
    throw error
  } finally {
    state.settled = true
    const shellId = state.shellId
    if (shellId !== undefined) {
      try {
        await raceDeadline(Shell.doDeleteShell({ ...base, shellId }), DELETE_TIMEOUT_MS)
      } catch {
        // Best effort: an orphaned shell is reaped by the target eventually.
      }
    }
  }
}

/**
 * Stream a remote file to a consumer, in parallel byte ranges.
 *
 * The old path asked for 48 KiB per shell lifecycle, so a 2 MiB file cost 43
 * round-trip cycles and 129 s. Measured against this target, one `Receive`
 * returns at most 128 KiB no matter how large an envelope is declared, which
 * makes a download latency-bound rather than bandwidth-bound; the fix is
 * therefore to run several ranges at once. Each worker opens its own shell and
 * streams its range gzip-compressed, and because ranges are absolute, the
 * caller can place each piece by offset and completion order does not matter.
 *
 * The remote side compresses unconditionally: a compressible 16 MiB file
 * arrives in one round trip (2.0 s), and an incompressible file was measured no
 * slower than raw (9457 ms vs 9582 ms).
 * @param conn - connection parameters.
 * @param remotePath - file to read.
 * @param onData - receives each decompressed piece with its absolute file offset.
 * @param onProgress - receives cumulative bytes delivered and the total size.
 * @param timeoutMs - budget for the whole download.
 * @returns the number of bytes delivered, or null when streaming is unavailable.
 */
export async function downloadStream(
  conn: WinRMParams,
  remotePath: string,
  onData: (offset: number, data: Buffer) => void,
  onProgress?: (transferred: number, total: number) => void,
  timeoutMs = 600_000,
): Promise<number | null> {
  const sendHttp = loadSendHttp()
  if (sendHttp === null) return null
  const total = await remoteFileSize(conn, remotePath)
  if (total === null) throw new Error(`remote file not found: ${remotePath}`)
  if (total === 0) return 0
  const workers = Math.max(1, Math.min(DOWNLOAD_MAX_WORKERS, Math.ceil(total / DOWNLOAD_MIN_RANGE_BYTES)))
  const rangeSize = Math.ceil(total / workers)
  let transferred = 0
  // `Promise.all` rejects on the first worker to fail, but its siblings keep
  // running until they next notice; without a gate a stale worker would keep
  // feeding data from a failed attempt into the retry's counters and into the
  // caller's file — after the caller has already closed it.
  let generation = 0
  let live = true
  const candidates: WinrmAuth[] = conn.useHttps ? ['basic', 'ntlm'] : ['ntlm', 'basic']
  let lastError: unknown
  try {
    for (const authMethod of candidates) {
      // Reset per attempt: a retry re-sends every range from its own start, so
      // carrying the count over would report more bytes than the file holds.
      transferred = 0
      const mine = ++generation
      const report = (offset: number, data: Buffer): void => {
        if (!live || mine !== generation) return
        onData(offset, data)
        transferred += data.length
        onProgress?.(transferred, total)
      }
      try {
        const ranges: { start: number; length: number }[] = []
        for (let start = 0; start < total; start += rangeSize) {
          ranges.push({ start, length: Math.min(rangeSize, total - start) })
        }
        await Promise.all(
          ranges.map(range =>
            downloadWorkerOnce(conn, remotePath, range.start, range.length, report, timeoutMs, authMethod, sendHttp),
          ),
        )
        return transferred
      } catch (error) {
        if (error instanceof WinrmTimedOut) throw error
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('all WinRM authentication methods failed')
  } finally {
    // Once this function settles the caller may close its file, so every worker
    // must stop emitting immediately — an orphaned worker writing afterwards
    // would hit a closed handle.
    live = false
  }
}
