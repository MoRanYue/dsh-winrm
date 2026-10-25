/**
 * Contextual diff derivation for the write/edit presentation metadata.
 *
 * The GUI renders a diff card from `tool/result` metadata rather than from the
 * model-facing text, so the hunks are projected here, at result time, and
 * persisted with the session log. This mirrors the harness's own file tools:
 * one entry per applied change with a few surrounding context lines.
 *
 * The alignment is deliberately cheap rather than a full LCS: common leading
 * and trailing lines are trimmed, and when the remaining halves have the same
 * length each differing run becomes its own hunk. That covers the cases these
 * two tools actually produce — an exact-string edit, and a rewrite that keeps
 * most lines — without a diff dependency in a plugin whose point is a small
 * footprint. A rewrite that changes the line count collapses to one hunk over
 * the changed span, which is still a truthful summary.
 * @module dsh-winrm/src/diff
 */

/** Context lines shown on each side of an applied hunk. */
export const DIFF_CONTEXT = 3

/**
 * Largest file whose text may serve as a diff basis. Above this the card shows
 * the path and operation without hunks: fetching and projecting a bigger basis
 * would cost another transfer and a large metadata payload for a summary the
 * user reads at a glance.
 */
export const DIFF_BASIS_MAX_BYTES = 256 * 1024

/**
 * Largest serialized hunk list kept on one result. A pathological edit (a
 * whole-file rewrite of a large file) can produce thousands of hunks; past
 * this bound the card degrades to path-only instead of bloating the log.
 */
export const DIFF_META_MAX_BYTES = 512 * 1024

/**
 * One applied hunk: the fragment before the change and after it.
 *
 * Declared as a type alias rather than an interface so it satisfies the
 * `JsonValue` index signature the tool-output metadata is typed against.
 */
export type RemoteFileDiff = {
  /** Remote path the hunk belongs to (the authored argument). */
  path: string
  /** Prior content including context lines; empty for a pure insertion. */
  oldText: string
  /** Content after the change, including the shared context lines. */
  newText: string
}

/** Split text into lines, treating every terminator as a separator. */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r?\n/)
}

/**
 * Compute the hunks between two texts.
 * @param path - remote path stamped on every hunk.
 * @param before - file text before the change.
 * @param after - file text after the change.
 * @returns one hunk per contiguous change in file order; empty when equal.
 */
export function computeHunkDiffs(path: string, before: string, after: string): RemoteFileDiff[] {
  if (before === after) return []
  const oldLines = toLines(before)
  const newLines = toLines(after)

  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1
  let tail = 0
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1

  const oldMid = oldLines.slice(head, oldLines.length - tail)
  const newMid = newLines.slice(head, newLines.length - tail)

  /** Build one hunk around the changed range `[from, to)` in the middle. */
  const emit = (from: number, to: number): RemoteFileDiff => {
    // Both mid arrays have the same length in the aligned branch below, so one
    // clamped window addresses the old and the new side alike.
    const start = Math.max(0, from - DIFF_CONTEXT)
    const stop = Math.min(oldMid.length, to + DIFF_CONTEXT)
    return {
      path,
      oldText: oldLines.slice(head + start, head + stop).join('\n'),
      newText: newLines.slice(head + start, head + stop).join('\n'),
    }
  }

  if (oldMid.length !== newMid.length) {
    // Unaligned rewrite: one hunk over the whole changed span.
    return [{
      path,
      oldText: oldLines.slice(Math.max(0, head - DIFF_CONTEXT), oldLines.length - Math.max(0, tail - DIFF_CONTEXT)).join('\n'),
      newText: newLines.slice(Math.max(0, head - DIFF_CONTEXT), newLines.length - Math.max(0, tail - DIFF_CONTEXT)).join('\n'),
    }]
  }

  const diffs: RemoteFileDiff[] = []
  let index = 0
  while (index < oldMid.length) {
    if (oldMid[index] === newMid[index]) {
      index += 1
      continue
    }
    const from = index
    while (index < oldMid.length && oldMid[index] !== newMid[index]) index += 1
    diffs.push(emit(from, index))
  }
  return diffs
}

/**
 * Compute hunks and drop them when the serialized payload would exceed the cap.
 * @param path - remote path stamped on every hunk.
 * @param before - prior text.
 * @param after - text after the change.
 * @returns the kept hunks; empty when nothing changed or the payload is too big.
 */
export function boundedHunkDiffs(path: string, before: string, after: string): RemoteFileDiff[] {
  const diffs = computeHunkDiffs(path, before, after)
  if (diffs.length === 0) return diffs
  return JSON.stringify(diffs).length > DIFF_META_MAX_BYTES ? [] : diffs
}
