import { combatDamageTypeSchema, combatDamageDefensesSchema } from './combatDamage.js'
import { combatRestrictionFields } from './combatRestrictions.js'
import { combatScalingSchema, combatPercentModifiersSchema } from './combatValues.js'
import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import { combatConditionSchema } from './combatConditions.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const amount = z.number().int().nonnegative().safe()
const target = z.enum(['self', 'target']).optional()
const conditional = { conditions: z.array(combatConditionSchema).max(20).optional() }
export const combatStatusStrengthSchema = z.number().int().positive().max(100)
export const temporaryModifierNames = ['attack', 'defense', 'guard', 'ap', 'apCost'] as const

export const temporaryModifiersSchema = z.object({
  attack: z.number().int().safe().optional(),
  defense: z.number().int().safe().optional(),
  guard: z.number().int().safe().optional(),
  ap: z.number().int().safe().optional(),
  apCost: z.number().int().safe().optional(),
})

export const abilityEffectSchema = z.discriminatedUnion('type', [
  z.object({
    id,
    type: z.literal('change-resource'),
    ...conditional,
    target,
    resource: id,
    amount: z.number().int().safe(),
  }),
  z.object({
    id,
    type: z.literal('damage'),
    damageType: combatDamageTypeSchema.optional(),
    scaling: combatScalingSchema.optional(),
    ...conditional,
    target,
    damage: z
      .object({ min: amount, max: amount })
      .refine((range) => range.min <= range.max, 'Invalid damage range'),
  }),
  z.object({
    id,
    ...conditional,
    type: z.literal('heal'),
    target,
    amount,
    scaling: combatScalingSchema.optional(),
  }),
  z.object({
    id,
    ...conditional,
    type: z.literal('guard'),
    target,
    amount,
    scaling: combatScalingSchema.optional(),
  }),
  z.object({
    id,
    type: z.literal('apply-status'),
    ...conditional,
    target,
    status: id,
    stacks: combatStatusStrengthSchema.optional(),
    intensity: combatStatusStrengthSchema.optional(),
  }),
  z.object({
    id,
    type: z.literal('remove-status'),
    ...conditional,
    target,
    status: id,
    stacks: combatStatusStrengthSchema.optional(),
  }),
])

const presentation = {
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
  icon: id.optional(),
  damageDefenses: combatDamageDefensesSchema.optional(),
  ...combatRestrictionFields,
  duration: z.number().int().positive().max(1000),
  stacking: z
    .object({
      maximum: combatStatusStrengthSchema,
      duration: z.enum(['refresh', 'preserve']).default('refresh'),
    })
    .optional(),
  intensity: z
    .object({
      initial: combatStatusStrengthSchema.default(1),
      maximum: combatStatusStrengthSchema,
      reapply: z.enum(['replace', 'maximum', 'add']).default('replace'),
    })
    .refine((value) => value.initial <= value.maximum, 'Initial intensity exceeds maximum')
    .optional(),
}

export const combatStatusSchema = z
  .discriminatedUnion('type', [
    z.object({
      ...presentation,
      type: z.literal('damage'),
      amount,
      damageType: combatDamageTypeSchema.optional(),
    }),
    z.object({ ...presentation, type: z.literal('regeneration'), amount }),
    z.object({
      ...presentation,
      type: z.literal('modifier'),
      modifiers: temporaryModifiersSchema,
      percentModifiers: combatPercentModifiersSchema.optional(),
    }),
    z.object({ ...presentation, type: z.literal('stun') }),
    z
      .object({
        ...presentation,
        type: z.literal('composite'),
        damage: amount.optional(),
        damageType: combatDamageTypeSchema.optional(),
        regeneration: amount.optional(),
        modifiers: temporaryModifiersSchema.optional(),
        percentModifiers: combatPercentModifiersSchema.optional(),
        stun: z.boolean().optional(),
      })
      .refine(
        (status) =>
          status.damage !== undefined ||
          status.regeneration !== undefined ||
          status.modifiers !== undefined ||
          status.percentModifiers !== undefined ||
          status.damageDefenses !== undefined ||
          status.statusImmunities !== undefined ||
          status.blockedMoveCategories !== undefined ||
          status.stun === true,
        'Choose at least one composite status effect',
      ),
  ])
  .refine(
    (status) => Boolean(status.label || status.labelKey),
    'A status label or translation is required',
  )
  .superRefine((status, context) => {
    if (
      status.type === 'composite' &&
      status.damageType !== undefined &&
      status.damage === undefined
    )
      context.addIssue({
        code: 'custom',
        path: ['damageType'],
        message: 'Damage type requires periodic damage',
      })
  })

export type CombatStatusDefinition = z.infer<typeof combatStatusSchema>

export type AbilityEffect = z.infer<typeof abilityEffectSchema>

export type TemporaryModifiers = z.infer<typeof temporaryModifiersSchema>

export function combatStatusApplicationIssues(
  effect: {
    type: 'apply-status' | 'remove-status'
    stacks?: number | undefined
    intensity?: number | undefined
  },
  status: CombatStatusDefinition,
) {
  const issues: { path: string[]; message: string }[] = []

  if (effect.type === 'apply-status' && (effect.stacks ?? 1) > (status.stacking?.maximum ?? 1))
    issues.push({ path: ['stacks'], message: 'Applied stacks exceed the status maximum' })

  if ((effect.intensity ?? 1) > (status.intensity?.maximum ?? 1))
    issues.push({ path: ['intensity'], message: 'Applied intensity exceeds the status maximum' })

  return issues
}
