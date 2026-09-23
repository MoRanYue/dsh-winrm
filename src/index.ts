/**
 * dsh-winrm — host half. Mounts the WinRM engine (per-call PowerShell
 * execution with a UTF-8 envelope, streaming console, service/process
 * management, base64-chunked file transfer, cluster), the /api/dsh-winrm
 * route family plus the console WebSocket upgrade, the agent tools
 * (winrm_list, winrm_exec, winrm_service, winrm_process, winrm_upload,
 * winrm_download, winrm_cluster), and a system-prompt announcement. The
 * browser half (./client) renders the host manager and operations panel.
 * Everything rides official NPM SDK packages — no dsh source changes.
 *
 * Config is read live through `Volatile` references (`.get()`), so the
 * Settings page can flip `enabled` / `announceToAgent` without remounting;
 * `loader/volatile-update` re-runs the registration sync when they change.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the loader's Events merge (`loader/volatile-update`).
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { WinRmEngine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { HostStore } from './store.ts'
import {
  winrmClusterTool,
  winrmDownloadTool,
  winrmExecTool,
  winrmListTool,
  winrmProcessTool,
  winrmServiceTool,
  winrmUploadTool,
} from './tools.ts'
import { mountOnce } from './mount-once.ts'

/** Stable cordis plugin name. */
export const name = 'winrm'

/** Services required before the WinRM surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Plugin config, validated by the same-named schemastery schema. Live fields are `Volatile`. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin to every agent. */
  announceToAgent?: Volatile<boolean>
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: Volatile<boolean>
}

export const Config = z.object({
  announceToAgent: z.boolean().default(true).volatile(),
  enabled: z.boolean().default(true).volatile(),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = true

/** Schema default for the master switch. */
const DEFAULT_ENABLED = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 151

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const WINRM_GUIDANCE = '本机已安装 dsh-winrm 插件（DSH 远程 Windows 运维，WinRM/PowerShell Remoting）：侧边栏「Windows」入口；仿照 dsh-ssh 插件开发。能力：主机配置存 ~/.dsh/dsh-winrm.json（GUI 配置后 agent 方可使用）；winrm_list 列出主机、winrm_exec 执行 PowerShell 命令（UTF-8 信封，中文不乱码）、winrm_service 服务管理（start/stop/restart/启动类型）、winrm_process 进程管理（list/kill）、winrm_upload/winrm_download 文件传输（base64 分块，无 SMB 依赖）、winrm_cluster 集群并发执行；Web 控制台走 WebSocket。认证：通过原生 Node.js WinRM 客户端（winrm-client）的 NTLM/Negotiate 与 Basic 实现，兼容本地账户与域账户；传输支持 http(5985)/https(5986)。前提：目标机需启用 WinRM（scripts/enable-winrm.ps1），本机无需 Python —— WinRM 走纯 Node 依赖。HTTP 仅建议受信内网使用；密码以明文存在用户主目录私有文件（权限 0600）；命令输出可能含敏感信息；传输/执行消耗真实远程资源，先确认再操作。用户提到「Windows 服务器 / WinRM / PowerShell 远程 / 服务管理 / 进程管理」时即指本插件，请据此协作。'

/**
 * Mount the WinRM engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (volatile fields read via `.get()`).
 */
export const apply = mountOnce('dsh-winrm', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const resolve = (): { announceToAgent: boolean; enabled: boolean } => ({
    announceToAgent: config?.announceToAgent?.get() ?? DEFAULT_ANNOUNCE,
    enabled: config?.enabled?.get() ?? DEFAULT_ENABLED,
  })

  const store = new HostStore()
  const engine = new WinRmEngine(store)

  const { routes, upgrade } = makeRoutes({ store, engine })
  const tools = [
    winrmListTool(engine),
    winrmExecTool(engine),
    winrmServiceTool(engine),
    winrmProcessTool(engine),
    winrmUploadTool(engine),
    winrmDownloadTool(engine),
    winrmClusterTool(engine),
  ]

  let disposeSection: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeTools: (() => void) | undefined

  const registerRoutes = (): (() => void) => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
    return () => {
      for (const dispose of disposers) dispose()
      upgradeDisposer()
    }
  }
  const registerTools = (): (() => void) => {
    const disposers = tools.map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }

  const sync = (): void => {
    disposeSection?.(); disposeSection = undefined
    disposeRoutes?.(); disposeRoutes = undefined
    disposeTools?.(); disposeTools = undefined
    const value = resolve()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-winrm',
        order: SECTION_ORDER,
        text: WINRM_GUIDANCE,
      })
    }
    disposeRoutes = registerRoutes()
    disposeTools = registerTools()
  }

  // Volatile config edits land on the running references, then notify the
  // owning fiber here — re-sync the registrations against the new values.
  ctx.on('loader/volatile-update', sync)

  // Single teardown: dispose whatever the latest sync left registered.
  ctx.effect(() => () => {
    disposeSection?.()
    disposeRoutes?.()
    disposeTools?.()
    engine.dispose()
  }, 'dsh-winrm: teardown')

  sync()
}
