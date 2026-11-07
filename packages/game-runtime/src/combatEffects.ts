import type {
  CombatDefinition,
  CombatBonuses,
  TemporaryModifiers,
  CombatMoveDefinition,
} from '@ancadeba/schemas'

export interface ActiveCombatStatus {
  readonly id: string
  readonly source: string
  readonly remaining: number
}

export type CombatStatuses = Readonly<Record<string, readonly ActiveCombatStatus[]>>

export type CombatCooldowns = Readonly<Record<string, Readonly<Record<string, number>>>>

export interface TemporaryStatContribution {
  readonly id: string
  readonly label: string
  readonly modifiers: Readonly<TemporaryModifiers>
}

export function statusContributions(
  definition: CombatDefinition,
  statuses: readonly ActiveCombatStatus[],
): readonly TemporaryStatContribution[] {
  return Object.freeze(
    statuses.flatMap((active) => {
      const status = definition.statuses?.[active.id]

      return status?.type === 'modifier'
        ? [
            Object.freeze({
              id: active.id,
              label: status.label,
              modifiers: Object.freeze({ ...status.modifiers }),
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

    total[stat] = Math.max(0, total[stat])
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
  return statuses.some((status) => definition.statuses?.[status.id]?.type === 'stun')
}

export function cooldownRemaining(
  cooldowns: CombatCooldowns,
  actor: string,
  move: string,
  round: number,
): number {
  return Math.max(0, (cooldowns[actor]?.[move] ?? round) - round)
}
