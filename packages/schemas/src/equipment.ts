import type { InventoryDefinition } from './inventory.js'
import { inventoryEntry } from './inventory.js'
import type { EquipmentComponentDefinition } from './scene.js'

export function equipmentIssues(
  component: EquipmentComponentDefinition,
  inventory?: InventoryDefinition,
): { path: (string | number)[]; message: string }[] {
  const owner = inventory && inventoryEntry(inventory.owners, component.owner)

  if (!owner) return [{ path: ['owner'], message: `Unknown equipment owner: ${component.owner}` }]

  return component.order.flatMap((slot, index) =>
    Object.hasOwn(owner.equipmentSlots, slot)
      ? []
      : [{ path: ['order', index], message: `Unknown equipment slot: ${slot}` }],
  )
}
