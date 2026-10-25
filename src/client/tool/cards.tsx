/**
 * Transcript cards for `winrm_read`, `winrm_write` and `winrm_edit`.
 *
 * Without these the three tools render as the generic tool row, so the user
 * reads the same envelope text the model reads. The bodies come from the
 * harness's own `ReadBlock` and `DiffBlock` primitives — the same components its
 * `read` and `write`/`edit` rows draw — so a remote file looks exactly like a
 * local one. Only the one-line running, error and note rows are authored here:
 * the row chrome around those primitives (`ToolRow`) is not part of the
 * published `ui-tool` surface, and the primitives already draw the path banner.
 * @module dsh-winrm/src/client/tool/cards
 */
import { DiffBlock, ReadBlock, type DiffBlockLabels, type DiffHunk, type ReadBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { tt } from '../panel/helpers.ts'
import { diffCard, readCard, type DiffCard as DiffCardModel, type ReadCard as ReadCardModel } from './card-model.ts'
import css from './cards.module.css'

/** The Tool view props these cards read. */
export type WinrmFileCardProps = ToolCallViewProps

/**
 * Content lines a transcript card shows before the primitive collapses the
 * middle. Half the primitive's own default (16), because a chat row summarizes
 * inside a message flow while a dedicated panel is the reading surface. Mirrors
 * the harness's `CHAT_READ_MAX_LINES` / `CHAT_DIFF_MAX_LINES`.
 */
const CHAT_READ_MAX_LINES = 8
const CHAT_DIFF_MAX_LINES = 9

/** Grammar hint from a remote path's extension; unknown extensions stay plain. */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  bat: 'bat', cmd: 'bat', ps1: 'powershell', psd1: 'powershell', psm1: 'powershell',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  css: 'css', scss: 'scss', less: 'less',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'jsonc', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'markdown', markdown: 'markdown', rst: 'rst',
  py: 'python', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', xml: 'xml', html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  diff: 'diff', patch: 'diff', csv: 'csv', tsv: 'tsv',
}

/**
 * Guess the grammar hint from a path's extension.
 * @param path - the remote path as authored.
 * @returns the language id, or undefined to keep the block plain.
 */
function langOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = path.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}

/** Localized chrome for {@link ReadBlock}. */
function readLabels(): ReadBlockLabels {
  return {
    codeLabel: tt('tool.codeLabel'),
    wrapLabel: tt('tool.wrapLabel'),
    unwrapLabel: tt('tool.unwrapLabel'),
    window: (shown, total) => tt('tool.window', { shown, total }),
    copy: tt('tool.copy'),
    copied: tt('tool.copied'),
    collapseAria: tt('tool.collapseAria'),
    expandAria: hidden => tt('tool.expandAria', { hidden }),
    collapse: tt('tool.collapse'),
    expand: hidden => tt('tool.expand', { hidden }),
  }
}

/** Localized chrome for {@link DiffBlock}. */
function diffLabels(): DiffBlockLabels {
  return {
    codeLabel: tt('tool.codeLabel'),
    wrapLabel: tt('tool.wrapLabel'),
    unwrapLabel: tt('tool.unwrapLabel'),
    copy: tt('tool.copy'),
    copied: tt('tool.copied'),
    collapseAria: tt('tool.collapseAria'),
    expandAria: hidden => tt('tool.expandAria', { hidden }),
    collapse: tt('tool.collapse'),
    expand: hidden => tt('tool.expand', { hidden }),
  }
}

/** One-line row: what a call looks like before it settles, or when it has no card. */
function Row(props: { tone: 'muted' | 'error'; title: string; detail: string }) {
  return (
    <div className={props.tone === 'error' ? css.rowError : css.row}>
      <span className={css.title}>{props.title}</span>
      {props.detail !== '' && <span className={css.detail}>{props.detail}</span>}
    </div>
  )
}

/** Read the persisted metadata off a settled result node. */
function metaOf(block: unknown): unknown {
  if (typeof block !== 'object' || block === null) return undefined
  return (block as { meta?: unknown }).meta
}

/** The summary line a write or edit card shows under its diff. */
function diffSummary(card: DiffCardModel): string {
  const parts: string[] = []
  if (card.tool === 'write') {
    parts.push(tt(card.operation === 'create' ? 'tool.created' : 'tool.updated', { bytes: card.bytes }))
  } else {
    parts.push(tt('tool.replacements', { count: card.replacements }))
  }
  if (card.encoding !== 'utf8') parts.push(card.encoding)
  if (card.beyondBasis) parts.push(tt('tool.beyondBasis'))
  return parts.join(' · ')
}

/** Render the settled read card. */
function ReadView(props: { card: ReadCardModel }) {
  const { card } = props
  const notes: string[] = []
  if (card.truncatedByBytes) notes.push(tt('tool.truncatedByBytes'))
  if (card.truncatedLines > 0) notes.push(tt('tool.truncatedLines', { count: card.truncatedLines }))
  return (
    <>
      <ReadBlock
        label={card.path}
        lines={card.lines}
        totalLines={card.totalLines}
        lang={langOf(card.path)}
        labels={readLabels()}
        maxLines={CHAT_READ_MAX_LINES}
      />
      {notes.length > 0 && <div className={css.note}>{notes.join(' · ')}</div>}
    </>
  )
}

/** Render the settled write or edit card. */
function DiffView(props: { card: DiffCardModel }) {
  const { card } = props
  // The primitive takes `oldText: null` to mean "no prior content", which is a
  // create; the host writes '' for that case so the two stay JSON-friendly.
  const diffs: DiffHunk[] = card.hunks.map(hunk => ({
    path: card.path,
    oldText: hunk.oldText === '' ? null : hunk.oldText,
    newText: hunk.newText,
  }))
  return (
    <>
      {diffs.length > 0 && (
        <DiffBlock diffs={diffs} labels={diffLabels()} maxLines={CHAT_DIFF_MAX_LINES} />
      )}
      <div className={css.note}>{diffSummary(card)}</div>
    </>
  )
}

/** Shared driver: one card per stage, with the model built from the metadata. */
function FileCardView(props: WinrmFileCardProps & { tool: 'read' | 'write' | 'edit' }) {
  const { phase, block, tool } = props
  const title = tt(`tool.${tool}`)
  if (phase !== 'result') return <Row tone="muted" title={title} detail={tt('tool.running')} />
  const meta = metaOf(block)
  const card = tool === 'read' ? readCard(meta, '') : diffCard(meta, '', tool)
  if (card === undefined) return <Row tone="muted" title={title} detail={tt('tool.noDetail')} />
  if (card.kind === 'error') return <Row tone="error" title={title} detail={card.message} />
  if (card.kind === 'read') return <ReadView card={card} />
  return <DiffView card={card} />
}

/** Card for `winrm_read`. */
export function WinrmReadCard(props: WinrmFileCardProps) {
  return <FileCardView {...props} tool="read" />
}

/** Card for `winrm_write`. */
export function WinrmWriteCard(props: WinrmFileCardProps) {
  return <FileCardView {...props} tool="write" />
}

/** Card for `winrm_edit`. */
export function WinrmEditCard(props: WinrmFileCardProps) {
  return <FileCardView {...props} tool="edit" />
}
