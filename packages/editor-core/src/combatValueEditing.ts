import type { CombatScaling } from '@ancadeba/schemas'
import { object } from './project.js'

export function mergeCombatScaling(previous: unknown, scaling: CombatScaling | undefined) {
  if (!scaling) return undefined
  const old = object(previous)

  return {
    ...old,
    ...scaling,
    mode: scaling.mode,
    rounding: scaling.rounding,
    minimum: scaling.minimum,
    maximum: scaling.maximum,
    terms: scaling.terms.map((term, index) => ({
      ...object(Array.isArray(old.terms) ? old.terms[index] : undefined),
      ...term,
      actor: 'actor' in term ? term.actor : undefined,
      status: term.type === 'status' ? term.status : undefined,
      resource: term.type === 'resource' ? term.resource : undefined,
      measure: 'measure' in term ? term.measure : undefined,
      stat: term.type === 'stat' ? term.stat : undefined,
    })),
  }
}

export function mergeCombatEffectValueScaling(
  previous: unknown,
  next: Record<string, CombatScaling> | undefined,
) {
  return next
    ? Object.fromEntries(
        Object.entries(next).map(([key, scaling]) => [
          key,
          mergeCombatScaling(object(previous)[key], scaling),
        ]),
      )
    : undefined
}
