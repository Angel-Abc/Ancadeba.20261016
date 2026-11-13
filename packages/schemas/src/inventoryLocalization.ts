import { itemUseTextSchema } from './itemUse.js'
import { inventorySchema, type InventoryDefinition } from './inventory.js'
import { combatStatsTextSchema } from './combatStats.js'
import type { GameTranslation } from './localization.js'

/** Localize presentation only; item identities, placement, and compatibility remain unchanged. */
export function localizeInventory(
  definition: InventoryDefinition,
  translation?: GameTranslation,
): InventoryDefinition {
  const text = (key: string | undefined, literal: string, required = false) => {
    if (!key) return literal

    if (!translation) throw new Error('Item translation keys require language catalogs')

    if (!Object.hasOwn(translation.fallback, key))
      throw new Error(`Missing default translation: ${key}`)

    const value = Object.hasOwn(translation.messages, key)
      ? translation.messages[key]!
      : translation.fallback[key]!

    if (required && !value.trim()) throw new Error(`Translation must not be empty: ${key}`)

    return value
  }

  return inventorySchema.parse({
    ...definition,
    owners: Object.fromEntries(
      Object.entries(definition.owners).map(([id, owner]) => [
        id,
        {
          ...owner,
          label: text(owner.labelKey, owner.label, true),
          equipmentSlots: Object.fromEntries(
            Object.entries(owner.equipmentSlots).map(([slot, label]) => [
              slot,
              text(owner.equipmentSlotKeys?.[slot], label, true),
            ]),
          ),
          ...(owner.combatStats
            ? {
                combatStats: {
                  ...owner.combatStats,
                  messages: Object.fromEntries(
                    combatStatsTextSchema
                      .keyof()
                      .options.map((key) => [
                        key,
                        text(owner.combatStats!.messageKeys[key], owner.combatStats!.messages[key]),
                      ]),
                  ),
                },
              }
            : {}),
        },
      ]),
    ),
    itemTypes: Object.fromEntries(
      Object.entries(definition.itemTypes).map(([id, item]) => [
        id,
        {
          ...item,
          ...(item.use
            ? {
                use: {
                  ...item.use,
                  messages: Object.fromEntries(
                    itemUseTextSchema
                      .keyof()
                      .options.map((key) => [
                        key,
                        text(item.use!.messageKeys[key], item.use!.messages[key]),
                      ]),
                  ),
                },
              }
            : {}),
          label: text(item.labelKey, item.label, true),
          description: text(item.descriptionKey, item.description),
          properties: item.properties.map((property) => ({
            ...property,
            label: text(property.labelKey, property.label, true),
            value: property.valueKey
              ? text(property.valueKey, typeof property.value === 'string' ? property.value : '')
              : property.value,
          })),
        },
      ]),
    ),
  })
}
