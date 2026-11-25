import { translator, type Translate } from './i18n.ts'
import type { BrewRecipe, Infusion } from './protocol.ts'

// Conservative bounds; the device's real limits are undocumented.
export const LIMITS = {
  temperature: { min: 40, max: 100, unit: '°C' },
  duration: { min: 10, max: 1800, unit: 's' },
  volume: { min: 50, max: 1000, unit: 'ml' },
  preWashTime: { min: 0, max: 60, unit: 's' },
} as const

const NAME_MAX = 40
/** Up to 5 infusions in total, like the original app's picker. */
export const MAX_INFUSIONS = 5

export type ValidationResult =
  | { ok: true, recipe: BrewRecipe }
  | { ok: false, errors: string[] }

const ENGLISH = translator('en')

export function validateRecipe(input: unknown, t: Translate = ENGLISH): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: [t('recipe.notObject')] }
  }
  const data = input as Record<string, unknown>
  const errors: string[] = []

  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!name) errors.push(t('recipe.nameMissing'))
  else if (name.length > NAME_MAX) errors.push(t('recipe.nameTooLong', { max: NAME_MAX }))

  const numbers = {} as Record<keyof typeof LIMITS, number>
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const { min, max, unit } = LIMITS[key]
    const value = data[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(t('recipe.notInteger', { key }))
    } else if (value < min || value > max) {
      errors.push(t('recipe.outOfRange', { key, min, max, unit }))
    } else {
      numbers[key] = value
    }
  }

  const infusions: Infusion[] = []
  if (data.infusions !== undefined && data.infusions !== null) {
    if (!Array.isArray(data.infusions) || data.infusions.length > MAX_INFUSIONS - 1) {
      errors.push(t('recipe.infusionsList', { max: MAX_INFUSIONS - 1 }))
    } else {
      data.infusions.forEach((step: unknown, i) => {
        const { temperature, duration } = (step ?? {}) as Record<string, unknown>
        for (const [key, value] of [['temperature', temperature], ['duration', duration]] as const) {
          const { min, max, unit } = LIMITS[key]
          if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            errors.push(t('recipe.infusionInvalid', { number: i + 2, key, min, max, unit }))
          }
        }
        infusions.push({ temperature: temperature as number, duration: duration as number })
      })
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, recipe: { name, ...numbers, ...(infusions.length ? { infusions } : {}) } }
}
