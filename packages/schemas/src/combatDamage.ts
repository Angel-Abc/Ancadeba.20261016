import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'

/** Damage types are encounter-independent IDs; omitted types mean physical. */
export const combatDamageTypeSchema = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved damage type identifier',
)

const percentage = (maximum: number) =>
  z
    .number()
    .finite()
    .min(0)
    .max(maximum)
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
      'Damage defense percentages support at most two decimal places',
    )

const percentages = (maximum: number) =>
  z
    .record(combatDamageTypeSchema, percentage(maximum))
    .refine((values) => Object.keys(values).length <= 100, 'At most 100 damage types are supported')

export const combatDamageDefensesSchema = z.object({
  resistances: percentages(100).optional(),
  vulnerabilities: percentages(1000).optional(),
  immunities: z
    .array(combatDamageTypeSchema)
    .max(100)
    .refine((types) => new Set(types).size === types.length, 'Damage immunities must be unique')
    .optional(),
})

export type CombatDamageDefenses = z.infer<typeof combatDamageDefensesSchema>
