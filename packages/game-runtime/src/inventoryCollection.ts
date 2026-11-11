import { inventoryOwner } from '@ancadeba/schemas'
import type { IGameInventory, PreparedInventoryTransfer } from './inventory.js'

/** Stage a finite pickup batch; already-owned or unavailable items reject the whole pickup. */
export function prepareInventoryCollection(
  inventory: IGameInventory | undefined,
  items: readonly string[],
  owner: string,
): PreparedInventoryTransfer | undefined {
  if (!inventory || !items.length || new Set(items).size !== items.length) return
  const snapshot = new Map(inventory.snapshot.map((item) => [item.id, item]))

  if (items.some((id) => !snapshot.has(id) || inventoryOwner(snapshot, id) === owner)) return

  return inventory.prepareTransfers?.(
    items.map((item) => ({
      item,
      destination: { type: 'carried', owner },
    })),
  )
}
