import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import { combatStatusStrengthSchema } from './combatAbilities.js'
import { combatConditionSchema } from './combatConditions.js'
import { combatDamageTypeSchema } from './combatDamage.js'
import {
  combatEffectEvents,
  combatEffectActorSchema,
  combatEffectDeliveries,
  combatEventValueSchema,
} from './combatEvents.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const amount = z.number().int().nonnegative().safe()

const presentation = {
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
}

export const combatResourceSchema = z
  .object({
    ...presentation,
    actor: id.optional(),
    initial: amount,
    maximum: amount.positive(),
  })
  .refine((resource) => resource.initial <= resource.maximum, 'Initial resource exceeds maximum')

export const combatTriggerConditionSchema = combatConditionSchema

const conditional = { conditions: z.array(combatConditionSchema).max(20).optional() }
const eventAmount = { eventValue: combatEventValueSchema.optional() }

export const combatTriggerEffectSchema = z.discriminatedUnion('type', [
  z.object({
    ...conditional,
    type: z.literal('change-resource'),
    resource: id,
    amount: z.number().int().safe(),
    ...eventAmount,
  }),
  z.object({
    ...conditional,
    ...eventAmount,
    type: z.literal('set-resource'),
    resource: id,
    amount,
  }),
  z.object({
    ...conditional,
    ...eventAmount,
    type: z.literal('damage'),
    actor: combatEffectActorSchema,
    source: combatEffectActorSchema.optional(),
    amount,
    damageType: combatDamageTypeSchema.optional(),
  }),
  z.object({
    ...conditional,
    ...eventAmount,
    type: z.literal('heal'),
    actor: combatEffectActorSchema,
    source: combatEffectActorSchema.optional(),
    amount,
  }),
  z.object({
    type: z.literal('apply-status'),
    ...conditional,
    actor: combatEffectActorSchema,
    status: id,
    stacks: combatStatusStrengthSchema.optional(),
    intensity: combatStatusStrengthSchema.optional(),
  }),
  z.object({
    type: z.literal('remove-status'),
    ...conditional,
    actor: combatEffectActorSchema,
    status: id,
    stacks: combatStatusStrengthSchema.optional(),
  }),
  z.object({ ...conditional, type: z.literal('set-phase'), phase: id }),
  z.object({ ...conditional, type: z.literal('finish'), outcome: z.enum(['victory', 'defeat']) }),
])

export const combatTriggerEvents = [
  'encounter-start',
  'round-start',
  'round-end',
  'turn-start',
  'turn-end',
  'action-resolved',
  'before-action',
  'after-action',
  'status-applied',
  'status-refreshed',
  'status-removed',
  'status-expired',
  'status-changed',
  ...combatEffectEvents,
  'resource-changed',
  'phase-enter',
] as const

export const combatTriggerSchema = z.object({
  event: z.enum(combatTriggerEvents),
  actor: id.optional(),
  move: id.optional(),
  resource: id.optional(),
  phase: id.optional(),
  status: id.optional(),
  source: id.optional(),
  target: id.optional(),
  damageType: combatDamageTypeSchema.optional(),
  delivery: z.enum(combatEffectDeliveries).optional(),
  includeReactions: z.boolean().optional(),
  once: z.boolean().default(false),
  conditions: z.array(combatTriggerConditionSchema).max(20).default([]),
  effects: z.array(combatTriggerEffectSchema).min(1).max(20),
})

export const combatPhaseSchema = z.object({
  ...presentation,
  onEnter: z.array(combatTriggerEffectSchema).max(20).default([]),
  enemyRotations: z.record(id, z.array(id).min(1)).optional(),
})

export const combatMechanicsSchema = z
  .object({
    resources: z.record(id, combatResourceSchema).default({}),
    triggers: z.record(id, combatTriggerSchema).default({}),
    phases: z.record(id, combatPhaseSchema).default({}),
    initialPhase: id.optional(),
    victory: z.enum(['enemies-defeated', 'triggers']).default('enemies-defeated'),
  })
  .superRefine((mechanics, context) => {
    for (const key of ['resources', 'triggers', 'phases'] as const)
      if (Object.keys(mechanics[key]).length > 100)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'At most 100 entries are supported',
        })

    if (Object.keys(mechanics.phases).length && !mechanics.initialPhase)
      context.addIssue({
        code: 'custom',
        path: ['initialPhase'],
        message: 'Choose an initial phase',
      })

    if (mechanics.initialPhase && !Object.hasOwn(mechanics.phases, mechanics.initialPhase))
      context.addIssue({ code: 'custom', path: ['initialPhase'], message: 'Unknown initial phase' })
  })

export type CombatMechanicsDefinition = z.infer<typeof combatMechanicsSchema>

export type CombatTriggerCondition = z.infer<typeof combatTriggerConditionSchema>

export type CombatTriggerEffect = z.infer<typeof combatTriggerEffectSchema>

export type CombatTriggerEvent = (typeof combatTriggerEvents)[number]

/** Encounter-local state, saved independently of authored definitions and world state. */
export const combatMechanicsStateSchema = z.strictObject({
  resources: z.record(id, amount),
  phase: id.optional(),
  fired: z.array(id).max(100),
  initialized: z.boolean(),
})

export type CombatMechanicsState = z.infer<typeof combatMechanicsStateSchema>
