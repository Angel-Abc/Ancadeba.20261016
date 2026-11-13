import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import {
  combatEventValueFields,
  combatEventFlagFields,
  combatEffectActorSchema,
} from './combatEvents.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const operator = z.enum(['eq', 'gte', 'lte', 'gt', 'lt'])

const scalar = z
  .object({
    operator,
    value: z.number().finite().nonnegative(),
    unit: z.enum(['absolute', 'percent']).optional(),
  })
  .superRefine((value, context) => {
    if (value.unit === 'percent') {
      if (value.value > 100 || Math.abs(value.value * 100 - Math.round(value.value * 100)) > 1e-8)
        context.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'Percent thresholds must be 0–100 with at most two decimal places',
        })
    } else if (!Number.isSafeInteger(value.value))
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Absolute thresholds must be nonnegative safe integers',
      })
  })

const leaves = [
  z.object({
    type: z.literal('event-value'),
    field: z.enum(combatEventValueFields),
    operator,
    value: z.number().int().nonnegative().safe(),
  }),
  z.object({
    type: z.literal('event-flag'),
    field: z.enum(combatEventFlagFields),
    value: z.boolean(),
  }),
  scalar.safeExtend({ type: z.literal('resource'), resource: id }),
  scalar.safeExtend({ type: z.literal('health'), actor: combatEffectActorSchema }),
  z.object({ type: z.literal('phase'), phase: id }),
  z.object({
    type: z.literal('status'),
    actor: combatEffectActorSchema,
    status: id,
    measure: z.enum(['stacks', 'intensity', 'remaining']).default('stacks'),
    operator,
    value: z.number().int().nonnegative().safe(),
  }),
] as const

export type CombatConditionLeaf = z.infer<(typeof leaves)[number]>

export type CombatCondition =
  | CombatConditionLeaf
  | { type: 'and'; conditions: CombatCondition[] }
  | { type: 'or'; conditions: CombatCondition[] }
  | { type: 'not'; condition: CombatCondition }

const tree: z.ZodType<CombatCondition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    ...leaves,
    z.object({ type: z.literal('and'), conditions: z.array(tree).min(1).max(20) }),
    z.object({ type: z.literal('or'), conditions: z.array(tree).min(1).max(20) }),
    z.object({ type: z.literal('not'), condition: tree }),
  ]),
)

/** Reject excessive/cyclic trees before recursive parsing; valid JSON expressions stay bounded. */
export const combatConditionSchema = z
  .unknown()
  .superRefine((value, context) => {
    const pending = [{ value, depth: 1 }]
    let count = 0

    while (pending.length) {
      const entry = pending.pop()!

      if (++count > 100 || entry.depth > 8) {
        context.addIssue({
          code: 'custom',
          message: 'Conditions support at most 100 nodes and eight levels',
        })

        return
      }

      if (entry.value !== null && typeof entry.value === 'object') {
        const type = Object.getOwnPropertyDescriptor(entry.value, 'type')?.value

        const children =
          type === 'not'
            ? [Object.getOwnPropertyDescriptor(entry.value, 'condition')?.value]
            : type === 'and' || type === 'or'
              ? Object.getOwnPropertyDescriptor(entry.value, 'conditions')?.value
              : []

        if (Array.isArray(children))
          for (const child of children) pending.push({ value: child, depth: entry.depth + 1 })
      }
    }
  })
  .pipe(tree)

export function visitCombatCondition(
  condition: CombatCondition,
  visit: (leaf: CombatConditionLeaf, path: (string | number)[]) => void,
  path: (string | number)[] = [],
): void {
  if (condition.type === 'and' || condition.type === 'or')
    condition.conditions.forEach((child, index) =>
      visitCombatCondition(child, visit, [...path, 'conditions', index]),
    )
  else if (condition.type === 'not')
    visitCombatCondition(condition.condition, visit, [...path, 'condition'])
  else visit(condition, path)
}

export function bindCombatCondition(
  condition: CombatCondition,
  actor: (id: string) => string,
): CombatCondition {
  if (condition.type === 'and' || condition.type === 'or')
    return {
      ...condition,
      conditions: condition.conditions.map((entry) => bindCombatCondition(entry, actor)),
    }

  if (condition.type === 'not')
    return { ...condition, condition: bindCombatCondition(condition.condition, actor) }

  return 'actor' in condition
    ? {
        ...condition,
        actor: condition.actor.startsWith('event.') ? condition.actor : actor(condition.actor),
      }
    : { ...condition }
}

export function combatConditionIssues(
  condition: CombatCondition,
  references: {
    actors?: readonly string[]
    resources?: Readonly<Record<string, unknown>>
    statuses?: Readonly<Record<string, unknown>>
    phases?: Readonly<Record<string, unknown>>
    event?: boolean
  },
  path: (string | number)[] = [],
) {
  const issues: { path: (string | number)[]; message: string }[] = []
  visitCombatCondition(condition, (leaf, child) => {
    if ((leaf.type === 'event-value' || leaf.type === 'event-flag') && !references.event)
      issues.push({
        path: [...path, ...child],
        message: 'Event conditions require a damage or healing event',
      })

    if ('actor' in leaf && leaf.actor.startsWith('event.') && !references.event)
      issues.push({
        path: [...path, ...child, 'actor'],
        message: 'Event actors require a damage or healing event',
      })

    if (
      'actor' in leaf &&
      references.actors &&
      ![
        'self',
        'target',
        ...(references.event ? ['event.source', 'event.target'] : []),
        ...references.actors,
      ].includes(leaf.actor)
    )
      issues.push({
        path: [...path, ...child, 'actor'],
        message: `Unknown combat actor: ${leaf.actor}`,
      })

    for (const key of ['resource', 'status', 'phase'] as const) {
      const entries =
        key === 'resource'
          ? references.resources
          : key === 'status'
            ? references.statuses
            : references.phases

      if (key in leaf && entries) {
        const value = Object.getOwnPropertyDescriptor(leaf, key)?.value

        if (!Object.hasOwn(entries, value))
          issues.push({
            path: [...path, ...child, key],
            message: `Unknown combat ${key}: ${value}`,
          })
      }
    }
  })

  return issues
}
