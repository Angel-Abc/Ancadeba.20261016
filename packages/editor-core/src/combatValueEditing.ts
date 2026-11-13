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
      actor: term.type === 'status' ? term.actor : undefined,
      status: term.type === 'status' ? term.status : undefined,
      resource: term.type === 'resource' ? term.resource : undefined,
      measure: term.measure,
    })),
  }
}
