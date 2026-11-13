import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'

export const combatPendingEvents = ['damage-pending', 'healing-pending'] as const

export const combatInterceptionEffectTypes = [
  'adjust-effect',
  'absorb-damage',
  'redirect-damage',
  'prevent-lethal',
] as const

export const combatEffectEvents = [
  ...combatPendingEvents,
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
  'incomingAmount',
  'absorbed',
  'prevented',
  'redirectedAmount',
] as const

export const combatEventFlagFields = ['immune', 'reactive', 'redirected', 'lethal'] as const
export const combatEffectDeliveries = ['direct', 'periodic', 'reaction'] as const
export const combatEventActorReferences = ['event.source', 'event.target'] as const

export function combatEventValueFieldsFor(
  event: string,
): readonly (typeof combatEventValueFields)[number][] {
  if (event.startsWith('damage-'))
    return combatEventValueFields.filter((field) => field !== 'overheal')

  if (event.startsWith('healing-')) return ['amount', 'rawAmount', 'overheal', 'incomingAmount']

  return []
}

export function combatEventFlagFieldsFor(
  event: string,
): readonly (typeof combatEventFlagFields)[number][] {
  return event.startsWith('damage-')
    ? [
        'immune',
        'reactive',
        'redirected',
        ...(event === 'damage-pending' ? ['lethal' as const] : []),
      ]
    : event.startsWith('healing-')
      ? ['reactive']
      : []
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

/** Immutable effect facts; amount is pending before HP commit, or actual HP change after resolution. */
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
  readonly incomingAmount?: number | undefined
  readonly absorbed?: number | undefined
  readonly prevented?: number | undefined
  readonly redirectedAmount?: number | undefined
  readonly redirected?: boolean | undefined
  readonly lethal?: boolean | undefined
  readonly originalTarget?: string | undefined
  readonly overheal?: number | undefined
}
