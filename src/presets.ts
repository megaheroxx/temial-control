import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lang } from './i18n.ts'
import type { BrewRecipe } from './protocol.ts'

/** color: optional hex colour for the tile; without it the dashboard picks one from name and temperature. */
export type Preset = BrewRecipe & { id: string, color?: string }

/** Seeded on the very first start, named in the server's default language. */
const DEFAULT_PRESETS: Record<Lang, BrewRecipe[]> = {
  en: [
    { name: 'Green tea', temperature: 80, duration: 120, volume: 350, preWashTime: 0 },
    { name: 'Black tea', temperature: 95, duration: 240, volume: 400, preWashTime: 10 },
    { name: 'Oolong', temperature: 90, duration: 180, volume: 350, preWashTime: 10 },
    { name: 'Rooibos', temperature: 100, duration: 300, volume: 400, preWashTime: 0 },
    { name: 'Herbal tea', temperature: 100, duration: 420, volume: 400, preWashTime: 0 },
  ],
  de: [
    { name: 'Grüner Tee', temperature: 80, duration: 120, volume: 350, preWashTime: 0 },
    { name: 'Schwarzer Tee', temperature: 95, duration: 240, volume: 400, preWashTime: 10 },
    { name: 'Oolong', temperature: 90, duration: 180, volume: 350, preWashTime: 10 },
    { name: 'Rooibos', temperature: 100, duration: 300, volume: 400, preWashTime: 0 },
    { name: 'Kräutertee', temperature: 100, duration: 420, volume: 400, preWashTime: 0 },
  ],
}

/** Brew presets, persisted as JSON in the data directory. */
export class PresetStore {
  readonly #file: string
  readonly #dir: string
  readonly #language: Lang
  #presets: Preset[] = []

  constructor(dataDir: string, language: Lang = 'en') {
    this.#dir = dataDir
    this.#language = language
    this.#file = join(dataDir, 'presets.json')
  }

  async load() {
    try {
      this.#presets = JSON.parse(await readFile(this.#file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.#presets = DEFAULT_PRESETS[this.#language].map((recipe) => ({ id: randomUUID(), ...recipe }))
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

  get(id: string): Preset | undefined {
    return this.#presets.find((preset) => preset.id === id)
  }

  /**
   * Replaces recipe values and colour of a preset (colour undefined = automatic).
   * Returns null for an unknown id.
   */
  async update(id: string, recipe: BrewRecipe, color: string | undefined): Promise<Preset | null> {
    const index = this.#presets.findIndex((preset) => preset.id === id)
    if (index < 0) return null
    const preset: Preset = { id, ...recipe, ...(color ? { color } : {}) }
    this.#presets[index] = preset
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
