import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'

export const combatEffectEvents = [
  'damage-received',
  'damage-dealt',
  'damage-resolved',
  'healing-received',
  'healing-dealt',
  'healing-resolved',
] as const

export const combatEventValueFields = [
  'amount',
  'rawAmount',
  'typeAmount',
  'defended',
  'blocked',
  'resisted',
  'amplified',
  'overheal',
] as const

export const combatEventFlagFields = ['immune', 'reactive'] as const
export const combatEffectDeliveries = ['direct', 'periodic', 'reaction'] as const
export const combatEventActorReferences = ['event.source', 'event.target'] as const

export function combatEventValueFieldsFor(
  event: string,
): readonly (typeof combatEventValueFields)[number][] {
  if (event.startsWith('damage-'))
    return combatEventValueFields.filter((field) => field !== 'overheal')

  if (event.startsWith('healing-')) return ['amount', 'rawAmount', 'overheal']

  return []
}

export const combatEffectActorSchema = z.union([
  z.enum(combatEventActorReferences),
  bindingAliasSchema.refine(
    (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
    'Reserved combat identifier',
  ),
])

/** An affine event amount: base + field × factor, rounded once. */
export const combatEventValueSchema = z.object({
  field: z.enum(combatEventValueFields),
  factor: z
    .number()
    .finite()
    .min(-10000)
    .max(10000)
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
      'Use at most two decimal places',
    ),
  rounding: z.enum(['floor', 'ceil', 'nearest']).optional(),
})

export type CombatEventValue = z.infer<typeof combatEventValueSchema>

/** Immutable facts about one resolved effect; amount is the actual HP change. */
export interface CombatEffectEventData {
  readonly source: string
  readonly target: string
  readonly delivery: (typeof combatEffectDeliveries)[number]
  readonly reactive: boolean
  readonly amount: number
  readonly rawAmount: number
  readonly damageType?: string | undefined
  readonly typeAmount?: number | undefined
  readonly defended?: number | undefined
  readonly blocked?: number | undefined
  readonly resisted?: number | undefined
  readonly amplified?: number | undefined
  readonly immune?: boolean | undefined
  readonly overheal?: number | undefined
}
