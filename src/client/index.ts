/**
 * Browser-half entry for the dsh-winrm plugin — runs inside the dsh web GUI.
 * Registers locale dictionaries and contributes the "Windows" sidebar entry
 * plus the central operations panel through the shell's slot system: a
 * `sidebar.panellist` list row (icon + label) that selects the keyed `main`
 * panel, and the `main` occupant that renders the tabbed WinRM panel in the
 * center column. This replaces the earlier DOM-injection approach with the
 * first-class extension points the shell now provides. DOM/slot mounting
 * problems are logged, never thrown — an external plugin must not take the
 * GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the keyed `main` slot, the MainPanelId brand, and the ctx.layout merge.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the `sidebar.panellist` list slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WinrmApi } from './api.ts'
import { en, zh, type WinKey } from './locales.ts'
import { WinrmPanel } from './panel/WinrmPanel.tsx'
import { WinrmPanelIcon } from './panel/WinrmPanelIcon.tsx'

/** Locale namespace this plugin owns. */
const NS = 'dsh-winrm'

/** The id shared by the sidebar entry and the main panel it opens. */
const PANEL_ID = 'winrm' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-winrm surface copy. */
    'dsh-winrm': WinKey
  }
}

/** Required services (fiber inject waiting — slots, locale, and layout must be up first). */
export const inject = ['slots', 'locale', 'layout']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { WinrmPanelProps } from './panel/WinrmPanel.tsx'
export type { HostsTabProps } from './panel/HostsTab.tsx'
export type { HostFormDialogProps } from './panel/HostFormDialog.tsx'
export type { ConsoleTabProps } from './panel/ConsoleTab.tsx'
export type { ServicesTabProps } from './panel/ServicesTab.tsx'
export type { ProcessesTabProps } from './panel/ProcessesTab.tsx'
export type { TransferTabProps } from './panel/TransferTab.tsx'
export type { WinKey } from './locales.ts'

/**
 * Contribute the Windows sidebar entry and the tabbed WinRM panel it opens.
 * @param ctx - client root context (locale, slots, layout services).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-winrm: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = new WinrmApi()

  // The panel is a global main-panel occupant: the sidebar entry selects it,
  // and the shell swaps the center column between the Conversation and this
  // keyed occupant. `onBack` returns to the Conversation.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api, onBack: () => { ctx.layout.selectPanel(null) } }),
  }, WinrmPanel))

  // The sidebar row: an icon plus a localized label; selecting it opens the panel.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => t('entry.label'),
    locale: NS,
  }, WinrmPanelIcon))
}
