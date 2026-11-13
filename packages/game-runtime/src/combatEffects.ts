import { resolveCombatStatusValues } from './combatEffectValues.js'
import type { CombatValueContext } from './combatValues.js'
import type {
  CombatDefinition,
  CombatBonuses,
  TemporaryModifiers,
  CombatMoveDefinition,
  CombatStatusDefinition,
  CombatPercentModifiers,
} from '@ancadeba/schemas'
import { applyCombatPercent } from './combatValueEvaluation.js'
import { temporaryModifierNames, combatPercentModifierNames } from '@ancadeba/schemas'

export interface ActiveCombatStatus {
  readonly id: string
  readonly source: string
  readonly remaining: number
  readonly stacks?: number | undefined
  readonly intensity?: number | undefined
}

export type CombatStatuses = Readonly<Record<string, readonly ActiveCombatStatus[]>>

export type CombatCooldowns = Readonly<Record<string, Readonly<Record<string, number>>>>

export interface TemporaryStatContribution {
  readonly id: string
  readonly label: string
  readonly modifiers: Readonly<TemporaryModifiers>
  readonly percentModifiers?: Readonly<CombatPercentModifiers> | undefined
}

export function statusContributions(
  definition: CombatDefinition,
  statuses: readonly ActiveCombatStatus[],
  context?: CombatValueContext,
  owner = context?.self ?? '',
): readonly TemporaryStatContribution[] {
  return Object.freeze(
    statuses.flatMap((active) => {
      const authored = definition.statuses?.[active.id]

      const status =
        authored &&
        resolveCombatStatusValues(
          {
            ...authored,
            valueScaling: authored.valueScaling
              ? Object.fromEntries(
                  Object.entries(authored.valueScaling).filter(
                    ([key]) => key.startsWith('modifiers.') || key.startsWith('percentModifiers.'),
                  ),
                )
              : undefined,
          },
          active,
          owner,
          context,
        )

      if (!status) return []

      const { modifiers, percentModifiers } = combatStatusParts(status)

      return modifiers || percentModifiers
        ? [
            Object.freeze({
              id: active.id,
              label: status.label,
              modifiers: scaledCombatModifiers(modifiers ?? {}, active),
              ...(percentModifiers
                ? {
                    percentModifiers: Object.fromEntries(
                      Object.entries(percentModifiers).map(([stat, value]) => [
                        stat,
                        combatStatusAmount(Math.round((value ?? 0) * 100), active) / 100,
                      ]),
                    ),
                  }
                : {}),
            }),
          ]
        : []
    }),
  )
}

export function temporaryCombatStats(
  base: Readonly<CombatBonuses> | undefined,
  effects: readonly TemporaryStatContribution[],
): Readonly<CombatBonuses> {
  const total = { attack: 0, defense: 0, guard: 0, maximumHealth: 0, ...base }

  for (const stat of ['attack', 'defense', 'guard'] as const) {
    for (const effect of effects) {
      total[stat] += effect.modifiers[stat] ?? 0

      if (!Number.isSafeInteger(total[stat])) throw new RangeError('Temporary stat overflow')
    }

    total[stat] = applyCombatPercent(Math.max(0, total[stat]), combatPercentModifier(effects, stat))
  }

  return Object.freeze(total)
}

export function combatMoveTarget(move: CombatMoveDefinition): 'self' | 'enemy' {
  return move.type === 'guard' || (move.type === 'ability' && move.target === 'self')
    ? 'self'
    : 'enemy'
}

export function combatStunned(
  definition: CombatDefinition,
  statuses: readonly ActiveCombatStatus[] = [],
): boolean {
  return statuses.some((status) => {
    const data = definition.statuses?.[status.id]

    return data && combatStatusParts(data).stun
  })
}

export function combatStatusParts(status: CombatStatusDefinition) {
  return {
    damageType:
      status.type === 'damage' || status.type === 'composite' ? status.damageType : undefined,
    damage:
      status.type === 'damage'
        ? status.amount
        : status.type === 'composite'
          ? status.damage
          : undefined,
    regeneration:
      status.type === 'regeneration'
        ? status.amount
        : status.type === 'composite'
          ? status.regeneration
          : undefined,
    modifiers:
      status.type === 'modifier' || status.type === 'composite' ? status.modifiers : undefined,
    percentModifiers:
      status.type === 'modifier' || status.type === 'composite'
        ? status.percentModifiers
        : undefined,
    stun: status.type === 'stun' || (status.type === 'composite' && status.stun === true),
  }
}

export function combatStatusAmount(amount: number, active: ActiveCombatStatus): number {
  const stacks = active.stacks ?? 1
  const intensity = active.intensity ?? 1
  const scaled = amount * stacks * intensity

  if (
    !Number.isInteger(stacks) ||
    stacks < 1 ||
    stacks > 100 ||
    !Number.isInteger(intensity) ||
    intensity < 1 ||
    intensity > 100 ||
    !Number.isSafeInteger(scaled)
  )
    throw new RangeError('Combat status magnitude overflow')

  return scaled
}

export function scaledCombatModifiers(
  modifiers: Readonly<TemporaryModifiers>,
  active: ActiveCombatStatus,
): Readonly<TemporaryModifiers> {
  const scaled: TemporaryModifiers = {}

  for (const stat of temporaryModifierNames)
    if (modifiers[stat] !== undefined) scaled[stat] = combatStatusAmount(modifiers[stat], active)

  return Object.freeze(scaled)
}

export function cooldownRemaining(
  cooldowns: CombatCooldowns,
  actor: string,
  move: string,
  round: number,
): number {
  return Math.max(0, (cooldowns[actor]?.[move] ?? round) - round)
}

export function combatPercentModifier(
  effects: readonly TemporaryStatContribution[],
  stat: (typeof combatPercentModifierNames)[number],
): number {
  let total = 0

  for (const effect of effects) {
    total += Math.round((effect.percentModifiers?.[stat] ?? 0) * 100)

    if (!Number.isSafeInteger(total)) throw new RangeError('Combat percentage overflow')
  }

  return total / 100
}
