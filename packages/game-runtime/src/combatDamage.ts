import { resolveCombatStatusValues } from './combatEffectValues.js'
import type { CombatValueContext } from './combatValues.js'
import type { CombatDamageDefenses, CombatDefinition, CombatEquipment } from '@ancadeba/schemas'
import { combatStatusAmount, type CombatStatuses } from './combatEffects.js'
import { applyCombatPercent } from './combatValues.js'

export interface CombatDamageProfile {
  readonly resistances: Readonly<Record<string, number>>
  readonly vulnerabilities: Readonly<Record<string, number>>
  readonly immunities: readonly string[]
}

/** Merge permanent actor defenses with live, strength-scaled status contributions. */
export function combatDamageProfile(
  definition: CombatDefinition,
  actor: string,
  statuses: CombatStatuses = {},
  equipment: CombatEquipment = {},
  context?: CombatValueContext,
): CombatDamageProfile {
  const owner = [definition.player, ...definition.enemies].find((entry) => entry.id === actor)

  if (!owner) throw new Error('Unknown combat damage recipient')
  const resistances: Record<string, number> = {}
  const vulnerabilities: Record<string, number> = {}
  const immunities = new Set<string>()

  const add = (defenses: CombatDamageDefenses | undefined, scale: (value: number) => number) => {
    for (const kind of ['resistances', 'vulnerabilities'] as const) {
      const output = kind === 'resistances' ? resistances : vulnerabilities

      for (const [type, percent] of Object.entries(defenses?.[kind] ?? {})) {
        const next =
          Math.round((Object.hasOwn(output, type) ? output[type]! : 0) * 100) +
          scale(Math.round(percent * 100))

        if (!Number.isSafeInteger(next)) throw new RangeError('Combat damage defense overflow')
        output[type] = next / 100
      }
    }

    for (const type of defenses?.immunities ?? []) immunities.add(type)
  }

  add(owner.damageDefenses, (value) => value)

  for (const entry of equipment[actor] ?? []) add(entry.effects.damageDefenses, (value) => value)

  for (const active of statuses[actor] ?? [])
    add(
      (definition.statuses?.[active.id]
        ? resolveCombatStatusValues(
            {
              ...definition.statuses[active.id]!,
              valueScaling: Object.fromEntries(
                Object.entries(definition.statuses[active.id]!.valueScaling ?? {}).filter(([key]) =>
                  key.startsWith('damageDefenses.'),
                ),
              ),
            },
            active,
            actor,
            context,
          )
        : undefined
      )?.damageDefenses,
      (value) => combatStatusAmount(value, active),
    )

  return Object.freeze({
    resistances: Object.freeze(resistances),
    vulnerabilities: Object.freeze(vulnerabilities),
    immunities: Object.freeze([...immunities]),
  })
}

export interface CombatTypedDamage {
  readonly damageType: string
  readonly amount: number
  readonly resistance: number
  readonly vulnerability: number
  readonly immune: boolean
  readonly resisted: number
  readonly amplified: number
}

/** Type adjustments follow flat defense and precede Guard. Immunity preserves Guard. */
export function combatTypedDamage(
  amount: number,
  damageType = 'physical',
  profile?: CombatDamageProfile,
): CombatTypedDamage {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new RangeError('Invalid combat damage amount')

  const resistance =
    profile && Object.hasOwn(profile.resistances, damageType) ? profile.resistances[damageType]! : 0

  const vulnerability =
    profile && Object.hasOwn(profile.vulnerabilities, damageType)
      ? profile.vulnerabilities[damageType]!
      : 0

  const immune = profile?.immunities.includes(damageType) ?? false

  const adjusted = immune
    ? 0
    : applyCombatPercent(
        amount,
        (Math.round(vulnerability * 100) - Math.round(resistance * 100)) / 100,
      )

  return {
    damageType,
    amount: adjusted,
    resistance,
    vulnerability,
    immune,
    resisted: Math.max(0, amount - adjusted),
    amplified: Math.max(0, adjusted - amount),
  }
}
