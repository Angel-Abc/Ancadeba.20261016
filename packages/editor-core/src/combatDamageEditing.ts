import type { CombatDamageDefenses } from '@ancadeba/schemas'
import { object } from './project.js'

export function mergeCombatDamageDefenses(
  previous: unknown,
  defenses: CombatDamageDefenses | undefined,
) {
  return defenses
    ? {
        ...object(previous),
        ...defenses,
        resistances: defenses.resistances ? { ...defenses.resistances } : undefined,
        vulnerabilities: defenses.vulnerabilities ? { ...defenses.vulnerabilities } : undefined,
        immunities: defenses.immunities ? [...defenses.immunities] : undefined,
      }
    : undefined
}
