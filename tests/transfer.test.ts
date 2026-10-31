import assert from 'node:assert/strict'
import test from 'node:test'
import { STREAM_IDLE_TIMEOUT_MS, transferBudget } from '../src/engine/client.ts'

const MIB = 1024 * 1024

test('a streaming transfer is bounded by stalling, not by its payload size', () => {
  // The regression this guards: a 700 MiB file moves at roughly 0.73 MiB/s on a
  // real link, so the whole transfer legitimately needs about 16 minutes. A
  // fixed ten-minute cap failed it while it was still making progress.
  const measuredSeconds = 700 / 0.73
  const budget = transferBudget(700 * MIB)
  assert.equal(budget.idleMs, STREAM_IDLE_TIMEOUT_MS)
  assert.ok(
    budget.hardMs > measuredSeconds * 1000,
    `a 700 MiB transfer needs ${Math.round(measuredSeconds)}s, budget allowed ${Math.round(budget.hardMs / 1000)}s`,
  )
})

test('the idle window is what a caller actually tunes', () => {
  const tight = transferBudget(4096, 30_000)
  assert.equal(tight.idleMs, 30_000)
  assert.equal(tight.hardMs, 120_000, 'the backstop is four idle windows when the payload is small')
  const roomy = transferBudget(4096, 600_000)
  assert.equal(roomy.idleMs, 600_000)
  assert.ok(roomy.hardMs >= 2_400_000)
})

test('the backstop grows with the payload and never shrinks below four idle windows', () => {
  const small = transferBudget(1024)
  const large = transferBudget(700 * MIB)
  assert.ok(large.hardMs > small.hardMs)
  assert.ok(small.hardMs >= STREAM_IDLE_TIMEOUT_MS * 4)
  assert.equal(transferBudget(0).hardMs, STREAM_IDLE_TIMEOUT_MS * 4)
  assert.equal(transferBudget(-5).hardMs, STREAM_IDLE_TIMEOUT_MS * 4, 'a nonsensical size cannot shorten the backstop')
})
