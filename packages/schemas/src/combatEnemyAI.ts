import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { combatConditionSchema } from './combatConditions.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

export const combatEnemyConditionSchema = combatConditionSchema

export const combatEnemyRuleSchema = z.object({
  id,
  conditions: z.array(combatEnemyConditionSchema).max(20).default([]),
  move: id,
  maxUses: z.number().int().positive().max(100).default(1),
})

export const combatEnemyAISchema = z.object({
  rules: z
    .array(combatEnemyRuleSchema)
    .max(100)
    .refine(
      (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
      'Enemy rule IDs must be unique',
    ),
  fallback: z.enum(['rotation', 'wait']).default('rotation'),
})

export type CombatEnemyCondition = z.infer<typeof combatEnemyConditionSchema>

export type CombatEnemyAI = z.infer<typeof combatEnemyAISchema>
