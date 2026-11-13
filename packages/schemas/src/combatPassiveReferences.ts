import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

export const combatPassiveReferenceSchema = z.object({ library: id, id })

export const combatPassiveReferencesSchema = z
  .array(combatPassiveReferenceSchema)
  .max(20)
  .refine(
    (values) =>
      new Set(values.map((value) => `${value.library}/${value.id}`)).size === values.length,
    'Passive references must be unique',
  )

export type CombatPassiveReference = z.infer<typeof combatPassiveReferenceSchema>

export const combatPassiveSourceSchema = z.object({
  kind: z.enum(['equipment', 'status']),
  actor: id,
  id,
  library: id,
  passive: id,
})

export type CombatPassiveSource = z.infer<typeof combatPassiveSourceSchema>

export const combatPassiveReceiptSchema = combatPassiveSourceSchema.extend({ trigger: id })

export type CombatPassiveReceipt = z.infer<typeof combatPassiveReceiptSchema>
