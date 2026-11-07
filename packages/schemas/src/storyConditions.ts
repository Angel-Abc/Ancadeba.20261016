import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
)

export const storyPathSchema = z.array(id).min(1)
export const questStatusSchema = z.enum(['not-started', 'active', 'ready', 'completed'])

export const worldConditionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('scene-is'), scene: id }),
  z.strictObject({
    type: z.literal('state-is'),
    path: storyPathSchema,
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.strictObject({
    type: z.literal('state-compare'),
    path: storyPathSchema,
    operator: z.enum(['eq', 'gte', 'lte', 'gt', 'lt']),
    value: z.number().finite(),
  }),
  z.strictObject({ type: z.literal('item-carried-by'), item: id, owner: id }),
  z.strictObject({ type: z.literal('item-owned-by'), item: id, owner: id }),
  z.strictObject({
    type: z.literal('quest-state'),
    quest: id,
    status: questStatusSchema,
    stage: id.optional(),
  }),
  z.strictObject({
    type: z.literal('combat-outcome'),
    encounter: id,
    outcome: z.enum(['victory', 'defeat', 'escaped']),
  }),
])

export type WorldCondition = z.infer<typeof worldConditionSchema>
