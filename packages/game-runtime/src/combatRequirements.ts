import type { CombatCondition, CombatDefinition, CombatMoveDefinition } from '@ancadeba/schemas'
import {
  combatConditionContext,
  evaluateCombatCondition,
  type CombatConditionContext,
  type CombatConditionEvaluation,
} from './combatConditions.js'
import { combatResourceCosts, combatValueContext } from './combatValues.js'
import type { PlannedMove } from './combatResolution.js'

/** Requirements inspect current state minus reserved costs; queued effects are never predicted. */
export function combatMoveRequirements(
  definition: CombatDefinition,
  move: CombatMoveDefinition,
  context: CombatConditionContext,
  plan: readonly PlannedMove[] = [],
): readonly CombatConditionEvaluation[] {
  if (!move.requirements?.length) return []
  const resources = { ...context.resources }

  for (const queued of plan) {
    const candidate = definition.moves[queued.move]

    if (!candidate) continue

    const values = combatValueContext(
      definition,
      context.resources,
      context.statuses,
      context.self ?? definition.player.id,
      queued.target,
      context,
    )

    for (const [id, amount] of Object.entries(combatResourceCosts(candidate, values))) {
      if (!Object.hasOwn(resources, id)) continue
      const next = resources[id]! - amount

      if (!Number.isSafeInteger(next))
        throw new RangeError('Combat requirement reservation overflow')
      resources[id] = Math.max(0, next)
    }
  }

  const resolved = combatConditionContext(definition, { ...context, resources })

  return move.requirements.map((condition) => evaluateCombatCondition(condition, resolved))
}

export function combatRequirementsText(
  definition: CombatDefinition,
  conditions: readonly CombatCondition[],
  options: {
    evaluations?: readonly CombatConditionEvaluation[]
    self?: string | undefined
    target?: string | undefined
  } = {},
): string {
  const messages = definition.messages

  const actor = (reference: string) => {
    const id =
      reference === 'self'
        ? (options.self ?? definition.player.id)
        : reference === 'target'
          ? options.target
          : reference

    return (
      [definition.player, ...definition.enemies].find((actor) => actor.id === id)?.label ??
      (reference === 'target' ? messages.target : reference)
    )
  }

  const operators = { eq: '=', gte: '≥', lte: '≤', gt: '>', lt: '<' }

  const text = (condition: CombatCondition, evaluation?: CombatConditionEvaluation): string => {
    if (condition.type === 'and' || condition.type === 'or')
      return `(${condition.conditions.map((child, index) => text(child, evaluation?.children?.[index])).join(` ${condition.type === 'and' ? messages.requirementAnd : messages.requirementOr} `)})`

    if (condition.type === 'not')
      return `${messages.requirementNot} (${text(condition.condition, evaluation?.children?.[0])})`
    const percent = 'unit' in condition && condition.unit === 'percent' ? '%' : ''

    const label =
      condition.type === 'resource'
        ? definition.mechanics?.resources[condition.resource]?.label || condition.resource
        : condition.type === 'health'
          ? `${actor(condition.actor)} · ${messages.health}`
          : condition.type === 'status'
            ? `${actor(condition.actor)} · ${definition.statuses?.[condition.status]?.label || condition.status} · ${condition.measure === 'stacks' ? messages.requirementStacks : condition.measure === 'intensity' ? messages.requirementIntensity : messages.requirementRemaining}`
            : messages.requirementPhase

    const expected =
      condition.type === 'phase'
        ? definition.mechanics?.phases[condition.phase]?.label || condition.phase
        : 'value' in condition
          ? String(condition.value) + percent
          : ''

    const requirement = `${label} ${'operator' in condition ? operators[condition.operator] : '='} ${expected}`

    if (!evaluation) return requirement

    const actual =
      evaluation.actual === undefined
        ? messages.requirementUnknown
        : condition.type === 'phase'
          ? definition.mechanics?.phases[String(evaluation.actual)]?.label ||
            String(evaluation.actual)
          : `${typeof evaluation.actual === 'number' && !Number.isInteger(evaluation.actual) ? Math.round(evaluation.actual * 100) / 100 : evaluation.actual}${percent}${percent && evaluation.current !== undefined ? ` (${evaluation.current}/${evaluation.maximum})` : ''}`

    return messages.requirementCurrent
      .replaceAll('{requirement}', requirement)
      .replaceAll('{actual}', actual)
  }

  return conditions
    .map((condition, index) => text(condition, options.evaluations?.[index]))
    .join(` ${messages.requirementAnd} `)
}

export function combatMoveRequirementIssue(
  definition: CombatDefinition,
  move: CombatMoveDefinition,
  context: CombatConditionContext,
  plan: readonly PlannedMove[] = [],
): string | undefined {
  const failed = combatMoveRequirements(definition, move, context, plan).filter(
    (evaluation) => !evaluation.matched,
  )

  if (!failed.length) return

  return definition.messages.requirementsUnavailable.replaceAll('{move}', move.label).replaceAll(
    '{requirements}',
    combatRequirementsText(
      definition,
      failed.map((entry) => entry.condition),
      { evaluations: failed, self: context.self, target: context.target },
    ),
  )
}
