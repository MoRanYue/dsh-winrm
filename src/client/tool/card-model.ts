/**
 * Card models for the three remote file tools.
 *
 * The host projects a small JSON payload through `output.presentationMeta` and
 * the session log persists it; these functions narrow that unknown payload into
 * something the card components can hand to the harness's `ReadBlock` and
 * `DiffBlock` primitives. Kept apart from the components so the narrowing can be
 * unit tested without a DOM.
 * @module dsh-winrm/src/client/tool/card-model
 */

/** One line of a read window. */
export interface ReadCardLine {
  number: number
  text: string
}

/** A completed `winrm_read`: a line-numbered window of a remote file. */
export interface ReadCard {
  kind: 'read'
  path: string
  offset: number
  lines: ReadCardLine[]
  totalLines: number
  encoding: string
  truncatedByBytes: boolean
  truncatedLines: number
}

/** One hunk of a remote write or edit, in the primitive's own shape. */
export interface DiffHunk {
  /** Prior fragment including shared context; `''` when the hunk had no prior content. */
  oldText: string
  /** Resulting fragment including the same shared context. */
  newText: string
}

/** A completed `winrm_write` or `winrm_edit`: the changes it applied. */
export interface DiffCard {
  kind: 'diff'
  /** Which tool produced it, so the header can name the operation. */
  tool: 'write' | 'edit'
  path: string
  operation: 'create' | 'update'
  bytes: number
  size: number
  replacements: number
  encoding: string
  hunks: DiffHunk[]
  /** True when the previous text was past the basis cap, so no hunks exist. */
  beyondBasis: boolean
}

/** A failed call: keeps the path and the message, drops card-specific detail. */
export interface ErrorCard {
  kind: 'error'
  path: string
  message: string
}

/** Any card these tools render. */
export type FileCard = ReadCard | DiffCard | ErrorCard

/** Read one string field, falling back when it is absent or the wrong type. */
function str(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

/** Read one finite number field, falling back when it is absent or not numeric. */
function num(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read one boolean field, defaulting to `false`. */
function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Narrow a `winrm_read` metadata payload into a card.
 * @param meta - the persisted payload, of unknown shape.
 * @param fallbackPath - the authored path, used when the payload omits one.
 * @returns the card, or `undefined` when the payload is not a read card.
 */
export function readCard(meta: unknown, fallbackPath: string): FileCard | undefined {
  const source = record(meta)
  if (source === undefined || source.card !== 'winrm-read') return undefined
  const path = str(source, 'path', fallbackPath)
  const error = str(source, 'error', '')
  if (error !== '') return { kind: 'error', path, message: error }
  const rawLines = Array.isArray(source.lines) ? source.lines : []
  const lines: ReadCardLine[] = []
  for (const entry of rawLines) {
    const line = record(entry)
    if (line === undefined) continue
    lines.push({ number: num(line, 'number', lines.length + 1), text: str(line, 'text', '') })
  }
  return {
    kind: 'read',
    path,
    offset: num(source, 'offset', 1),
    lines,
    totalLines: num(source, 'totalLines', lines.length),
    encoding: str(source, 'encoding', 'utf8'),
    truncatedByBytes: bool(source, 'truncatedByBytes'),
    truncatedLines: num(source, 'truncatedLines', 0),
  }
}

/**
 * Narrow a `winrm_write` / `winrm_edit` metadata payload into a card.
 * @param meta - the persisted payload, of unknown shape.
 * @param fallbackPath - the authored path, used when the payload omits one.
 * @param tool - which tool produced the payload.
 * @returns the card, or `undefined` when the payload belongs to another card.
 */
export function diffCard(meta: unknown, fallbackPath: string, tool: 'write' | 'edit'): FileCard | undefined {
  const source = record(meta)
  if (source === undefined || source.card !== `winrm-${tool}`) return undefined
  const path = str(source, 'path', fallbackPath)
  const error = str(source, 'error', '')
  if (error !== '') return { kind: 'error', path, message: error }
  const rawDiffs = Array.isArray(source.diffs) ? source.diffs : []
  const hunks: DiffHunk[] = []
  for (const entry of rawDiffs) {
    const hunk = record(entry)
    if (hunk === undefined) continue
    hunks.push({ oldText: str(hunk, 'oldText', ''), newText: str(hunk, 'newText', '') })
  }
  return {
    kind: 'diff',
    tool,
    path,
    operation: source.operation === 'create' ? 'create' : 'update',
    bytes: num(source, 'bytes', 0),
    size: num(source, 'size', 0),
    replacements: num(source, 'replacements', 0),
    encoding: str(source, 'encoding', 'utf8'),
    hunks,
    beyondBasis: bool(source, 'beyondBasis'),
  }
}
