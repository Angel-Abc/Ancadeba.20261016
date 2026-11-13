import { combatEffectEventValue } from './combatEventValues.js'
import {
  cloneCombatRules,
  type CombatCondition,
  type CombatConditionLeaf,
  type CombatDefinition,
  type CombatEffectEventData,
} from '@ancadeba/schemas'
import type { CombatStatuses } from './combatEffects.js'

export interface CombatConditionContext {
  readonly stats?:
    | Readonly<Record<string, Readonly<import('@ancadeba/schemas').CombatBonuses>>>
    | undefined
  readonly round?: number | undefined
  readonly event?: CombatEffectEventData | undefined
  readonly health: Readonly<Record<string, number>>
  readonly maximumHealth?: Readonly<Record<string, number>> | undefined
  readonly resources: Readonly<Record<string, number>>
  readonly resourceMaximums?: Readonly<Record<string, number>> | undefined
  readonly statuses: CombatStatuses
  readonly phase: string | undefined
  readonly self?: string | undefined
  readonly target?: string | undefined
}

export interface CombatConditionEvaluation {
  readonly condition: CombatCondition
  readonly actual: number | string | boolean | undefined
  readonly current?: number | undefined
  readonly maximum?: number | undefined
  readonly available: boolean
  readonly matched: boolean
  readonly children?: readonly CombatConditionEvaluation[] | undefined
}

function compare(
  operator: 'eq' | 'gte' | 'lte' | 'gt' | 'lt',
  left: number | bigint,
  right: number | bigint,
) {
  switch (operator) {
    case 'eq':
      return left === right
    case 'gte':
      return left >= right
    case 'lte':
      return left <= right
    case 'gt':
      return left > right
    case 'lt':
      return left < right
  }
}

interface CombatConditionValue {
  actual: number | string | boolean | undefined
  current?: number
  maximum?: number
}

function leafValue(
  condition: CombatConditionLeaf,
  context: CombatConditionContext,
): CombatConditionValue {
  if (condition.type === 'event-value' || condition.type === 'event-flag')
    return {
      actual:
        condition.type === 'event-value'
          ? combatEffectEventValue(context.event, condition.field)
          : context.event
            ? condition.field === 'redirected'
              ? (context.event.redirected ?? false)
              : context.event[condition.field]
            : undefined,
    }
  const reference = 'actor' in condition ? condition.actor : undefined

  const actor =
    reference === 'event.source'
      ? context.event?.source
      : reference === 'event.target'
        ? context.event?.target
        : reference === 'self'
          ? context.self
          : reference === 'target'
            ? context.target
            : reference

  if (condition.type === 'phase') return { actual: context.phase }

  if (condition.type === 'status') {
    if (!actor || !Object.hasOwn(context.health, actor)) return { actual: undefined }
    const active = context.statuses[actor]?.find((status) => status.id === condition.status)

    return { actual: active ? (active[condition.measure] ?? 1) : 0 }
  }

  const current =
    condition.type === 'resource'
      ? context.resources[condition.resource]
      : actor
        ? context.health[actor]
        : undefined

  const maximum =
    condition.type === 'resource'
      ? context.resourceMaximums?.[condition.resource]
      : actor
        ? context.maximumHealth?.[actor]
        : undefined

  const values = {
    ...(current !== undefined ? { current } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  }

  if (condition.unit !== 'percent') return { actual: current, ...values }

  return {
    actual:
      current !== undefined && maximum !== undefined && maximum > 0
        ? (current / maximum) * 100
        : undefined,
    ...values,
  }
}

export function evaluateCombatCondition(
  condition: CombatCondition,
  context: CombatConditionContext,
): CombatConditionEvaluation {
  if (condition.type === 'and' || condition.type === 'or' || condition.type === 'not') {
    const children = (condition.type === 'not' ? [condition.condition] : condition.conditions).map(
      (child) => evaluateCombatCondition(child, context),
    )

    const knownFalse = children.some((child) => child.available && !child.matched)
    const knownTrue = children.some((child) => child.available && child.matched)
    const allKnown = children.every((child) => child.available)

    const available =
      condition.type === 'not'
        ? allKnown
        : condition.type === 'and'
          ? knownFalse || allKnown
          : knownTrue || allKnown

    const matched =
      available &&
      (condition.type === 'not'
        ? !children[0]!.matched
        : condition.type === 'and'
          ? !knownFalse
          : knownTrue)

    return {
      condition: cloneCombatRules(condition),
      actual: undefined,
      available,
      matched,
      children,
    }
  }

  const value = leafValue(condition, context)
  const available = value.actual !== undefined
  let matched = false

  if (available) {
    if (condition.type === 'phase') matched = value.actual === condition.phase
    else if (condition.type === 'event-flag') matched = value.actual === condition.value
    else if (
      (condition.type === 'health' || condition.type === 'resource') &&
      condition.unit === 'percent'
    ) {
      if (
        value.current !== undefined &&
        value.maximum !== undefined &&
        Number.isSafeInteger(value.current) &&
        Number.isSafeInteger(value.maximum)
      )
        matched = compare(
          condition.operator,
          BigInt(value.current) * 10000n,
          BigInt(value.maximum) * BigInt(Math.round(condition.value * 100)),
        )
    } else if (typeof value.actual === 'number')
      matched = compare(condition.operator, value.actual, condition.value)
  }

  return { condition: cloneCombatRules(condition), ...value, available, matched }
}

export function combatConditionsMatch(
  conditions: readonly CombatCondition[] | undefined,
  context: CombatConditionContext,
): boolean {
  return (
    conditions?.every((condition) => evaluateCombatCondition(condition, context).matched) ?? true
  )
}

export function combatConditionContext(
  definition: CombatDefinition,
  context: Omit<CombatConditionContext, 'resourceMaximums' | 'maximumHealth'> & {
    maximumHealth?: Readonly<Record<string, number>> | undefined
  },
): CombatConditionContext {
  return {
    ...context,
    resourceMaximums: Object.fromEntries(
      Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => [
        id,
        resource.maximum,
      ]),
    ),
    maximumHealth: {
      ...Object.fromEntries(
        [definition.player, ...definition.enemies].flatMap((actor) =>
          typeof actor.maximumHealth === 'number' && actor.maximumHealth > 0
            ? [[actor.id, actor.maximumHealth]]
            : [],
        ),
      ),
      ...context.maximumHealth,
    },
  }
}
