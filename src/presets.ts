import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrewRecipe } from './protocol.ts'

/** color: optional hex colour for the tile; without it the dashboard picks one from name and temperature. */
export type Preset = BrewRecipe & { id: string, color?: string }

const DEFAULT_PRESETS: BrewRecipe[] = [
  { name: 'Grüner Tee', temperature: 80, duration: 120, volume: 350, preWashTime: 0 },
  { name: 'Schwarzer Tee', temperature: 95, duration: 240, volume: 400, preWashTime: 10 },
  { name: 'Oolong', temperature: 90, duration: 180, volume: 350, preWashTime: 10 },
  { name: 'Rooibos', temperature: 100, duration: 300, volume: 400, preWashTime: 0 },
  { name: 'Kräutertee', temperature: 100, duration: 420, volume: 400, preWashTime: 0 },
]

/** Brew presets, persisted as JSON in the data directory. */
export class PresetStore {
  readonly #file: string
  readonly #dir: string
  #presets: Preset[] = []

  constructor(dataDir: string) {
    this.#dir = dataDir
    this.#file = join(dataDir, 'presets.json')
  }

  async load() {
    try {
      this.#presets = JSON.parse(await readFile(this.#file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.#presets = DEFAULT_PRESETS.map((recipe) => ({ id: randomUUID(), ...recipe }))
      await this.#save()
    }
  }

  list(): Preset[] {
    return [...this.#presets]
  }

  async add(recipe: BrewRecipe): Promise<Preset> {
    const preset = { id: randomUUID(), ...recipe }
    this.#presets.push(preset)
    await this.#save()
    return preset
  }

  /** Sets or (with undefined) clears the colour of a preset. Returns null for an unknown id. */
  async setColor(id: string, color: string | undefined): Promise<Preset | null> {
    const preset = this.#presets.find((p) => p.id === id)
    if (!preset) return null
    if (color) preset.color = color
    else delete preset.color
    await this.#save()
    return preset
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#presets.length
    this.#presets = this.#presets.filter((preset) => preset.id !== id)
    if (this.#presets.length === before) return false
    await this.#save()
    return true
  }

  async #save() {
    await mkdir(this.#dir, { recursive: true })
    const tmp = this.#file + '.tmp'
    await writeFile(tmp, JSON.stringify(this.#presets, null, 2))
    await rename(tmp, this.#file)
  }
}
