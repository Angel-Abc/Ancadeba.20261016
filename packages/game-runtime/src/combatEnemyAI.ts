import { combatMoveRequirements } from './combatRequirements.js'
import { combatValueContext, combatResourceCosts } from './combatValues.js'
import { combatActorMoves } from './combatEquipment.js'
import type { CombatEquipment } from '@ancadeba/schemas'
import { combatMoveRestriction } from './combatRestrictions.js'
import type {
  CombatActorDefinition,
  CombatDefinition,
  CombatEnemyCondition,
  CombatMechanicsState,
} from '@ancadeba/schemas'
import { combatActorEconomy, combatActionCost } from './combatActionEconomy.js'
import {
  combatMoveTarget,
  combatStunned,
  cooldownRemaining,
  type CombatStatuses,
  type CombatCooldowns,
} from './combatEffects.js'
import { combatResourceIssue } from './combatMechanics.js'
import type { PlannedMove } from './combatResolution.js'
import { cloneCombatRules } from '@ancadeba/schemas'
import type { EnemyDecisionTrace, EnemyCandidateTrace, EnemyBlocker } from './combatDebug.js'
import {
  evaluateCombatCondition,
  combatConditionContext,
  type CombatConditionContext,
} from './combatConditions.js'

interface EnemyContext extends CombatConditionContext {
  readonly equipment?: CombatEquipment | undefined
  readonly health: Readonly<Record<string, number>>
  readonly statuses: CombatStatuses
  readonly cooldowns: CombatCooldowns
  readonly resources: Readonly<Record<string, number>>
  readonly phase: string | undefined
  readonly round: number
}

/** Transient per-turn memory. Previews and resolution each own their copy. */
export function enemyDecisionState(cursor = 0) {
  return { cursor, uses: new Map<string, number>(), reserved: new Set<string>() }
}

export function enemyConditionMatches(
  condition: CombatEnemyCondition,
  context: EnemyContext,
): boolean {
  return evaluateCombatCondition(condition, context).matched
}

export function enemyConditionValue(
  condition: CombatEnemyCondition,
  context: EnemyContext,
): number | string | boolean | undefined {
  return evaluateCombatCondition(condition, context).actual
}

/** First executable matching rule wins. Conditions never spend RNG or simulate future effects. */
export function chooseEnemyAction(
  definition: CombatDefinition,
  actor: CombatActorDefinition,
  context: EnemyContext,
  state: ReturnType<typeof enemyDecisionState>,
  spentAp = 0,
  trace?: (decision: EnemyDecisionTrace) => void,
): PlannedMove | undefined {
  context = {
    ...context,
    ...combatConditionContext(definition, {
      ...context,
      self: actor.id,
      target: definition.player.id,
    }),
  }
  const economy = combatActorEconomy(definition, actor, context.statuses[actor.id])
  const candidates: EnemyCandidateTrace[] = []
  const startCursor = state.cursor

  const finish = (stop: EnemyDecisionTrace['stop'], choice?: PlannedMove) => {
    if (trace)
      trace(
        cloneCombatRules({
          actor: actor.id,
          round: context.round,
          phase: context.phase,
          ap: economy.ap,
          spentAp,
          remainingAp: Math.max(0, economy.ap - spentAp),
          cursor: startCursor,
          candidates,
          choice,
          stop,
        }),
      )

    return choice
  }

  if (!(context.health[actor.id]! > 0)) return finish('defeated')

  if (!(context.health[definition.player.id]! > 0)) return finish('player-defeated')

  if (combatStunned(definition, context.statuses[actor.id])) return finish('stunned')

  const executable = (
    id: string,
    rule?: NonNullable<CombatActorDefinition['ai']>['rules'][number],
  ) => {
    const move = definition.moves[id]!

    const values = combatValueContext(
      definition,
      context.resources,
      context.statuses,
      actor.id,
      combatMoveTarget(move) === 'self' ? actor.id : definition.player.id,
    )

    const cost = combatActionCost(move, economy, values)
    const cooldown = cooldownRemaining(context.cooldowns, actor.id, id, context.round)
    const resource = combatResourceIssue(move, context.resources, [], {}, values)

    const restriction = combatMoveRestriction(
      definition,
      actor.id,
      move,
      context.statuses,
      context.equipment,
    )

    const conditions =
      rule?.conditions.map((condition) =>
        evaluateCombatCondition(condition, {
          ...context,
          target: combatMoveTarget(move) === 'self' ? actor.id : definition.player.id,
        }),
      ) ?? []

    const requirements = combatMoveRequirements(definition, move, {
      ...context,
      self: actor.id,
      target: combatMoveTarget(move) === 'self' ? actor.id : definition.player.id,
    })

    const uses = rule ? (state.uses.get(rule.id) ?? 0) : undefined
    const blockers: EnemyBlocker[] = []

    if (!combatActorMoves(actor, context.equipment).includes(id)) blockers.push('equipment')

    if (rule && uses! >= rule.maxUses) blockers.push('use-limit')

    if (conditions.some((condition) => !condition.matched)) blockers.push('condition')

    if (cost > economy.ap - spentAp) blockers.push('ap')

    if (cooldown) blockers.push('cooldown')

    if (state.reserved.has(id)) blockers.push('reserved')

    if (resource) blockers.push('resource')

    if (restriction) blockers.push('restriction')

    if (requirements.some((entry) => !entry.matched)) blockers.push('requirements')

    if (trace)
      candidates.push(
        cloneCombatRules({
          kind: rule ? 'rule' : 'rotation',
          rule: rule?.id,
          move: id,
          uses,
          maximumUses: rule?.maxUses,
          conditions,
          ...(requirements.length ? { requirements } : {}),
          blockers,
          cost,
          cooldown,
          resource,
          ...(restriction ? { restriction } : {}),
          required: resource ? combatResourceCosts(move, values)[resource] : undefined,
          available: resource ? context.resources[resource] : undefined,
          selected: !blockers.length,
        }),
      )

    return !blockers.length
  }

  const chosen = (id: string) => {
    const move = definition.moves[id]!

    if (move.cooldown) state.reserved.add(id)

    return { move: id, target: combatMoveTarget(move) === 'self' ? actor.id : definition.player.id }
  }

  for (const rule of actor.ai?.rules ?? []) {
    if (!executable(rule.move, rule)) continue

    state.uses.set(rule.id, (state.uses.get(rule.id) ?? 0) + 1)

    return finish('chosen', chosen(rule.move))
  }

  if (actor.ai?.fallback === 'wait') return finish('wait')

  const rotation =
    definition.mechanics?.phases[context.phase ?? '']?.enemyRotations?.[actor.id] ?? actor.rotation

  for (let index = 0; index < rotation.length; index++) {
    const position = (state.cursor + index) % rotation.length
    const id = rotation[position]!

    if (!executable(id)) continue
    state.cursor = (position + 1) % rotation.length

    return finish('chosen', chosen(id))
  }

  return finish('unavailable')
}

export function planEnemyTurn(
  definition: CombatDefinition,
  actor: CombatActorDefinition,
  health: Readonly<Record<string, number>>,
  cursor: number,
  round: number,
  statuses: CombatStatuses,
  cooldowns: CombatCooldowns,
  mechanics: CombatMechanicsState | undefined,
  trace?: (decision: EnemyDecisionTrace) => void,
  maximumHealth?: Readonly<Record<string, number>>,
  equipment?: CombatEquipment,
) {
  const state = enemyDecisionState(cursor)
  const resources = { ...mechanics?.resources }

  const context = {
    equipment,
    health,
    maximumHealth,
    round,
    statuses,
    cooldowns,
    resources,
    phase: mechanics?.phase,
  }

  const moves: PlannedMove[] = []
  let spentAp = 0

  // AP is capped at 100 and each action costs at least one, including discounted actions.
  for (let index = 0; index < 100; index++) {
    const move = chooseEnemyAction(definition, actor, context, state, spentAp, trace)

    if (!move) break
    moves.push(move)
    const authored = definition.moves[move.move]!
    const values = combatValueContext(definition, resources, statuses, actor.id, move.target)
    spentAp += combatActionCost(
      authored,
      combatActorEconomy(definition, actor, statuses[actor.id]),
      values,
    )

    for (const [id, cost] of Object.entries(combatResourceCosts(authored, values)))
      resources[id]! -= cost
  }

  return {
    moves,
    cursor: state.cursor,
    ...(definition.statuses || actor.ai ? { startCursor: cursor } : {}),
  }
}
