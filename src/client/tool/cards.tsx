/**
 * Transcript cards for `winrm_read`, `winrm_write` and `winrm_edit`.
 *
 * Without these the three tools render as the generic tool row, so the user
 * reads the same envelope text the model reads. Every call becomes a collapsed
 * disclosure with a one-line header — file-type icon, verb, remote path — that
 * expands into a card. The header is drawn from the first dispatch, so settling
 * only fills in the trailing figure instead of replacing the row: the line the
 * user watched while it ran is the line they click to open the result.
 *
 * Collapsed by default is the harness's own convention for these rows: a long
 * file would otherwise fill the transcript before the user asked for it.
 *
 * The header is `DisclosureRow` and the body is `ReadBlock` / `DiffBlock`, all
 * from the harness's published `ui-primitives`, so a remote file looks and
 * behaves exactly like a local one. Open state comes from the `useDisclosure`
 * hook the Tool layer hands every toolview, which also resets it when the
 * enclosing turn re-renders.
 * @module dsh-winrm/src/client/tool/cards
 */
import type { ReactNode } from 'react'
import {
  DiffBlock, DisclosureRow, FileTypeIcon, ReadBlock,
  type DiffBlockLabels, type DiffHunk, type ReadBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
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

/** One-line row for a call that failed: the message replaces the card. */
function Row(props: { title: string; detail: string }) {
  return (
    <div className={css.rowError}>
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

/**
 * The remote path a call named, read from its arguments.
 *
 * Available from the first dispatch onward, which is what keeps the header line
 * stable across the running → settled transition: the row keeps saying which
 * file it is working on instead of swapping its text when the result lands. A
 * settled node carries the call head under `call`; a running one is the head.
 * @param block - any phase of the Tool block.
 * @returns the authored path, or undefined when none was named yet.
 */
function argsPath(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const record = block as { argsRaw?: unknown; call?: { argsRaw?: unknown } | null }
  const head = record.call ?? record
  if (typeof head.argsRaw !== 'string' || head.argsRaw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(head.argsRaw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const path = (parsed as { remotePath?: unknown }).remotePath
  return typeof path === 'string' && path !== '' ? path : undefined
}

/** Count the lines a hunk adds and removes. */
function changedLines(card: DiffCardModel): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of card.hunks) {
    added += hunk.newText === '' ? 0 : hunk.newText.split('\n').length
    removed += hunk.oldText === '' ? 0 : hunk.oldText.split('\n').length
  }
  return { added, removed }
}

/** The `+n -m` figure a collapsed write or edit row shows beside its path. */
function changedTotals(card: DiffCardModel): { added: number; removed: number } | undefined {
  const totals = changedLines(card)
  return totals.added === 0 && totals.removed === 0 ? undefined : totals
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

/**
 * One collapsed file row that expands into a card.
 * @param props - the disclosure state, the header material, and the card body.
 * @returns the disclosure row, body included only while expanded.
 */
function FileDisclosure(props: {
  path: string
  title: string
  meta?: string | undefined
  diff?: { added: number; removed: number } | undefined
  open: boolean
  expandable: boolean
  running?: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const meta = props.meta ?? ''
  const hasPath = props.path !== ''
  return (
    <div className={css.wrap}>
      <DisclosureRow
        icon={<FileTypeIcon path={props.path} size={14} />}
        title={props.title}
        open={props.open}
        expandable={props.expandable}
        running={props.running ?? false}
        expandOnRowClick={props.expandable}
        onToggle={props.onToggle}
        collapsedContent={hasPath || meta !== '' ? (
          <>
            {hasPath && <span className={css.sep} aria-hidden />}
            {hasPath && <span className={css.summary}>{props.path}</span>}
            {meta !== '' && <span className={css.meta}>{meta}</span>}
            {props.diff !== undefined && (
              <span className={css.diffStat}>
                <span className={css.added}>{`+${props.diff.added}`}</span>{' '}
                <span className={css.removed}>{`-${props.diff.removed}`}</span>
              </span>
            )}
          </>
        ) : undefined}
      >
        {props.children}
      </DisclosureRow>
    </div>
  )
}

/** Render the settled read card. */
function ReadView(props: { card: ReadCardModel; open: boolean; onToggle: () => void }) {
  const { card, open, onToggle } = props
  const notes: string[] = []
  if (card.truncatedByBytes) notes.push(tt('tool.truncatedByBytes'))
  if (card.truncatedLines > 0) notes.push(tt('tool.truncatedLines', { count: card.truncatedLines }))
  if (card.encoding !== 'utf8') notes.push(card.encoding)
  return (
    <FileDisclosure
      path={card.path}
      title={tt('tool.read')}
      meta={tt('tool.lines', { count: card.totalLines })}
      open={open}
      expandable
      onToggle={onToggle}
    >
      <ReadBlock
        label={card.path}
        lines={card.lines}
        totalLines={card.totalLines}
        lang={langOf(card.path)}
        labels={readLabels()}
        maxLines={CHAT_READ_MAX_LINES}
      />
      {notes.length > 0 && <div className={css.note}>{notes.join(' · ')}</div>}
    </FileDisclosure>
  )
}

/** Render the settled write or edit card. */
function DiffView(props: { card: DiffCardModel; open: boolean; onToggle: () => void }) {
  const { card, open, onToggle } = props
  // The primitive takes `oldText: null` to mean "no prior content", which is a
  // create; the host writes '' for that case so the two stay JSON-friendly.
  const diffs: DiffHunk[] = card.hunks.map(hunk => ({
    path: card.path,
    oldText: hunk.oldText === '' ? null : hunk.oldText,
    newText: hunk.newText,
  }))
  return (
    <FileDisclosure
      path={card.path}
      title={tt(card.tool === 'write' ? 'tool.write' : 'tool.edit')}
      diff={changedTotals(card)}
      open={open}
      expandable={diffs.length > 0}
      onToggle={onToggle}
    >
      {diffs.length > 0 && (
        <DiffBlock diffs={diffs} labels={diffLabels()} maxLines={CHAT_DIFF_MAX_LINES} />
      )}
      <div className={css.note}>{diffSummary(card)}</div>
    </FileDisclosure>
  )
}

/** Shared driver: one card per stage, with the model built from the metadata. */
function FileCardView(props: WinrmFileCardProps & { tool: 'read' | 'write' | 'edit' }) {
  const { phase, block, tool, useDisclosure } = props
  const disclosure = useDisclosure()
  const title = tt(`tool.${tool}`)
  const path = argsPath(block) ?? ''
  if (phase !== 'result') {
    return (
      <FileDisclosure
        path={path}
        title={title}
        meta={path === '' ? tt('tool.running') : undefined}
        open={false}
        expandable={false}
        running
        onToggle={() => {}}
      >
        {null}
      </FileDisclosure>
    )
  }
  const meta = metaOf(block)
  const card = tool === 'read' ? readCard(meta, path) : diffCard(meta, path, tool)
  if (card === undefined) {
    return (
      <FileDisclosure
        path={path}
        title={title}
        meta={tt('tool.noDetail')}
        open={false}
        expandable={false}
        onToggle={() => {}}
      >
        {null}
      </FileDisclosure>
    )
  }
  if (card.kind === 'error') return <Row title={title} detail={card.message} />
  if (card.kind === 'read') {
    return <ReadView card={card} open={disclosure.expanded} onToggle={disclosure.toggle} />
  }
  return <DiffView card={card} open={disclosure.expanded} onToggle={disclosure.toggle} />
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
