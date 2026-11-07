import { inventoryEntry, inventoryOwner } from '@ancadeba/schemas'
import type { SceneInstance } from './gameLifecycle.js'
import { resolveStatusValue } from './statusValues.js'

/** Resolves display-only information without interpreting game-defined item properties. */
export function selectedItemDetails(scene: SceneInstance, panel: string) {
  if (scene.type !== 'game') return
  const id = scene.game.inventorySelection?.get(scene, panel)?.item
  const items = new Map(scene.game.inventory?.snapshot.map((item) => [item.id, item]))
  const item = id && items.get(id)
  const definition = scene.game.data.inventory
  const type = item && definition && inventoryEntry(definition.itemTypes, item.itemType)

  if (!item || !type || !definition) return
  const ownerId = inventoryOwner(items, item.id)
  const owner = ownerId ? inventoryEntry(definition.owners, ownerId) : undefined
  const placement = item.placement
  const container = placement.type === 'inside' ? items.get(placement.container) : undefined

  const containerType = container
    ? inventoryEntry(definition.itemTypes, container.itemType)
    : undefined

  const location =
    placement.type === 'equipped'
      ? `${owner?.label ?? placement.owner} / ${owner?.equipmentSlots[placement.slot] ?? placement.slot}`
      : placement.type === 'inside'
        ? `Inside ${containerType?.label ?? placement.container} (${owner?.label ?? ownerId ?? ''})`
        : `Carried by ${owner?.label ?? placement.owner}`

  const properties = type.properties.map((property) => ({
    ...property,
    ...resolveStatusValue(property.value, scene.game.bindings),
  }))

  const action = scene.data.components
    .flatMap((entry) => (entry.type === 'action-bar' ? Object.values(entry.slots) : []))
    .find((slot) => slot.action.type === 'item-use' && slot.action.inventory === panel)?.action

  const useDetails =
    scene.game.itemUse?.details(
      scene,
      panel,
      action?.type === 'item-use' ? action.combat : undefined,
    ) ?? ''

  return { item, type, location, properties, useDetails }
}

export function itemDetailsText(details: ReturnType<typeof selectedItemDetails>): string {
  if (!details) return ''

  return [
    details.type.label,
    details.type.description,
    ...details.properties.map((property) => `${property.label}: ${property.value ?? '—'}`),
    details.location,
    details.useDetails,
  ]
    .filter(Boolean)
    .join('\n\n')
}
