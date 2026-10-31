/**
 * SMB transfer bridge.
 *
 * SMB is the fast channel when the admin share is reachable, so `auto` tries it
 * first and falls back to the WinRM streaming path. This module mounts the
 * remote host's admin share, copies whole files with node:fs, then verifies the
 * SHA-256 on both ends.
 *
 * Two mount shapes, picked by the entry's `smbPort`:
 *
 * - 445 (the default, and the only port Windows listens on out of the box):
 *   `net use \\host\IPC$ <password> /user:<user>` and UNC paths. The password
 *   reaches `net use` as an argument, which is the one place it is visible to
 *   other processes of the same user — `net use` has no credential-object form.
 * - anything else: Windows cannot move the SMB listening port, so a non-445
 *   port means something forwards to 445 (typically `netsh interface portproxy`
 *   on the target, plus a firewall rule). `net use` cannot dial a port, so the
 *   share is mapped with `New-SmbMapping -TcpPort` onto a free drive letter and
 *   the copy runs through that letter. `New-SmbMapping` is only available on
 *   Windows 11 24H2 / Windows Server 2025 and later; the credentials travel in
 *   environment variables and a `PSCredential`, never in the command line.
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import type { WinHostEntry } from './protocol.ts'

/** Per-transfer channel selector. */
export type TransferChannel = 'auto' | 'smb' | 'winrm'

export interface SmbTransferResult {
  bytes: number
  channel: 'smb'
}

/** The SMB port an entry uses; 445 unless the host config says otherwise. */
export function smbPortOf(entry: Pick<WinHostEntry, 'smbPort'>): number {
  return entry.smbPort ?? 445
}

/**
 * Split an absolute Windows path into its drive letter and the rest.
 * `D:\dir\file` -> `{ drive: 'D', tail: 'dir\\file' }`.
 */
function splitDrivePath(remotePath: string): { drive: string; tail: string } {
  const absolute = remotePath.replace(/[\\/]+$/, '')
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute)
  if (match === null) throw new Error('SMB requires an absolute remote path like D:\\dir\\file')
  return { drive: match[1], tail: match[2] }
}

/**
 * Convert a Windows drive path to its UNC admin-share form.
 * D:\\dir\\file -> \\\\host\\D$\\dir\\file
 */
export function adminSharePath(host: string, remotePath: string): string {
  const { drive, tail } = splitDrivePath(remotePath)
  return '\\\\' + host + '\\' + drive + '$' + (tail === '' ? '' : '\\' + tail)
}

/** Run one cmd.exe process; returns output and exit code. */
function runCmd(args: string[], input?: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill() } catch { /* already gone */ }
      settled = true
      resolve({ code: 1, stdout: '', stderr: 'SMB net use timed out' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      resolve({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (code) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * Run one PowerShell process. Secrets go in `env`, never in the script text, so
 * they stay out of the command line other processes can read.
 */
function runPowerShell(
  script: string,
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill() } catch { /* already gone */ }
      settled = true
      resolve({ code: 1, stdout: '', stderr: 'SMB mapping timed out' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      resolve({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (code) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

/** SHA-256 of a local file. */
async function sha256File(localPath: string): Promise<string> {
  return createHash('sha256').update(await readFile(localPath)).digest('hex').toUpperCase()
}

/** SHA-256 of one file addressed by a local path (a UNC or a mapped drive). */
async function hashAtPath(path: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const { stdout } = await execFileAsync('certutil.exe', ['-hashfile', path, 'SHA256'])
  const match = /([0-9A-Fa-f]{64})/.exec(stdout)
  if (match === null) throw new Error('SMB remote hash verification failed: ' + stdout)
  return match[1].toUpperCase()
}

/** Drive letters this process is currently holding mapped. */
const mappedLetters = new Set<string>()

/** First free drive letter for a mapping, or undefined when the set is full. */
function allocateDriveLetter(): string | undefined {
  for (let code = 'Z'.charCodeAt(0); code >= 'P'.charCodeAt(0); code -= 1) {
    const letter = String.fromCharCode(code)
    if (mappedLetters.has(letter)) continue
    if (existsSync(letter + ':\\')) continue
    mappedLetters.add(letter)
    return letter
  }
  return undefined
}

/** A mounted admin share: local path translation plus teardown. */
interface ShareMount {
  /** Local path (UNC or mapped drive) that node:fs can use for a remote path. */
  toLocal(remotePath: string): string
  /** Undo the mount; safe to call once and never throws. */
  dispose(): Promise<void>
}

/**
 * Mount the admin share of the remote drive `drive` (a single letter).
 *
 * @param entry - host entry; its `smbPort` picks the mount shape.
 * @param drive - drive letter of the remote path, e.g. `D`.
 * @param timeoutMs - budget for the mount itself.
 */
async function mountShare(entry: WinHostEntry, drive: string, timeoutMs: number): Promise<ShareMount> {
  const port = smbPortOf(entry)
  const password = entry.auth.password ?? ''
  if (port === 445) {
    const ipc = '\\\\' + entry.host + '\\IPC$'
    const mount = await runCmd(['net', 'use', ipc, password, '/user:' + entry.user], undefined, timeoutMs)
    if (mount.code !== 0) throw new Error('SMB net use failed: ' + (mount.stderr || mount.stdout))
    return {
      toLocal: (remotePath) => adminSharePath(entry.host, remotePath),
      dispose: async () => {
        await runCmd(['net', 'use', ipc, '/delete', '/y'], undefined, 30_000)
      },
    }
  }

  const letter = allocateDriveLetter()
  if (letter === undefined) throw new Error('SMB: every drive letter from P to Z is already in use')
  try {
    const result = await runPowerShell(
      [
        '$ErrorActionPreference = "Stop"',
        'New-SmbMapping -LocalPath $env:DSH_WINRM_SMB_LETTER -RemotePath $env:DSH_WINRM_SMB_REMOTE -TcpPort $env:DSH_WINRM_SMB_PORT -UserName $env:DSH_WINRM_SMB_USER -Password $env:DSH_WINRM_SMB_PASSWORD -ErrorAction Stop | Out-Null',
        'Write-Output "mapped"',
      ].join('; '),
      {
        DSH_WINRM_SMB_PASSWORD: password,
        DSH_WINRM_SMB_USER: entry.user,
        DSH_WINRM_SMB_LETTER: letter + ':',
        DSH_WINRM_SMB_REMOTE: '\\\\' + entry.host + '\\' + drive + '$',
        DSH_WINRM_SMB_PORT: String(port),
      },
      timeoutMs,
    )
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim()
      if (/TcpPort|parameter cannot be found|A parameter cannot be found/i.test(detail)) {
        throw new Error(
          'SMB on port ' + String(port) + ' needs the New-SmbMapping -TcpPort parameter, which requires Windows 11 24H2 or '
          + 'Windows Server 2025 on this machine; use channel "winrm" instead',
        )
      }
      throw new Error('SMB mapping on port ' + String(port) + ' failed: ' + detail)
    }
    return {
      toLocal: (remotePath) => letter + ':\\' + splitDrivePath(remotePath).tail,
      dispose: async () => {
        await runPowerShell(
          'Remove-SmbMapping -LocalPath $env:DSH_WINRM_SMB_LETTER -Force -ErrorAction SilentlyContinue | Out-Null',
          { DSH_WINRM_SMB_LETTER: letter + ':' },
          30_000,
        )
        mappedLetters.delete(letter)
      },
    }
  } catch (cause) {
    mappedLetters.delete(letter)
    throw cause
  }
}

/** How long a reachability verdict is trusted before probing again. */
const SMB_PROBE_TTL_MS = 60_000

/** Budget for the TCP reachability probe; far below `net use`'s own timeout. */
const SMB_PROBE_TIMEOUT_MS = 3_000

const smbProbeCache = new Map<string, { reachable: boolean; at: number }>()

/**
 * Whether the target's SMB port accepts a connection.
 *
 * `net use` has no useful timeout: against a host whose SMB port is filtered or
 * whose SMB service is down it spends a full minute before failing. That minute
 * was being paid on *every* `auto` upload before the WinRM fallback could even
 * start — measured at 61 s and 58 s on the test host, against a 12 s streaming
 * transfer. A bare TCP connect answers the same question in milliseconds.
 *
 * A verdict is cached briefly so a burst of transfers does not re-probe for each
 * one; a positive verdict is cached too, but the mount that follows still
 * reports its own failure if the share turns out to be unmountable.
 *
 * @param host - target hostname or address.
 * @param port - SMB port to probe; the entry's `smbPort`, default 445.
 * @returns true when the port accepted a connection.
 */
export async function smbReachable(host: string, port = 445): Promise<boolean> {
  const key = host + ':' + String(port)
  const cached = smbProbeCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < SMB_PROBE_TTL_MS) return cached.reachable
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), SMB_PROBE_TIMEOUT_MS)
    socket.once('connect', () => { clearTimeout(timer); finish(true) })
    socket.once('error', () => { clearTimeout(timer); finish(false) })
    socket.once('timeout', () => { clearTimeout(timer); finish(false) })
    socket.setTimeout(SMB_PROBE_TIMEOUT_MS)
  })
  smbProbeCache.set(key, { reachable, at: Date.now() })
  return reachable
}

/** Error thrown when SMB was requested or probed and the target is not listening. */
export function smbUnavailable(host: string, port = 445): Error {
  const where = host + ':' + String(port)
  if (port !== 445) {
    return new Error(
      'SMB is not reachable on ' + where + ' (the configured smbPort; whatever forwards that port to the admin share is not '
      + 'answering — check the forward and the firewall rule on the target); '
      + 'retry with channel "winrm" to transfer over WinRM instead',
    )
  }
  return new Error(
    'SMB is not reachable on ' + where + ' (the admin share needs TCP 445 open and the Server service running); '
    + 'retry with channel "winrm" to transfer over WinRM instead',
  )
}

/**
 * Copy one local file to a remote Windows host over SMB, verifying the
 * remote SHA-256 matches the local source.
 */
export async function uploadSmb(entry: WinHostEntry, localPath: string, remotePath: string, timeoutMs = 300_000): Promise<SmbTransferResult> {
  // Reject a non-drive path before touching the network.
  const { drive } = splitDrivePath(remotePath)
  const mount = await mountShare(entry, drive, timeoutMs)
  try {
    const target = mount.toLocal(remotePath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(localPath, target)
    const local = await stat(localPath)
    const localHash = await sha256File(localPath)
    const remoteHash = await hashAtPath(mount.toLocal(remotePath))
    if (remoteHash !== localHash) throw new Error('SMB upload hash mismatch: local ' + localHash + ', remote ' + remoteHash)
    return { bytes: local.size, channel: 'smb' }
  } finally {
    await mount.dispose()
  }
}

/**
 * Copy one remote Windows file to a local path over SMB and verify the local
 * SHA-256 matches the remote source.
 */
export async function downloadSmb(entry: WinHostEntry, remotePath: string, localPath: string, timeoutMs = 300_000): Promise<SmbTransferResult> {
  const { drive } = splitDrivePath(remotePath)
  const mount = await mountShare(entry, drive, timeoutMs)
  try {
    await copyFile(mount.toLocal(remotePath), localPath)
    const local = await stat(localPath)
    const localHash = await sha256File(localPath)
    const remoteHash = await hashAtPath(mount.toLocal(remotePath))
    if (remoteHash !== localHash) throw new Error('SMB download hash mismatch: remote ' + remoteHash + ', local ' + localHash)
    return { bytes: local.size, channel: 'smb' }
  } finally {
    await mount.dispose()
  }
}
