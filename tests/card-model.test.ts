/**
 * Card-model tests: the narrowing that turns a persisted `presentationMeta`
 * payload back into something a card can draw. The payload crosses a session
 * log and may be obsolete or hand-edited, so every case here is about
 * declining rather than throwing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { diffCard, readCard } from '../src/client/tool/card-model.ts'

test('readCard narrows a read payload and keeps the line numbers', () => {
  const card = readCard({
    card: 'winrm-read',
    path: 'C:\\logs\\app.log',
    offset: 40,
    totalLines: 60,
    encoding: 'utf8',
    truncatedByBytes: true,
    truncatedLines: 2,
    lines: [{ number: 40, text: 'line forty' }, { number: 41, text: '' }],
  }, 'fallback')
  assert.equal(card?.kind, 'read')
  assert.equal(card.path, 'C:\\logs\\app.log')
  assert.equal(card.offset, 40)
  assert.equal(card.totalLines, 60)
  assert.deepEqual(card.lines, [{ number: 40, text: 'line forty' }, { number: 41, text: '' }])
  assert.equal(card.truncatedByBytes, true)
  assert.equal(card.truncatedLines, 2)
})

test('readCard declines a payload that belongs to another card', () => {
  assert.equal(readCard({ card: 'winrm-write' }, 'x'), undefined)
  assert.equal(readCard(undefined, 'x'), undefined)
  assert.equal(readCard('not an object', 'x'), undefined)
  assert.equal(readCard(null, 'x'), undefined)
})

test('readCard turns a failed call into an error card carrying the message', () => {
  const card = readCard({ card: 'winrm-read', path: 'C:\\a', error: 'remote file not found: C:\\a' }, 'x')
  assert.equal(card?.kind, 'error')
  assert.equal(card.message, 'remote file not found: C:\\a')
  assert.equal(card.path, 'C:\\a')
})

test('readCard survives a payload whose fields have the wrong types', () => {
  const card = readCard({ card: 'winrm-read', path: 7, lines: 'nope', offset: 'x', totalLines: null }, 'fallback')
  assert.equal(card?.kind, 'read')
  assert.equal(card.path, 'fallback')
  assert.deepEqual(card.lines, [])
  assert.equal(card.offset, 1)
  assert.equal(card.totalLines, 0)
})

test('diffCard keeps each hunk as the two text fragments the primitive expects', () => {
  const card = diffCard({
    card: 'winrm-write',
    path: 'C:\\a.txt',
    operation: 'update',
    bytes: 12,
    size: 12,
    encoding: 'utf8',
    diffs: [
      { path: 'C:\\a.txt', oldText: 'a\nb\n', newText: 'a\nc\n' },
      { path: 'C:\\a.txt', oldText: '', newText: 'fresh\n' },
    ],
  }, 'fallback', 'write')
  assert.equal(card?.kind, 'diff')
  assert.equal(card.tool, 'write')
  assert.equal(card.operation, 'update')
  assert.equal(card.bytes, 12)
  assert.deepEqual(card.hunks, [
    { oldText: 'a\nb\n', newText: 'a\nc\n' },
    { oldText: '', newText: 'fresh\n' },
  ])
})

test('diffCard reports a create and a basis overflow', () => {
  const create = diffCard({ card: 'winrm-write', operation: 'create', bytes: 3, diffs: [] }, 'x', 'write')
  assert.equal(create?.kind === 'diff' && create.operation, 'create')
  const beyond = diffCard({ card: 'winrm-edit', beyondBasis: true, replacements: 4, diffs: [] }, 'x', 'edit')
  assert.equal(beyond?.kind === 'diff' && beyond.beyondBasis, true)
  assert.equal(beyond?.kind === 'diff' && beyond.replacements, 4)
})

test('diffCard declines a payload whose card tag names another tool', () => {
  assert.equal(diffCard({ card: 'winrm-read', diffs: [] }, 'x', 'write'), undefined)
  assert.equal(diffCard({ card: 'winrm-write', diffs: [] }, 'x', 'edit'), undefined)
})

test('diffCard drops hunk entries that are not objects', () => {
  const card = diffCard({ card: 'winrm-edit', diffs: [null, 7, { oldText: 'o', newText: 'n' }] }, 'x', 'edit')
  assert.equal(card?.kind, 'diff')
  assert.deepEqual(card.hunks, [{ oldText: 'o', newText: 'n' }])
})
