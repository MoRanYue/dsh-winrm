/**
 * Agent tools: the DSH-native counterpart of the GUI — every tool talks to
 * the same engine the web UI uses, so a host configured in the GUI is
 * immediately operable by any agent, and vice versa.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { boundedHunkDiffs, type RemoteFileDiff } from './diff.ts'
import { READ_DEFAULT_LIMIT, READ_MAX_LIMIT, type WinRmEngine } from './engine.ts'
import type { ClusterResult, ExecResult, WinHostSummary } from './protocol.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Host table render shared by list surfaces. */
function renderHosts(hosts: WinHostSummary[]): string {
  if (hosts.length === 0) return 'no hosts configured'
  // The SMB port only earns a column when some host overrides it.
  const withSmb = hosts.some(host => host.smbPort !== undefined && host.smbPort !== 445)
  const head = ['alias', 'host', 'port', ...(withSmb ? ['smb'] : []), 'user', 'transport', 'environment', 'tags', 'description']
  const rows = hosts.map(host => [
    host.alias,
    host.host,
    String(host.port),
    ...(withSmb ? [String(host.smbPort ?? 445)] : []),
    host.user,
    host.transport,
    host.environment ?? '-',
    (host.tags.length > 0 ? host.tags.join(',') : '-'),
    host.description ?? '',
  ].join(' | '))
  return [head.join(' | '), head.map(() => '---').join(' | '), ...rows].join('\n')
}

/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result: ExecResult): string {
  const marker = result.timedOut
    ? '[timed out]'
    : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== undefined) parts.push('error: ' + result.error)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** Render cluster outcomes compactly. */
function renderCluster(results: ClusterResult[]): string {
  if (results.length === 0) return 'no hosts matched'
  return results.map(result => {
    const status = result.ok ? 'ok' : result.timedOut === true ? 'timed out' : 'failed'
    const tail = result.error !== undefined ? ' (' + result.error + ')' : ''
    return `${result.alias}: ${status} [exit code: ${result.exitCode ?? 'null'}]${tail}`
  }).join('\n')
}

/** The host-list tool. */
export function winrmListTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_list',
    description: 'List configured Windows hosts (alias, host, port, user, transport, environment, tags, description). Use winrm_exec etc. with the alias. ' +
      'Triggers: Windows server, WinRM, PowerShell remote, check server/status, deploy to Windows.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, description, host, and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['password'], required: true },
                transport: { type: 'string', enum: ['http', 'https'], required: true },
                rejectUnauthorized: { type: 'boolean' },
                smbPort: { type: 'integer' },
                description: { type: 'string' },
                environment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                location: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { hosts?: WinHostSummary[] }) => text(renderHosts(value.hosts ?? [])),
    },
    async execute(args) {
      return { hosts: engine.list(args.query) }
    },
  })
}

/** The command-execution tool (PowerShell). */
export function winrmExecTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_exec',
    description: 'Execute a PowerShell command on a configured Windows host by alias. The command runs under PowerShell with UTF-8 output; prefer combining independent read-only queries into one command. ' +
      'Triggers: run command on Windows server, PowerShell remote, check server/status, service control, view logs, any remote Windows operation.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      command: { type: 'string', required: true, description: 'The PowerShell command to run remotely (script body, no powershell.exe wrapper needed).' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 60000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: ExecResult) => text(renderExec(value)),
    },
    async execute(args) {
      return engine.exec(args.alias, args.command, args.timeoutMs)
    },
  })
}

/** The service-management tool. */
export function winrmServiceTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_service',
    description: 'Manage Windows services on a configured host: list all services, or start/stop/restart one and change its startup type. ' +
      'Triggers: service control, start/stop/restart Windows service, check service status, set service startup type.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      name: { type: 'string', description: 'Service name (required for actions; omitted lists all services).' },
      action: { type: 'string', enum: ['list', 'start', 'stop', 'restart', 'set-auto', 'set-manual', 'set-disabled'], description: 'list (default) / start / stop / restart / set-auto / set-manual / set-disabled.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          services: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                displayName: { type: 'string', required: true },
                status: { type: 'string', required: true },
                startMode: { type: 'string', required: true },
                startName: { type: 'string' },
              },
            },
          },
          service: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              displayName: { type: 'string', required: true },
              status: { type: 'string', required: true },
              startMode: { type: 'string', required: true },
              startName: { type: 'string' },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { services?: Array<{ name: string; displayName: string; status: string; startMode: string }>; service?: { name: string; displayName: string; status: string; startMode: string }; error?: string }) => {
        if (value.error !== undefined) return text('service error: ' + value.error)
        if (value.services !== undefined) {
          if (value.services.length === 0) return text('no services')
          return text(['name | displayName | status | startMode', '--- | --- | --- | ---', ...value.services.map(s => `${s.name} | ${s.displayName} | ${s.status} | ${s.startMode}`)].join('\n'))
        }
        if (value.service !== undefined) {
          const s = value.service
          return text(`service ${s.name}: ${s.status} (startMode ${s.startMode}, displayName ${s.displayName})`)
        }
        return text('no result')
      },
    },
    async execute(args) {
      try {
        if (args.name === undefined || args.action === undefined || args.action === 'list') {
          return { services: await engine.listServices(args.alias) }
        }
        const service = await engine.serviceAction(args.alias, args.name, args.action)
        return { service }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The process-management tool. */
export function winrmProcessTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_process',
    description: 'Manage processes on a configured Windows host: list all processes, or kill one by id. ' +
      'Triggers: process list, kill process, check what is running on a Windows server.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      id: { type: 'integer', description: 'Process id (required for kill; omitted lists processes).' },
      action: { type: 'string', enum: ['list', 'kill'], description: 'list (default) / kill.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                name: { type: 'string', required: true },
                cpu: { type: 'number' },
                memMB: { type: 'number' },
                startTime: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          killed: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { processes?: Array<{ id: number; name: string; cpu?: number; memMB?: number; startTime?: string }>; killed?: number; error?: string }) => {
        if (value.error !== undefined) return text('process error: ' + value.error)
        if (value.processes !== undefined) {
          if (value.processes.length === 0) return text('no processes')
          return text(['id | name | cpu | memMB | startTime', '--- | --- | --- | --- | ---', ...value.processes.map(p => `${p.id} | ${p.name} | ${p.cpu ?? ''} | ${p.memMB ?? ''} | ${p.startTime ?? ''}`)].join('\n'))
        }
        return text(`killed process ${value.killed ?? 0}`)
      },
    },
    async execute(args) {
      try {
        if (args.action === 'kill' && args.id !== undefined) {
          await engine.killProcess(args.alias, args.id)
          return { killed: args.id }
        }
        return { processes: await engine.listProcesses(args.alias) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The upload tool. */
export function winrmUploadTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_upload',
    description: 'Upload a local file to a configured Windows host. The bytes go over the SMB admin share when it is reachable, otherwise they are streamed over WinRM in one shell with per-chunk gzip (the 48 KiB base64 chunk path is kept only as a fallback). The local path is on THIS machine (the dsh host). ' +
      'Triggers: upload file to Windows server, deploy artifact, copy config to Windows server.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      localPath: { type: 'string', required: true, description: 'Absolute local file path on this machine.' },
      remotePath: { type: 'string', required: true, description: 'Destination path on the remote host, e.g. C:\\temp\\file.txt (parent dirs are created).' },
      channel: { type: 'string', enum: ['auto', 'smb', 'winrm'], description: 'Transfer channel: auto (default) uses the SMB admin share when the host\'s SMB port answers and otherwise WinRM; smb fails outright when that port is closed; winrm always streams over the WinRS stdin channel.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          transferredBytes: { type: 'integer' },
          channel: { type: 'string', enum: ['smb', 'winrm'] },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; transferredBytes?: number; channel?: string; error?: string }) => text(value.ok
        ? `uploaded ${value.transferredBytes ?? 0} bytes via ${value.channel ?? 'unknown'}`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const outcome = await engine.upload(args.alias, args.localPath, args.remotePath, undefined, args.channel ?? 'auto')
        const usedChannel: 'smb' | 'winrm' = outcome.channel === 'smb' ? 'smb' : 'winrm'
        return { ok: true, transferredBytes: outcome.bytes, channel: usedChannel }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The download tool. */
export function winrmDownloadTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_download',
    description: 'Download a remote FILE from a configured Windows host to a local path on this machine. The bytes come over the SMB admin share when it is reachable, otherwise they are streamed over WinRM as parallel byte ranges (the 48 KiB base64 chunk path is kept only as a fallback). Large files are fine: the WinRM path runs for as long as bytes keep arriving and only fails once a range stalls. Directory download is not supported — download files individually. ' +
      'Triggers: download file from Windows server, fetch remote log/artifact.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      remotePath: { type: 'string', required: true, description: 'Remote file path, e.g. C:\\temp\\file.txt.' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on this machine.' },
      channel: { type: 'string', enum: ['auto', 'smb', 'winrm'], description: 'Transfer channel: auto (default) uses the SMB admin share when the host\'s SMB port answers and otherwise WinRM; smb fails outright when that port is closed; winrm always streams over parallel WinRS byte ranges.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          channel: { type: 'string', enum: ['smb', 'winrm'] },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; bytes?: number; channel?: string; error?: string }) => text(value.ok
        ? `downloaded ${value.bytes ?? 0} bytes via ${value.channel ?? 'unknown'}`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const outcome = await engine.download(args.alias, args.remotePath, args.localPath, undefined, args.channel ?? 'auto')
        const usedChannel: 'smb' | 'winrm' = outcome.channel === 'smb' ? 'smb' : 'winrm'
        return { ok: true, bytes: outcome.bytes, channel: usedChannel }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The cluster tool. */
export function winrmClusterTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_cluster',
    description: 'Run one PowerShell command concurrently across many Windows hosts (all hosts, or filtered by aliases / environment / tags). ' +
      'Triggers: run on all Windows servers, batch operation, production servers, cluster command.',
    parameters: {
      command: { type: 'string', required: true, description: 'The PowerShell command to run on every matched host.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Explicit alias list; when absent every configured host matches.' },
      environment: { type: 'string', description: 'Only hosts with this environment label.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only hosts carrying ALL these tags.' },
      timeoutMs: { type: 'integer', description: 'Per-host timeout in milliseconds.' },
      maxWorkers: { type: 'integer', description: 'Concurrency cap (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { results?: ClusterResult[] }) => text(renderCluster(value.results ?? [])),
    },
    async execute(args) {
      return { results: await engine.cluster(args) }
    },
  })
}

/** Render a read window in the numbered envelope the local read tool uses. */
function renderWindow(window: {
  path?: string
  offset?: number
  lines?: Array<{ number: number; text: string }>
  totalLines?: number
  encoding?: string
  truncatedByBytes?: boolean
}): string {
  const lines = window.lines ?? []
  const offset = window.offset ?? 1
  const total = window.totalLines ?? 0
  const last = offset + lines.length - 1
  const body = lines.map(line => `${line.number}: ${line.text}`).join('\n')
  // Only a non-UTF-8 file needs saying: that is when a later write would
  // otherwise replace the encoding without the caller noticing.
  const encoding = window.encoding !== undefined && window.encoding !== 'utf8'
    ? `, encoding ${window.encoding}`
    : ''
  let footer: string
  if (lines.length === 0) {
    footer = total === 0
      ? `(End of file - total 0 lines${encoding})`
      : `(No lines at offset ${offset}; the file has ${total} lines${encoding}.)`
  } else if (window.truncatedByBytes === true) {
    footer = `(Showing lines ${offset}-${last} of ${total}${encoding}. The window stopped at the byte budget — continue with offset=${last + 1}.)`
  } else if (last < total) {
    footer = `(Showing lines ${offset}-${last} of ${total}${encoding}. Continue with offset=${last + 1}.)`
  } else {
    footer = `(End of file - total ${total} lines${encoding})`
  }
  const content = body === '' ? footer : `${body}\n\n${footer}`
  return [`<path>${window.path ?? ''}</path>`, '<type>file</type>', '<content>', content, '</content>'].join('\n')
}

/** The remote read tool: a line-numbered window of a text file on the target. */
export function winrmReadTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_read',
    description: 'Read a text file ON A REMOTE Windows host and return its content line-numbered. The path is on the Windows host, not this machine — use `read` for local files. Decodes UTF-8 (with or without BOM) and UTF-16 with a BOM, and refuses binary files instead of returning mojibake. Page through large files with offset and limit. ' +
      'Triggers: read file on Windows server, inspect remote config/log/script.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      remotePath: { type: 'string', required: true, description: 'Path on the remote host, e.g. C:\\temp\\app.log.' },
      offset: { type: 'integer', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'integer', description: `Maximum lines to return (default ${READ_DEFAULT_LIMIT}, max ${READ_MAX_LIMIT}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          offset: { type: 'integer' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer' },
          encoding: { type: 'string' },
          truncatedByBytes: { type: 'boolean' },
          truncatedLines: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; path?: string; offset?: number; lines?: Array<{ number: number; text: string }>; totalLines?: number; encoding?: string; truncatedByBytes?: boolean; error?: string }) => text(value.ok
        ? renderWindow(value)
        : `read failed: ${value.error ?? 'unknown error'}`),
      // The GUI draws a read card from this; the model-facing text above stays
      // the fallback for a client without the card.
      presentationMeta: (args, value: { ok: boolean; path?: string; offset?: number; lines?: Array<{ number: number; text: string }>; totalLines?: number; encoding?: string; truncatedByBytes?: boolean; truncatedLines?: number; error?: string }) => (value.ok
        ? {
            card: 'winrm-read',
            path: value.path ?? args.remotePath,
            offset: value.offset ?? 1,
            lines: value.lines ?? [],
            totalLines: value.totalLines ?? 0,
            encoding: value.encoding ?? 'utf8',
            truncatedByBytes: value.truncatedByBytes === true,
            truncatedLines: value.truncatedLines ?? 0,
            // Every arm carries the same keys: the metadata is typed against a
            // JSON index signature, where an arm-specific optional key would
            // widen to `undefined` and stop satisfying it.
            error: '',
          }
        : {
            card: 'winrm-read',
            path: args.remotePath,
            offset: 0,
            lines: [],
            totalLines: 0,
            encoding: '',
            truncatedByBytes: false,
            truncatedLines: 0,
            error: value.error ?? 'unknown error',
          }),
    },
    async execute(args) {
      const offset = Math.max(1, Math.trunc(args.offset ?? 1))
      const limit = Math.min(READ_MAX_LIMIT, Math.max(1, Math.trunc(args.limit ?? READ_DEFAULT_LIMIT)))
      try {
        const window = await engine.readFile(args.alias, args.remotePath, offset, limit)
        return { ok: true, ...window }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The remote write tool: replace a whole text file on the target. */
export function winrmWriteTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_write',
    description: 'Write a text file ON A REMOTE Windows host, creating parent directories and overwriting any existing file. The path is on the Windows host, not this machine — use `write` for local files, and prefer winrm_edit when only part of an existing file changes. Line endings are sent verbatim, so include \\r\\n for a Windows-native file. The encoding is whatever `encoding` asks for — rewriting an existing utf16le or utf8bom file without setting it converts the file to plain UTF-8; `winrm_read` names a non-UTF-8 file in its footer when you need to match one. ' +
      'Triggers: write file on Windows server, create remote script/config, overwrite remote file.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      remotePath: { type: 'string', required: true, description: 'Destination path on the remote host, e.g. C:\\temp\\script.ps1 (parent dirs are created).' },
      content: { type: 'string', required: true, description: 'Full file content.' },
      encoding: { type: 'string', enum: ['utf8', 'utf8bom', 'utf16le'], description: 'Byte-order mark to emit: utf8 (default, no BOM), utf8bom, or utf16le (PowerShell 5.1 reads a BOM-less script as ANSI, so non-ASCII script text needs a BOM). Does not preserve the existing file\'s encoding — pass it explicitly when overwriting a UTF-16 or BOM-carrying file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'update'] },
          bytes: { type: 'integer' },
          encoding: { type: 'string', enum: ['utf8', 'utf8bom', 'utf16le'] },
          diffs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                oldText: { type: 'string', required: true },
                newText: { type: 'string', required: true },
              },
            },
          },
          beyondBasis: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; path?: string; operation?: string; bytes?: number; error?: string }) => text(value.ok
        ? [`<path>${value.path ?? ''}</path>`, '<type>file</type>', '<content>', `${value.operation === 'update' ? 'Updated' : 'Created'} file (${value.bytes ?? 0} bytes)`, '</content>'].join('\n')
        : `write failed: ${value.error ?? 'unknown error'}`),
      presentationMeta: (args, value: { ok: boolean; path?: string; operation?: 'create' | 'update'; bytes?: number; encoding?: string; diffs?: RemoteFileDiff[]; beyondBasis?: boolean; error?: string }) => (value.ok
        ? {
            card: 'winrm-write',
            path: value.path ?? args.remotePath,
            operation: value.operation ?? 'update',
            bytes: value.bytes ?? 0,
            encoding: value.encoding ?? 'utf8',
            diffs: value.diffs ?? [],
            beyondBasis: value.beyondBasis === true,
            error: '',
          }
        : {
            card: 'winrm-write',
            path: args.remotePath,
            operation: 'update' as const,
            bytes: 0,
            encoding: '',
            diffs: [],
            beyondBasis: false,
            error: value.error ?? 'unknown error',
          }),
    },
    async execute(args) {
      try {
        const outcome = await engine.writeFile(args.alias, args.remotePath, args.content, args.encoding ?? 'utf8')
        // A create compares against nothing, so its whole content is one
        // insertion hunk; an update whose prior text was past the basis cap
        // reports the path without hunks rather than a misleading full rewrite.
        const diffs = outcome.before !== null
          ? boundedHunkDiffs(outcome.path, outcome.before, outcome.after)
          : outcome.operation === 'create'
            ? boundedHunkDiffs(outcome.path, '', outcome.after)
            : []
        return {
          ok: true,
          path: outcome.path,
          operation: outcome.operation,
          bytes: outcome.bytes,
          encoding: outcome.encoding,
          diffs,
          beyondBasis: outcome.operation === 'update' && outcome.before === null,
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The remote edit tool: replace an exact string inside a file on the target. */
export function winrmEditTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_edit',
    description: 'Replace an exact string in a text file ON A REMOTE Windows host, preserving the file encoding. The path is on the Windows host, not this machine — use `edit` for local files. `oldString` must match the file byte for byte, including indentation and line endings, and must be unique unless `replaceAll` is set; read the file with winrm_read first. ' +
      'Triggers: edit file on Windows server, patch remote config, change remote script.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      remotePath: { type: 'string', required: true, description: 'Path on the remote host, e.g. C:\\temp\\app.config.' },
      oldString: { type: 'string', required: true, description: 'Exact text to replace. Must not be empty.' },
      newString: { type: 'string', required: true, description: 'Replacement text. Must differ from oldString.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          encoding: { type: 'string' },
          replacements: { type: 'integer' },
          size: { type: 'integer' },
          diffs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                oldText: { type: 'string', required: true },
                newText: { type: 'string', required: true },
              },
            },
          },
          beyondBasis: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; path?: string; replacements?: number; size?: number; error?: string }) => text(value.ok
        ? ((value.replacements ?? 0) > 1
          ? `The file ${value.path ?? ''} has been updated. All ${value.replacements ?? 0} occurrences were successfully replaced.`
          : `The file ${value.path ?? ''} has been updated successfully.`)
        : `edit failed: ${value.error ?? 'unknown error'}`),
      presentationMeta: (args, value: { ok: boolean; path?: string; replacements?: number; size?: number; encoding?: string; diffs?: RemoteFileDiff[]; beyondBasis?: boolean; error?: string }) => (value.ok
        ? {
            card: 'winrm-edit',
            path: value.path ?? args.remotePath,
            replacements: value.replacements ?? 0,
            size: value.size ?? 0,
            encoding: value.encoding ?? 'utf8',
            diffs: value.diffs ?? [],
            beyondBasis: value.beyondBasis === true,
            error: '',
          }
        : {
            card: 'winrm-edit',
            path: args.remotePath,
            replacements: 0,
            size: 0,
            encoding: '',
            diffs: [],
            beyondBasis: false,
            error: value.error ?? 'unknown error',
          }),
    },
    async execute(args) {
      try {
        const outcome = await engine.editFile(args.alias, args.remotePath, args.oldString, args.newString, args.replaceAll ?? false)
        // The edit fragment returns both texts only when the file was inside the
        // basis cap; otherwise the card reports the path and the count alone.
        const diffs = outcome.before !== null && outcome.after !== null
          ? boundedHunkDiffs(outcome.path, outcome.before, outcome.after)
          : []
        return {
          ok: true,
          path: outcome.path,
          encoding: outcome.encoding,
          replacements: outcome.replacements,
          size: outcome.size,
          diffs,
          beyondBasis: outcome.before === null,
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
