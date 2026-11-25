import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type HistoryEntry = {
  id: string
  time: number
  serialNumber: string
  name: string
  temperature: number | null
  duration: number | null
  volume: number | null
  /** "2/3" for the second of three infusions. */
  infusion?: string
  /** app: started from Temial Control; device: started at the Temial itself. */
  source: 'app' | 'device'
  status: 'brewing' | 'done' | 'cancelled'
}

export type HistoryStats = {
  today: number
  week: number
  total: number
  liters: number
  /** Cups per day for the last 7 days, oldest first; date as YYYY-MM-DD in server time. */
  days: { date: string, cups: number }[]
  favorites: { name: string, cups: number }[]
}

const MAX_ENTRIES = 5000
const DAY_MS = 24 * 60 * 60 * 1000

/** Brew history, persisted as JSON in the data directory. */
export class HistoryStore {
  readonly #file: string
  readonly #dir: string
  #entries: HistoryEntry[] = []
  #saving: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.#dir = dataDir
    this.#file = join(dataDir, 'history.json')
  }

  async load() {
    try {
      this.#entries = JSON.parse(await readFile(this.#file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.#entries = []
    }
  }

  /** Newest first. */
  list(limit = 50): HistoryEntry[] {
    return this.#entries.slice(-limit).reverse()
  }

  /** Records a started brew; a still open brew of the same device counts as finished. */
  start(entry: Omit<HistoryEntry, 'id' | 'time' | 'status'>, time = Date.now()): HistoryEntry {
    this.#close(entry.serialNumber, 'done')
    const created: HistoryEntry = { id: randomUUID(), time, status: 'brewing', ...entry }
    this.#entries.push(created)
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES)
    this.#save()
    return created
  }

  finish(serialNumber: string, status: 'done' | 'cancelled') {
    if (this.#close(serialNumber, status)) this.#save()
  }

  stats(now = Date.now()): HistoryStats {
    const cups = this.#entries.filter((entry) => entry.status !== 'cancelled')
    const startOfDay = (time: number) => {
      const date = new Date(time)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }
    const today = startOfDay(now)
    // Weeks start on Monday.
    const weekStart = today - ((new Date(today).getDay() + 6) % 7) * DAY_MS
    const dayKey = (time: number) => {
      const date = new Date(time)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    const days = Array.from({ length: 7 }, (_, i) => {
      const start = startOfDay(today - (6 - i) * DAY_MS + DAY_MS / 2)
      const end = startOfDay(start + DAY_MS + DAY_MS / 2)
      return { date: dayKey(start), cups: cups.filter((entry) => entry.time >= start && entry.time < end).length }
    })

    const byName = new Map<string, number>()
    for (const entry of cups) byName.set(entry.name, (byName.get(entry.name) ?? 0) + 1)

    return {
      today: cups.filter((entry) => entry.time >= today).length,
      week: cups.filter((entry) => entry.time >= weekStart).length,
      total: cups.length,
      liters: Math.round(cups.reduce((sum, entry) => sum + (entry.volume ?? 0), 0) / 100) / 10,
      days,
      favorites: [...byName].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, cups: count })),
    }
  }

  async flush() {
    await this.#saving
  }

  #close(serialNumber: string, status: 'done' | 'cancelled'): boolean {
    const open = this.#entries.findLast((entry) => entry.serialNumber === serialNumber && entry.status === 'brewing')
    if (!open) return false
    open.status = status
    return true
  }

  /** Writes are chained so concurrent changes never interleave on disk. */
  #save() {
    this.#saving = this.#saving.then(async () => {
      await mkdir(this.#dir, { recursive: true })
      const tmp = this.#file + '.tmp'
      await writeFile(tmp, JSON.stringify(this.#entries))
      await rename(tmp, this.#file)
    }).catch((err) => console.error('Could not save the brew history:', err))
  }
}
