import { evaluateCombatValue } from './combatValueEvaluation.js'

export { evaluateCombatValue, applyCombatPercent } from './combatValueEvaluation.js'

import { statusContributions, temporaryCombatStats } from './combatEffects.js'
import type {
  CombatDefinition,
  CombatMoveDefinition,
  CombatBonuses,
  CombatEffectEventData,
} from '@ancadeba/schemas'
import type { CombatStatuses } from './combatEffects.js'

export interface CombatValueInputs {
  readonly health?: Readonly<Record<string, number>> | undefined
  readonly maximumHealth?: Readonly<Record<string, number>> | undefined
  readonly stats?: Readonly<Record<string, Readonly<CombatBonuses>>> | undefined
  readonly round?: number | undefined
  readonly event?: CombatEffectEventData | undefined
}

export interface CombatValueContext extends CombatValueInputs {
  readonly baseStats?: Readonly<Record<string, Readonly<CombatBonuses>>> | undefined
  readonly resources: Readonly<Record<string, number>>
  readonly resourceMaximums: Readonly<Record<string, number>>
  readonly statuses: CombatStatuses
  readonly self: string
  readonly target?: string | undefined
}

export function combatValueContext(
  definition: CombatDefinition,
  resources: Readonly<Record<string, number>> | undefined,
  statuses: CombatStatuses,
  self: string,
  target?: string,
  inputs: CombatValueInputs = {},
): CombatValueContext {
  const actors = [definition.player, ...definition.enemies]

  const maximumHealth = Object.fromEntries(
    actors.flatMap((actor) => {
      const value =
        inputs.maximumHealth?.[actor.id] ??
        (typeof actor.maximumHealth === 'number' ? actor.maximumHealth : undefined)

      return value === undefined ? [] : [[actor.id, value]]
    }),
  )

  const baseStats = Object.fromEntries(
    actors.map((actor) => [
      actor.id,
      {
        attack: 0,
        defense: 0,
        guard: 0,
        ...inputs.stats?.[actor.id],
        maximumHealth: maximumHealth[actor.id] ?? inputs.stats?.[actor.id]?.maximumHealth ?? 0,
      },
    ]),
  )

  const context: CombatValueContext = {
    ...inputs,
    maximumHealth,
    stats: baseStats,
    baseStats,
    resources:
      resources ??
      Object.fromEntries(
        Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => [
          id,
          resource.initial,
        ]),
      ),
    resourceMaximums: Object.fromEntries(
      Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => [
        id,
        resource.maximum,
      ]),
    ),
    statuses,
    self,
    target,
  }

  return {
    ...context,
    stats: Object.fromEntries(
      actors.map((actor) => [
        actor.id,
        temporaryCombatStats(
          baseStats[actor.id],
          statusContributions(definition, statuses[actor.id] ?? [], context, actor.id),
        ),
      ]),
    ),
  }
}

export function combatResourceCosts(
  move: CombatMoveDefinition,
  context?: CombatValueContext,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(move.resourceCosts ?? {}).map(([id, base]) => [
      id,
      evaluateCombatValue(base, move.resourceCostScaling?.[id], context, 'ceil'),
    ]),
  )
}
