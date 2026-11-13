import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import {
  combatEnemyAISchema,
  combatEnemyConditionSchema,
  type CombatEnemyAI,
} from './combatEnemyAI.js'
import { cloneCombatRules } from './combatRulesets.js'
import { bindCombatCondition } from './combatConditions.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

export const combatAIProfileSchema = z.object({
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
  actors: z
    .array(id.refine((role) => role !== 'self', 'Self is bound automatically'))
    .max(32)
    .refine((roles) => new Set(roles).size === roles.length, 'Actor roles must be unique')
    .default([]),
  ai: combatEnemyAISchema,
})

export const combatAIProfileReferenceSchema = z.object({
  library: id,
  id,
  actors: z.record(id, id).optional(),
})

export const combatAIOverridesSchema = z.object({
  rules: z
    .record(
      id,
      z
        .object({
          move: id.optional(),
          maxUses: z.number().int().positive().max(100).optional(),
          conditions: z.array(combatEnemyConditionSchema).max(20).optional(),
        })
        .nullable(),
    )
    .optional(),
  fallback: z.enum(['rotation', 'wait']).optional(),
  ruleOrder: z
    .array(id)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Rule order must be unique')
    .optional(),
})

export type CombatAIProfile = z.infer<typeof combatAIProfileSchema>

export type CombatAIOverrides = z.infer<typeof combatAIOverridesSchema>

export function bindCombatAIProfile(
  profile: CombatAIProfile,
  self: string,
  bindings: Readonly<Record<string, string>> = {},
): CombatEnemyAI {
  const ai = cloneCombatRules(profile.ai)

  for (const rule of ai.rules)
    rule.conditions = rule.conditions.map((condition) =>
      bindCombatCondition(condition, (actor) =>
        actor === 'self' ? self : (bindings[actor] ?? actor),
      ),
    )

  return ai
}

/** A nonvalidating draft preview lets the editor keep incomplete new rules editable. */
export function previewCombatAIOverrides(
  base: CombatEnemyAI,
  overrides?: CombatAIOverrides,
): CombatEnemyAI {
  const result = cloneCombatRules(base)

  if (!overrides) return result
  const rules = new Map(result.rules.map((rule) => [rule.id, rule]))

  for (const [id, patch] of Object.entries(overrides.rules ?? {})) {
    if (patch === null) rules.delete(id)
    else {
      const previous = rules.get(id)
      rules.set(id, {
        id,
        conditions: cloneCombatRules(patch.conditions ?? previous?.conditions ?? []),
        maxUses: patch.maxUses ?? previous?.maxUses ?? 1,
        move: patch.move ?? previous?.move ?? '',
      })
    }
  }

  result.rules = [
    ...(overrides.ruleOrder ?? []).flatMap((id) => (rules.has(id) ? [rules.get(id)!] : [])),
    ...[...rules.values()].filter((rule) => !overrides.ruleOrder?.includes(rule.id)),
  ]
  result.fallback = overrides.fallback ?? result.fallback

  return result
}

export function applyCombatAIOverrides(
  base: CombatEnemyAI,
  overrides?: CombatAIOverrides,
): CombatEnemyAI {
  const parsed = combatEnemyAISchema.parse(previewCombatAIOverrides(base, overrides))

  for (const id of overrides?.ruleOrder ?? [])
    if (!parsed.rules.some((rule) => rule.id === id))
      throw new Error(`Unknown rule in ruleOrder: ${id}`)

  return parsed
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true

  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => equal(value, right[index]))

  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object')
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(([key, value]) =>
        equal(value, Object.getOwnPropertyDescriptor(right, key)?.value),
      )
    )

  return false
}

/** Emit only changed fields; untouched rules continue following their profile. */
export function diffCombatAI(base: CombatEnemyAI, edited: CombatEnemyAI): CombatAIOverrides {
  const patch: CombatAIOverrides = {}
  const rules: NonNullable<CombatAIOverrides['rules']> = {}

  for (const previous of base.rules)
    if (!edited.rules.some((rule) => rule.id === previous.id)) rules[previous.id] = null

  for (const rule of edited.rules) {
    const previous = base.rules.find((entry) => entry.id === rule.id)

    const changes = {
      ...(previous?.move !== rule.move ? { move: rule.move } : {}),
      ...(previous?.maxUses !== rule.maxUses ? { maxUses: rule.maxUses } : {}),
      ...(!equal(previous?.conditions, rule.conditions)
        ? { conditions: cloneCombatRules(rule.conditions) }
        : {}),
    }

    if (Object.keys(changes).length) rules[rule.id] = changes
  }

  if (Object.keys(rules).length) patch.rules = rules

  if (base.fallback !== edited.fallback) patch.fallback = edited.fallback

  const natural = [
    ...base.rules
      .filter((rule) => edited.rules.some((entry) => entry.id === rule.id))
      .map((rule) => rule.id),
    ...edited.rules
      .filter((rule) => !base.rules.some((entry) => entry.id === rule.id))
      .map((rule) => rule.id),
  ]

  const order = edited.rules.map((rule) => rule.id)

  if (!equal(natural, order)) patch.ruleOrder = order

  return patch
}
