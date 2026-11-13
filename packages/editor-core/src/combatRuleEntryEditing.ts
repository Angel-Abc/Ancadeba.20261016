import { object } from './project.js'

export function mergeCombatRuleFields(
  previous: unknown,
  next: Record<string, unknown>,
  optional: readonly string[] = [],
) {
  const result = { ...object(previous), ...next }

  for (const key of optional) result[key] = next[key]

  return result
}

export function mergeCombatRuleEffects(
  previous: unknown,
  next: readonly Record<string, unknown>[],
) {
  return next.map((entry, index) => {
    const old = Array.isArray(previous) ? previous[index] : undefined

    return {
      ...mergeCombatRuleFields(old, entry, [
        'actor',
        'resource',
        'status',
        'phase',
        'amount',
        'outcome',
        'stacks',
        'intensity',
        'source',
        'damageType',
        'eventValue',
        'percent',
        'maximum',
        'minimumHealth',
      ]),
      eventValue: entry.eventValue
        ? {
            ...object(object(old).eventValue),
            ...object(entry.eventValue),
            rounding: object(entry.eventValue).rounding,
          }
        : undefined,
      conditions: Array.isArray(entry.conditions)
        ? mergeCombatRuleConditions(object(old).conditions, entry.conditions)
        : undefined,
    }
  })
}

export function mergeCombatRuleConditions(
  previous: unknown,
  next: readonly Record<string, unknown>[],
) {
  return next.map((entry, index) =>
    mergeCondition(Array.isArray(previous) ? previous[index] : undefined, entry),
  )
}

export interface MergedCondition extends Record<string, unknown> {
  conditions: MergedCondition[] | undefined
  condition: MergedCondition | undefined
}

function mergeCondition(previous: unknown, entry: Record<string, unknown>): MergedCondition {
  return {
    ...mergeCombatRuleFields(previous, entry, [
      'actor',
      'resource',
      'phase',
      'operator',
      'value',
      'status',
      'measure',
      'unit',
      'field',
    ]),
    conditions: Array.isArray(entry.conditions)
      ? mergeCombatRuleConditions(object(previous).conditions, entry.conditions)
      : undefined,
    condition:
      entry.type === 'not'
        ? mergeCondition(object(previous).condition, object(entry.condition))
        : undefined,
  }
}
