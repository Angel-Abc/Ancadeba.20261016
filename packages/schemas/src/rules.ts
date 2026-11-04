import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'

const id = bindingAliasSchema

const pathSchema = z
  .array(id.refine((segment) => !['__proto__', 'constructor', 'prototype'].includes(segment)))
  .min(1)

const scalar = z.union([z.string(), z.number(), z.boolean()])

export const ruleTextSchema = z.union([
  z.string(),
  z.strictObject({ textKey: translationKeySchema }),
])

export const ruleValueSchema = z.union([ruleTextSchema, z.number(), z.boolean()])

export const ruleConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('scene-is'), scene: id }),
  z.strictObject({ type: z.literal('state-is'), path: pathSchema, value: scalar }),
  z.strictObject({ type: z.literal('item-carried-by'), item: id, owner: id }),
  z.strictObject({ type: z.literal('payload-is-item'), item: id }),
])

export const ruleEffectSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('set-state'), path: pathSchema, value: ruleValueSchema }),
  z.strictObject({ type: z.literal('move-item'), item: id, owner: id }),
  z.strictObject({ type: z.literal('enter-scene'), scene: id, mapView: id.optional() }),
  z.strictObject({ type: z.literal('append-log'), text: ruleTextSchema }),
])

const branchSchema = z
  .strictObject({
    when: z.array(ruleConditionSchema),
    effects: z.array(ruleEffectSchema),
  })
  .superRefine((branch, context) => {
    if (
      branch.effects.filter(({ type }) => type === 'move-item' || type === 'enter-scene').length > 1
    )
      context.addIssue({
        code: 'custom',
        path: ['effects'],
        message: 'Use at most one inventory move or scene transition per branch',
      })
  })

export const gameRulesSchema = z.strictObject({
  state: z.array(z.strictObject({ path: pathSchema, value: ruleValueSchema })),
  actions: z.record(id, z.array(branchSchema).min(1)),
  clock: z
    .strictObject({ path: pathSchema, startMinute: z.number().int().min(0).max(1439) })
    .optional(),
  log: z
    .strictObject({
      path: pathSchema,
      capacity: z.number().int().positive().safe(),
      initial: z.array(ruleTextSchema),
    })
    .optional(),
})

export type GameRulesDefinition = z.infer<typeof gameRulesSchema>

export type RuleCondition = z.infer<typeof ruleConditionSchema>

export type RuleEffect = z.infer<typeof ruleEffectSchema>

export type RuleValue = z.infer<typeof ruleValueSchema>

export type RuleText = z.infer<typeof ruleTextSchema>

export type RuleBranch = z.infer<typeof branchSchema>

export function ruleValueType(value: RuleValue): 'string' | 'number' | 'boolean' {
  if (typeof value === 'number') return 'number'

  return typeof value === 'boolean' ? 'boolean' : 'string'
}
