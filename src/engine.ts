/**
 * The WinRM engine facade: host lookup, PowerShell exec (UTF-8 envelope),
 * service & process management, directory listing, file transfer, cluster
 * execution and the streaming console. The heavy lifting lives in engine/
 * (client, console); this class composes them behind one WinRmEngine instance
 * per plugin apply.
 */

import type { ClusterResult, ExecResult, ProcessInfo, RemoteDirEntry, RemoteEditOutcome, RemoteTextEncoding, RemoteTextWindow, RemoteWriteOutcome, ServiceInfo, TestResult, TransferProgress, WinHostSummary } from './protocol.ts'
import type { HostStore } from './store.ts'
import { connOf, downloadChunks, downloadStream, remoteFileSize, runScript, testConnection, uploadBuffer, uploadStream } from './engine/client.ts'
import { downloadSmb, smbReachable, smbUnavailable, uploadSmb, type TransferChannel } from './smb.ts'
import { ConsoleSession } from './engine/console.ts'
import { psEditText, psKillProcess, psListDir, psListProcesses, psListServices, psReadTextWindow, psServiceAction } from './powershell.ts'

/** Longest single line the reader returns before cutting it (characters). */
export const READ_MAX_LINE_LENGTH = 2_000

/** Lines the reader returns when the caller does not choose a page size. */
export const READ_DEFAULT_LIMIT = 2_000

/** Most lines the reader will return in one call. */
export const READ_MAX_LIMIT = 5_000

/** Byte budget for one read window; keeps the envelope well under the transport limit. */
export const READ_MAX_BYTES = 512 * 1_024

/** JSON-safe parse of the envelope output into a typed value. */
function parseJson<T>(text: string): T {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === 'null') return [] as unknown as T
  return JSON.parse(trimmed) as T
}

/**
 * Parse one JSON object out of an envelope's stdout.
 *
 * The file tools report their own failures inside the JSON (`{"error":…}`)
 * with exit code 0, so an unparseable body means the fragment never ran;
 * returning undefined lets the caller say so instead of throwing a
 * `SyntaxError` with no context.
 * @param text - envelope stdout.
 * @returns the parsed object, or undefined when the body is empty or not JSON.
 */
function parseObject<T>(text: string): T | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === 'null') return undefined
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return undefined
  }
}

/** Mark an over-long line the reader cut, so the model knows it is incomplete. */
function annotateCutLine(text: string): string {
  return text.length > READ_MAX_LINE_LENGTH
    ? `${text.slice(0, READ_MAX_LINE_LENGTH)}… (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
    : text
}

/** Encode text for a remote write, applying the requested byte-order mark. */
function encodeText(content: string, encoding: RemoteTextEncoding): Buffer {
  const body = Buffer.from(content, 'utf8')
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
  return body
}

/** A tiny per-alias in-flight limiter so GUI bursts do not pile up sockets. */
class AliasGate {
  private queues = new Map<string, Promise<void>>()

  async run<T>(alias: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(alias) ?? Promise.resolve()
    const next = prev.then(() => fn(), () => fn())
    // Keep the chain alive even when fn rejects (the caller observes the rejection).
    this.queues.set(alias, next.then(() => undefined, () => undefined))
    try {
      return await next
    } finally {
      if (this.queues.get(alias) === next.then(() => undefined, () => undefined)) {
        // (The identity check above is intentionally approximate; the queue
        // entry is replaced per run, so stale entries are naturally dropped.)
      }
      void prev
    }
  }
}

/** The engine. One instance per plugin apply; dispose() clears nothing pooled (WinRM is per-call HTTP). */
export class WinRmEngine {
  readonly store: HostStore
  private gate = new AliasGate()

  constructor(store: HostStore) {
    this.store = store
  }

  // ---------------------------------------------------------------- config

  /** Secret-free host list (filtered by the optional query). */
  list(query?: string): WinHostSummary[] {
    const needle = query?.trim().toLowerCase()
    return this.store.list()
      .filter(entry => needle === undefined || needle === ''
        || entry.alias.toLowerCase().includes(needle)
        || (entry.description ?? '').toLowerCase().includes(needle)
        || entry.host.toLowerCase().includes(needle)
        || entry.tags.some(tag => tag.toLowerCase().includes(needle)))
      .map(entry => this.store.summarize(entry))
  }

  /** One host summary by alias. */
  find(alias: string): WinHostSummary | undefined {
    const entry = this.store.find(alias)
    return entry === undefined ? undefined : this.store.summarize(entry)
  }

  // ------------------------------------------------------------------ exec

  /** Run one PowerShell command on `alias`. */
  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const entry = this.store.find(alias)
    if (entry === undefined) {
      return { success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0, error: `alias '${alias}' not found` }
    }
    return this.gate.run(alias, async () => {
      try {
        const result = await runScript(connOf(entry), command, { timeoutMs: timeoutMs ?? 60_000 })
        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        }
      } catch (error) {
        return { success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  // --------------------------------------------------------------- cluster

  /** Run one command against many hosts concurrently. */
  async cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
  }): Promise<ClusterResult[]> {
    const hosts = this.store.list()
    let matched = hosts
    if (options.aliases !== undefined && options.aliases.length > 0) {
      const set = new Set(options.aliases)
      matched = matched.filter(entry => set.has(entry.alias))
    }
    if (options.environment !== undefined && options.environment !== '') {
      matched = matched.filter(entry => entry.environment === options.environment)
    }
    if (options.tags !== undefined && options.tags.length > 0) {
      matched = matched.filter(entry => options.tags!.every(tag => entry.tags.includes(tag)))
    }
    const maxWorkers = Math.max(1, Math.min(options.maxWorkers ?? 8, 32))
    const results: ClusterResult[] = []
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++
        const entry = matched[index]
        if (entry === undefined) return
        const started = Date.now()
        const outcome = await this.exec(entry.alias, options.command, options.timeoutMs)
        results.push({
          alias: entry.alias,
          ok: outcome.success,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          durationMs: outcome.durationMs,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        })
        void started
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxWorkers, matched.length) }, () => worker()))
    return results
  }

  // -------------------------------------------------------------- services

  /** Full service table. */
  async listServices(alias: string): Promise<ServiceInfo[]> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psListServices(), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || 'failed to list services')
      const items = parseJson<Array<{ name?: string; displayName?: string; status?: string; startMode?: string; startName?: string }>>(result.stdout)
      return items.map(item => ({
        name: item.name ?? '',
        displayName: item.displayName ?? '',
        status: item.status ?? '',
        startMode: item.startMode ?? '',
        startName: item.startName ?? '',
      }))
    })
  }

  /** One service action, returning the refreshed service row. */
  async serviceAction(alias: string, name: string, action: 'start' | 'stop' | 'restart' | 'set-auto' | 'set-manual' | 'set-disabled'): Promise<ServiceInfo> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psServiceAction(name, action), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || `service action '${action}' failed`)
      const item = parseJson<Array<{ name?: string; displayName?: string; status?: string; startMode?: string; startName?: string }>>(result.stdout)[0] ?? {}
      return {
        name: item.name ?? name,
        displayName: item.displayName ?? '',
        status: item.status ?? '',
        startMode: item.startMode ?? '',
        startName: item.startName ?? '',
      }
    })
  }

  // ------------------------------------------------------------- processes

  /** Full process table. */
  async listProcesses(alias: string): Promise<ProcessInfo[]> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psListProcesses(), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || 'failed to list processes')
      const items = parseJson<Array<{ id?: number; name?: string; cpu?: number | null; memMB?: number; startTime?: string | null; path?: string | null }>>(result.stdout)
      return items.map(item => ({
        id: item.id ?? 0,
        name: item.name ?? '',
        ...(item.cpu !== undefined && item.cpu !== null ? { cpu: item.cpu } : {}),
        ...(item.memMB !== undefined && item.memMB !== null ? { memMB: item.memMB } : {}),
        ...(item.startTime !== undefined && item.startTime !== null ? { startTime: item.startTime } : {}),
        ...(item.path !== undefined && item.path !== null ? { path: item.path } : {}),
      }))
    })
  }

  /** Kill one process by id. */
  async killProcess(alias: string, id: number): Promise<void> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psKillProcess(id), { timeoutMs: 30_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || 'failed to kill process')
    })
  }

  // -------------------------------------------------------------------- ls

  /** List a remote directory. */
  async ls(alias: string, dir: string): Promise<RemoteDirEntry[]> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psListDir(dir), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || `failed to list '${dir}'`)
      const items = parseJson<Array<{ name?: string; type?: string; size?: number; mtimeMs?: number }>>(result.stdout)
      return items.map(item => ({
        name: item.name ?? '',
        type: (item.type === 'dir' || item.type === 'file' ? item.type : 'other') as RemoteDirEntry['type'],
        size: item.size ?? 0,
        mtimeMs: item.mtimeMs ?? 0,
      }))
    })
  }

  // ------------------------------------------------------------------ text

  /**
   * Read a bounded, line-numbered window of a remote text file.
   *
   * One PowerShell round trip: the remote side decodes the file, counts every
   * line, and returns only the requested window, so a large log costs one
   * transfer of the window rather than of the file.
   * @param alias - configured host.
   * @param remotePath - path on the target.
   * @param offset - 1-based first line to return.
   * @param limit - maximum number of lines to return.
   * @returns the window plus the file's total line count and encoding.
   */
  async readFile(alias: string, remotePath: string, offset: number, limit: number): Promise<RemoteTextWindow> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(
        connOf(entry),
        psReadTextWindow(remotePath, offset, limit, READ_MAX_LINE_LENGTH, READ_MAX_BYTES),
        { timeoutMs: 120_000 },
      )
      const payload = parseObject<{
        exists?: boolean
        error?: string
        size?: number
        encoding?: string
        totalLines?: number
        lineCount?: number
        truncated?: boolean
        linesText?: string
      }>(result.stdout)
      if (payload === undefined) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `failed to read '${remotePath}'`)
      }
      if (payload.error !== undefined) {
        throw new Error(`${remotePath}: ${payload.error} (the reader decodes UTF-8 and UTF-16 with a BOM; a binary file has no line structure to show)`)
      }
      if (payload.exists !== true) throw new Error(`remote file not found: ${remotePath}`)
      const totalLines = payload.totalLines ?? 0
      const lineCount = payload.lineCount ?? 0
      // `truncated` also covers the byte budget, in which case the offset may
      // legitimately point past what this window reached.
      if (payload.truncated !== true && offset > totalLines && totalLines > 0) {
        throw new Error(`offset ${offset} is out of range for '${remotePath}' (${totalLines} lines)`)
      }
      const texts = lineCount === 0 ? [] : (payload.linesText ?? '').split('\n')
      return {
        path: remotePath,
        offset,
        lines: texts.map((text, index) => ({ number: offset + index, text: annotateCutLine(text) })),
        totalLines,
        encoding: payload.encoding ?? 'utf8',
        truncatedByBytes: payload.truncated === true,
      }
    })
  }

  /**
   * Write a whole remote text file, creating parent directories as needed.
   *
   * Reuses the transfer transport (single streamed stdin when available, the
   * 48 KiB chunk path otherwise) so a large write does not pay one shell cycle
   * per chunk.
   * @param alias - configured host.
   * @param remotePath - path on the target; overwritten when it exists.
   * @param content - UTF-8 text to write.
   * @param encoding - byte-order mark to emit (`utf8`, `utf8bom`, `utf16le`).
   * @returns the operation kind, byte count and encoding actually written.
   */
  async writeFile(alias: string, remotePath: string, content: string, encoding: RemoteTextEncoding): Promise<RemoteWriteOutcome> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    const data = encodeText(content, encoding)
    return this.gate.run(alias, async () => {
      const conn = connOf(entry)
      const before = await remoteFileSize(conn, remotePath)
      let bytes = await uploadStream(conn, remotePath, data)
      if (bytes === null) bytes = await uploadBuffer(conn, remotePath, data)
      return { path: remotePath, operation: before === null ? 'create' : 'update', bytes, encoding }
    })
  }

  /**
   * Replace `oldString` with `newString` inside a remote text file.
   *
   * The replacement is literal, never a pattern, and the file's existing
   * encoding is preserved. Without `replaceAll` the edit is refused unless the
   * needle is unique, so a stale needle cannot rewrite the wrong region.
   * @param alias - configured host.
   * @param remotePath - path on the target.
   * @param oldString - exact text to find.
   * @param newString - text to substitute.
   * @param replaceAll - replace every occurrence instead of requiring one.
   * @returns the replacement count and the file's new size.
   */
  async editFile(
    alias: string,
    remotePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): Promise<RemoteEditOutcome> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    if (oldString === '') throw new Error('oldString must be a non-empty string')
    if (oldString === newString) throw new Error('oldString and newString are identical; nothing to change')
    const oldB64 = Buffer.from(oldString, 'utf8').toString('base64')
    const newB64 = Buffer.from(newString, 'utf8').toString('base64')
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psEditText(remotePath, oldB64, newB64, replaceAll), { timeoutMs: 120_000 })
      const payload = parseObject<{ error?: string; path?: string; encoding?: string; replacements?: number; size?: number }>(result.stdout)
      if (payload === undefined) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `failed to edit '${remotePath}'`)
      }
      if (payload.error !== undefined) throw new Error(payload.error)
      return {
        path: payload.path ?? remotePath,
        encoding: payload.encoding ?? 'utf8',
        replacements: payload.replacements ?? 0,
        size: payload.size ?? 0,
      }
    })
  }

  // -------------------------------------------------------------- transfer

  /** Upload one local file to a remote path. Defaults to SMB with WinRM fallback. */
  async upload(alias: string, localPath: string, remotePath: string, onProgress?: (progress: TransferProgress) => void, channel: TransferChannel = 'auto'): Promise<{ bytes: number; channel?: TransferChannel }> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    const { readFileSync } = await import('node:fs')
    const data = readFileSync(localPath)
    return this.gate.run(alias, async () => {
      onProgress?.({ phase: 'connecting', file: remotePath, transferred: 0, total: data.length, percent: 0 })
      if (channel !== 'winrm') {
        // Probe 445 first: `net use` takes ~60 s to fail against a host whose
        // SMB is down, and on `auto` that delay landed before every upload.
        if (await smbReachable(entry.host)) {
          try {
            const outcome = await uploadSmb(entry, localPath, remotePath)
            onProgress?.({ phase: 'done', file: remotePath, transferred: outcome.bytes, total: outcome.bytes, percent: 100 })
            return { bytes: outcome.bytes, channel: outcome.channel }
          } catch (error) {
            if (channel === 'smb') throw error
            onProgress?.({ phase: 'connecting', file: remotePath, transferred: 0, total: data.length, percent: 0 })
          }
        } else if (channel === 'smb') {
          throw smbUnavailable(entry.host)
        }
      }
      // WinRM transport: the streaming path moves the file over a single
      // stdin stream (one shell, one Send per 256 KiB). It returns null when
      // the transport it borrows is unavailable, in which case the chunked
      // path still works — just far more slowly.
      const conn = connOf(entry)
      const report = (transferred: number, total: number): void => {
        onProgress?.({ phase: 'transferring', file: remotePath, transferred, total, percent: total > 0 ? Math.round((transferred / total) * 1000) / 10 : 0 })
      }
      let bytes = await uploadStream(conn, remotePath, data, report)
      if (bytes === null) bytes = await uploadBuffer(conn, remotePath, data, report)
      onProgress?.({ phase: 'done', file: remotePath, transferred: bytes, total: bytes, percent: 100 })
      return { bytes, channel: 'winrm' }
    })
  }

  /** Download one remote file to a local path. Defaults to SMB with WinRM fallback. */
  async download(alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void, channel: TransferChannel = 'auto'): Promise<{ bytes: number; channel?: TransferChannel }> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      onProgress?.({ phase: 'connecting', file: remotePath, transferred: 0, total: 0, percent: 0 })
      if (channel !== 'winrm') {
        // Same 445 probe as upload: `net use` has no short timeout of its own.
        if (await smbReachable(entry.host)) {
          try {
            const outcome = await downloadSmb(entry, remotePath, localPath)
            onProgress?.({ phase: 'done', file: remotePath, transferred: outcome.bytes, total: outcome.bytes, percent: 100 })
            return { bytes: outcome.bytes, channel: outcome.channel }
          } catch (error) {
            if (channel === 'smb') throw error
            onProgress?.({ phase: 'connecting', file: remotePath, transferred: 0, total: 0, percent: 0 })
          }
        } else if (channel === 'smb') {
          throw smbUnavailable(entry.host)
        }
      }
      const { open, rm } = await import('node:fs/promises')
      // The destination is opened on the first write rather than up front, so a
      // download that fails its size probe (a path that does not exist, a
      // directory, an unreachable host) does not leave a truncated empty file
      // behind as evidence that it succeeded.
      let sink: Awaited<ReturnType<typeof open>> | null = null
      let completed = false
      let bytes = 0
      // Positional writes: the ranges arrive out of order and each piece knows
      // its own offset, so a sequential stream would need full reassembly in
      // memory first. pwrite keeps memory bounded by one Receive response.
      // Writes are chained rather than fired loose: the handle must not close
      // while a write is still in flight, and chaining bounds the pending work
      // to a single write no matter how large the file is. A rejected write
      // propagates down the chain and surfaces once at the final await.
      let queue: Promise<void> = Promise.resolve()
      const put = (offset: number, data: Buffer): void => {
        bytes += data.length
        queue = queue.then(async () => {
          if (sink === null) sink = await open(localPath, 'w', 0o600)
          const handle = sink
          await handle.write(data, 0, data.length, offset)
        })
        // A failed write must not be reported as an unhandled rejection while
        // the transfer is still running: the rejection is re-raised by the
        // final await below, which is where the caller can act on it.
        void queue.catch(() => undefined)
      }
      const report = (transferred: number, total: number): void => {
        onProgress?.({ phase: 'transferring', file: remotePath, transferred, total, percent: total > 0 ? Math.round((transferred / total) * 1000) / 10 : 0 })
      }
      try {
        const conn = connOf(entry)
        const streamed = await downloadStream(conn, remotePath, put, report)
        if (streamed === null) {
          let offset = 0
          await downloadChunks(
            conn,
            remotePath,
            (b64) => {
              const buffer = Buffer.from(b64, 'base64')
              put(offset, buffer)
              offset += buffer.length
            },
            report,
          )
        }
        await queue
        // A zero-byte remote file produces no writes, so the sink is still
        // unopened; create the file rather than finishing with nothing on disk.
        if (sink === null) sink = await open(localPath, 'w', 0o600)
        completed = true
      } finally {
        // `downloadStream` stops its workers from emitting before it settles,
        // but a write already handed to the queue may still be in flight. Let
        // it finish before the handle closes, or it lands on a closed file as
        // an unhandled rejection that takes the whole process down.
        await queue.catch(() => undefined)
        if (sink !== null) await sink.close()
        // A transfer that failed partway would otherwise leave a truncated file
        // that looks exactly like a finished download. Removing it is safe even
        // though it may have overwritten a previous file, because the 'w' open
        // already truncated that file to nothing.
        if (!completed && sink !== null) await rm(localPath, { force: true }).catch(() => undefined)
      }
      onProgress?.({ phase: 'done', file: remotePath, transferred: bytes, total: bytes, percent: 100 })
      return { bytes, channel: 'winrm' }
    })
  }

  // --------------------------------------------------------------- console

  /** Open a streaming PowerShell console session (standalone connection). */
  async openConsole(alias: string): Promise<ConsoleSession> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    const session = new ConsoleSession(connOf(entry))
    await session.start()
    return session
  }

  // ------------------------------------------------------------------ misc

  /** Probe connectivity. */
  async test(alias: string): Promise<TestResult> {
    const entry = this.store.find(alias)
    if (entry === undefined) return { ok: false, error: `alias '${alias}' not found` }
    return this.gate.run(alias, async () => {
      const result = await testConnection(connOf(entry))
      return result
    })
  }

  /** No pooled resources to close (WinRM is per-call HTTP). */
  dispose(): void {
    // Nothing to tear down: every operation owns its shell lifecycle.
  }
}
