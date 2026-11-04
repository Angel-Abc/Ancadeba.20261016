import {
  inventoryPlacementIssue,
  inventoryPlacementSchema,
  type InventoryDefinition,
  type InventoryItem,
  type InventoryPlacement,
} from '@ancadeba/schemas'
import type { Unsubscribe } from '@ancadeba/utilities'

export interface InventoryItemSnapshot extends InventoryItem {
  readonly id: string
}

export type InventoryMoveResult =
  | { readonly status: 'applied'; readonly changed: boolean }
  | { readonly status: 'rejected'; readonly reason: string }

export interface IGameInventory {
  readonly snapshot: readonly InventoryItemSnapshot[]
  checkMove(itemId: string, destination: InventoryPlacement): string | undefined
  move(itemId: string, destination: InventoryPlacement): InventoryMoveResult
  subscribeChanges(handler: () => void): Unsubscribe
}

function samePlacement(from: InventoryPlacement, to: InventoryPlacement): boolean {
  if (from.type === 'inside') return to.type === 'inside' && from.container === to.container

  if (from.type === 'carried') return to.type === 'carried' && from.owner === to.owner

  return to.type === 'equipped' && from.owner === to.owner && from.slot === to.slot
}

/** The lifecycle creates a fresh inventory from validated game data for every playthrough. */
export class GameInventory implements IGameInventory {
  private readonly items = new Map<string, InventoryItemSnapshot>()
  private readonly subscribers = new Set<() => void>()
  private disposed = false

  constructor(private readonly definition: InventoryDefinition) {
    for (const [id, item] of Object.entries(definition.items)) {
      this.items.set(
        id,
        Object.freeze({
          id,
          itemType: item.itemType,
          placement: Object.freeze({ ...item.placement }),
          colors: Object.freeze({ ...item.colors }),
        }),
      )
    }
  }

  get snapshot(): readonly InventoryItemSnapshot[] {
    return Object.freeze([...this.items.values()])
  }

  private validate(itemId: string, destination: InventoryPlacement) {
    if (this.disposed) return { reason: 'Inventory is no longer active' }
    const parsed = inventoryPlacementSchema.safeParse(destination)

    if (!parsed.success) return { reason: 'Invalid inventory destination' }
    const reason = inventoryPlacementIssue(this.definition, this.items, itemId, parsed.data)

    return reason === undefined ? { destination: parsed.data } : { reason }
  }

  checkMove(itemId: string, destination: InventoryPlacement): string | undefined {
    return this.validate(itemId, destination).reason
  }

  move(itemId: string, destination: InventoryPlacement): InventoryMoveResult {
    const result = this.validate(itemId, destination)

    if (!result.destination) return { status: 'rejected', reason: result.reason }
    const item = this.items.get(itemId)!

    if (samePlacement(item.placement, result.destination))
      return { status: 'applied', changed: false }

    this.items.set(itemId, Object.freeze({ ...item, placement: Object.freeze(result.destination) }))
    const errors: unknown[] = []

    for (const handler of [...this.subscribers]) {
      if (!this.subscribers.has(handler)) continue

      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length)
      throw new AggregateError(errors, 'Inventory change subscribers failed after move')

    return { status: 'applied', changed: true }
  }

  subscribeChanges(handler: () => void): Unsubscribe {
    if (this.disposed) throw new Error('Inventory is no longer active')
    const subscription = () => handler()
    this.subscribers.add(subscription)

    return () => {
      this.subscribers.delete(subscription)
    }
  }

  dispose(): void {
    this.disposed = true
    this.items.clear()
    this.subscribers.clear()
  }
}
