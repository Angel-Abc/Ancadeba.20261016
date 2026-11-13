import {
  applyCombatPercent,
  evaluateCombatValue,
  combatValueContext,
  type CombatValueContext,
} from './combatValues.js'
import type {
  CombatDefinition,
  CombatActorDefinition,
  CombatMoveDefinition,
} from '@ancadeba/schemas'
import {
  statusContributions,
  combatPercentModifier,
  type ActiveCombatStatus,
  type CombatStatuses,
} from './combatEffects.js'

export interface CombatActionEconomy {
  readonly ap: number
  readonly apCostPercent?: number | undefined
  readonly apCost: number
}

export function combatActorEconomy(
  definition: CombatDefinition,
  actor: CombatActorDefinition,
  statuses: readonly ActiveCombatStatus[] = [],
): CombatActionEconomy {
  let ap = actor.ap
  let apCost = 0

  const effects = statusContributions(definition, statuses)

  for (const effect of effects) {
    ap += effect.modifiers.ap ?? 0
    apCost += effect.modifiers.apCost ?? 0

    if (!Number.isSafeInteger(ap) || !Number.isSafeInteger(apCost))
      throw new RangeError('Combat action modifier overflow')
  }

  const apCostPercent = combatPercentModifier(effects, 'apCost')

  return Object.freeze({
    ap: applyCombatPercent(Math.max(0, ap), combatPercentModifier(effects, 'ap'), 'floor', 100),
    apCost,
    ...(apCostPercent ? { apCostPercent } : {}),
  })
}

export function combatActionCost(
  move: CombatMoveDefinition,
  economy: CombatActionEconomy,
  context?: CombatValueContext,
): number {
  const cost =
    evaluateCombatValue(move.apCost, move.apCostScaling, context, 'ceil') + economy.apCost

  if (!Number.isSafeInteger(cost)) throw new RangeError('Combat action cost overflow')

  return Math.max(1, applyCombatPercent(Math.max(0, cost), economy.apCostPercent ?? 0, 'ceil'))
}

export function combatEconomySnapshot(
  definition: CombatDefinition,
  statuses: CombatStatuses,
  resources?: Readonly<Record<string, number>>,
  target?: string,
) {
  const ap: Record<string, number> = {}
  const moveCosts: Record<string, Readonly<Record<string, number>>> = {}

  for (const actor of [definition.player, ...definition.enemies]) {
    const economy = combatActorEconomy(definition, actor, statuses[actor.id])
    ap[actor.id] = economy.ap
    moveCosts[actor.id] = Object.freeze(
      Object.fromEntries(
        Object.entries(definition.moves).map(([id, move]) => [
          id,
          combatActionCost(
            move,
            economy,
            combatValueContext(
              definition,
              resources,
              statuses,
              actor.id,
              move.type === 'guard' || (move.type === 'ability' && move.target === 'self')
                ? actor.id
                : actor.id === definition.player.id
                  ? (target ?? definition.enemies[0]?.id)
                  : definition.player.id,
            ),
          ),
        ]),
      ),
    )
  }

  return Object.freeze({ ap: Object.freeze(ap), moveCosts: Object.freeze(moveCosts) })
}
