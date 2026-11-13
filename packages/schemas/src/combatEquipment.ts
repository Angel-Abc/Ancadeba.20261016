import { combatPassiveReferencesSchema } from './combatPassiveReferences.js'
import { z } from 'zod'
import type { InventoryDefinition } from './inventory.js'
import { bindingAliasSchema } from './bindings.js'
import { combatDamageDefensesSchema } from './combatDamage.js'
import { combatRestrictionFields } from './combatRestrictions.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

export const combatResourceGainModifierSchema = z.object({
  flat: z.number().int().safe().optional(),
  percent: z
    .number()
    .finite()
    .min(-100)
    .max(1000)
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
      'Use at most two decimal places',
    )
    .optional(),
})

export const equipmentCombatEffectsSchema = z.object({
  passives: combatPassiveReferencesSchema.optional(),
  damageDefenses: combatDamageDefensesSchema.optional(),
  ...combatRestrictionFields,
  resourceGains: z
    .record(id, combatResourceGainModifierSchema)
    .refine(
      (values) => Object.keys(values).length <= 100,
      'At most 100 resource modifiers are supported',
    )
    .optional(),
  grantedMoves: z
    .array(z.object({ library: id, id }))
    .max(100)
    .refine(
      (values) =>
        new Set(values.map((value) => `${value.library}/${value.id}`)).size === values.length,
      'Equipment move references must be unique',
    )
    .optional(),
})

export type EquipmentCombatEffects = z.infer<typeof equipmentCombatEffectsSchema>

/** Serializable loadout input, supplied by the inventory adapter or a simulation setup. */
export const combatEquippedEffectsSchema = z.object({
  item: id,
  itemType: id,
  slot: id,
  label: z.string(),
  effects: equipmentCombatEffectsSchema,
})

export const combatEquipmentSchema = z.record(id, z.array(combatEquippedEffectsSchema).max(100))

export type CombatEquippedEffects = z.infer<typeof combatEquippedEffectsSchema>

export type CombatEquipment = Readonly<Record<string, readonly CombatEquippedEffects[]>>

export const combatSimulationLoadoutSchema = z.record(
  id,
  z
    .record(id, id.nullable())
    .refine(
      (slots) => Object.keys(slots).length <= 100,
      'At most 100 equipment slots are supported',
    ),
)

export type CombatSimulationLoadout = z.infer<typeof combatSimulationLoadoutSchema>

/** Potential grants depend on compatible owner slots, not starting item placements. */
export function combatEquipmentMoveReferences(
  inventory: InventoryDefinition | undefined,
  owner: string | undefined,
): { library: string; id: string }[] {
  const slots = Object.keys(inventory?.owners[owner ?? '']?.equipmentSlots ?? {})

  const references = Object.values(inventory?.itemTypes ?? {})
    .filter((type) => type.equipmentSlots.some((slot) => slots.includes(slot)))
    .flatMap((type) => type.combatEffects?.grantedMoves ?? [])

  return [
    ...new Map(
      references.map((reference) => [`${reference.library}/${reference.id}`, reference]),
    ).values(),
  ]
}

export function combatEquipmentPassiveReferences(
  inventory: InventoryDefinition | undefined,
  owner: string | undefined,
) {
  const slots = Object.keys(inventory?.owners[owner ?? '']?.equipmentSlots ?? {})

  return Object.values(inventory?.itemTypes ?? {})
    .filter((type) => type.equipmentSlots.some((slot) => slots.includes(slot)))
    .flatMap((type) => type.combatEffects?.passives ?? [])
}
