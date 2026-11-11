import { z } from 'zod'
import { worldConditionSchema } from './storyConditions.js'
import { bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import { sceneTransitionSchema } from './sceneTransition.js'

const id = bindingAliasSchema

const pathSchema = z
  .array(id.refine((segment) => !['__proto__', 'constructor', 'prototype'].includes(segment)))
  .min(1)

export const ruleTextSchema = z.union([
  z.string(),
  z.strictObject({ textKey: translationKeySchema }),
])

export const ruleValueSchema = z.union([ruleTextSchema, z.number(), z.boolean()])

export const ruleConditionSchema = z.discriminatedUnion('type', [
  ...worldConditionSchema.options,
  z.strictObject({ type: z.literal('payload-is-item'), item: id }),
  z.strictObject({ type: z.literal('payload-is-target'), target: id }),
])

export const ruleEffectSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('set-state'), path: pathSchema, value: ruleValueSchema }),
  z.strictObject({ type: z.literal('move-item'), item: id, owner: id }),
  z.strictObject({
    type: z.literal('collect-items'),
    items: z
      .array(id)
      .min(1)
      .max(100)
      .refine((items) => new Set(items).size === items.length, 'Choose each pickup item only once'),
    owner: id,
  }),
  sceneTransitionSchema,
  z.strictObject({ type: z.literal('append-log'), text: ruleTextSchema }),
  z.strictObject({ type: z.literal('start-quest'), quest: id }),
  z.strictObject({ type: z.literal('complete-quest'), quest: id }),
])

const branchSchema = z
  .strictObject({
    when: z.array(ruleConditionSchema),
    effects: z.array(ruleEffectSchema),
  })
  .superRefine((branch, context) => {
    if (
      branch.effects.filter(
        ({ type }) => type === 'move-item' || type === 'collect-items' || type === 'enter-scene',
      ).length > 1
    )
      context.addIssue({
        code: 'custom',
        path: ['effects'],
        message: 'Use at most one inventory operation or scene transition per branch',
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
