import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const amount = z.number().int().nonnegative().safe()
const target = z.enum(['self', 'target']).optional()

export const temporaryModifiersSchema = z.object({
  attack: z.number().int().safe().optional(),
  defense: z.number().int().safe().optional(),
  guard: z.number().int().safe().optional(),
})

export const abilityEffectSchema = z.discriminatedUnion('type', [
  z.object({
    id,
    type: z.literal('damage'),
    target,
    damage: z
      .object({ min: amount, max: amount })
      .refine((range) => range.min <= range.max, 'Invalid damage range'),
  }),
  z.object({ id, type: z.literal('heal'), target, amount }),
  z.object({ id, type: z.literal('guard'), target, amount }),
  z.object({ id, type: z.literal('apply-status'), target, status: id }),
  z.object({ id, type: z.literal('remove-status'), target, status: id }),
])

const presentation = {
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
  icon: id.optional(),
  duration: z.number().int().positive().max(1000),
}

export const combatStatusSchema = z
  .discriminatedUnion('type', [
    z.object({ ...presentation, type: z.literal('damage'), amount }),
    z.object({ ...presentation, type: z.literal('regeneration'), amount }),
    z.object({ ...presentation, type: z.literal('modifier'), modifiers: temporaryModifiersSchema }),
    z.object({ ...presentation, type: z.literal('stun') }),
  ])
  .refine(
    (status) => Boolean(status.label || status.labelKey),
    'A status label or translation is required',
  )

export type CombatStatusDefinition = z.infer<typeof combatStatusSchema>

export type AbilityEffect = z.infer<typeof abilityEffectSchema>

export type TemporaryModifiers = z.infer<typeof temporaryModifiersSchema>
