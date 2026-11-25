import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HistoryStore } from '../src/history.ts'

const brew = (name: string, volume = 300) =>
  ({ serialNumber: '1', name, temperature: 80, duration: 120, volume, source: 'app' as const })

// Wednesday, 2026-11-25 15:00 local time.
const NOW = new Date(2026, 10, 25, 15, 0).getTime()
const at = (daysAgo: number, hour = 9) => {
  const date = new Date(NOW)
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

test('stats count cups per day, week and in total', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-history-'))
  const history = new HistoryStore(dir)
  await history.load()

  history.start(brew('Sencha'), at(0))
  history.start(brew('Sencha'), at(0, 11)) // closes the previous one as done
  history.start(brew('Assam', 400), at(1))
  history.finish('1', 'done')
  history.start(brew('Rooibos'), at(2)) // Monday of this week
  history.finish('1', 'cancelled')
  history.start(brew('Sencha'), at(5)) // last Friday
  history.finish('1', 'done')
  history.start(brew('Assam', 400), at(9)) // older than a week

  const stats = history.stats(NOW)
  assert.equal(stats.today, 2)
  assert.equal(stats.week, 3, 'Monday to today, cancelled Rooibos excluded')
  assert.equal(stats.total, 5)
  assert.equal(stats.liters, 1.7)
  assert.deepEqual(stats.favorites, [{ name: 'Sencha', cups: 3 }, { name: 'Assam', cups: 2 }])
  assert.deepEqual(stats.days.map((day) => day.cups), [0, 1, 0, 0, 0, 1, 2])
  assert.equal(stats.days.at(-1)?.date, '2026-11-25')

  assert.deepEqual(history.list(2).map((entry) => entry.name), ['Assam', 'Sencha'], 'newest first')
  assert.equal(history.list(10).find((entry) => entry.name === 'Rooibos')?.status, 'cancelled')

  // Survives a restart.
  await history.flush()
  const reloaded = new HistoryStore(dir)
  await reloaded.load()
  assert.equal(reloaded.stats(NOW).total, 5)
  await rm(dir, { recursive: true, force: true })
})
