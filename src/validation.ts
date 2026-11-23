import type { BrewRecipe } from './protocol.ts'

// Conservative bounds; the device's real limits are undocumented.
export const LIMITS = {
  temperature: { min: 40, max: 100, unit: '°C' },
  duration: { min: 10, max: 1800, unit: 's' },
  volume: { min: 50, max: 1000, unit: 'ml' },
  preWashTime: { min: 0, max: 60, unit: 's' },
} as const

const NAME_MAX = 40

export type ValidationResult =
  | { ok: true, recipe: BrewRecipe }
  | { ok: false, errors: string[] }

export function validateRecipe(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['Rezept muss ein Objekt sein'] }
  }
  const data = input as Record<string, unknown>
  const errors: string[] = []

  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!name) errors.push('name fehlt')
  else if (name.length > NAME_MAX) errors.push(`name darf höchstens ${NAME_MAX} Zeichen lang sein`)

  const numbers = {} as Record<keyof typeof LIMITS, number>
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const { min, max, unit } = LIMITS[key]
    const value = data[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${key} muss eine ganze Zahl sein`)
    } else if (value < min || value > max) {
      errors.push(`${key} muss zwischen ${min} und ${max} ${unit} liegen`)
    } else {
      numbers[key] = value
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, recipe: { name, ...numbers } }
}
