import {
  inventoryPlacementIssue,
  inventoryPlacementSchema,
  inventoryOwner,
  inventorySchema,
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
  /** Stage new finite item instances without publishing or invoking observers. */
  prepareCreate?(items: readonly InventoryItemSnapshot[]): PreparedInventoryTransfer | undefined
  /** Validate and stage the entire transfer batch against one candidate inventory. */
  prepareTransfers?(
    transfers: readonly { readonly item: string; readonly destination: InventoryPlacement }[],
  ): PreparedInventoryTransfer | undefined
  /** Stage a transfer for an atomic transaction. Commit invokes no observers. */
  prepareTransfer?(
    itemId: string,
    destination: InventoryPlacement,
  ): PreparedInventoryTransfer | undefined
  readonly snapshot: readonly InventoryItemSnapshot[]
  checkMove(itemId: string, destination: InventoryPlacement): string | undefined
  move(itemId: string, destination: InventoryPlacement): InventoryMoveResult
  checkEquip(itemId: string, owner: string, slot: string): string | undefined
  equip(itemId: string, owner: string, slot: string): InventoryMoveResult
  subscribeChanges(handler: () => void): Unsubscribe
}

export interface PreparedInventoryTransfer {
  isCurrent(): boolean
  commit(): void
  notify(): void
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
  private revision = 0

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
    this.revision++
    this.notify()

    return { status: 'applied', changed: true }
  }

  private prepareEquip(itemId: string, owner: string, slot: string) {
    if (this.disposed) return { reason: 'Inventory is no longer active' }
    const parsed = inventoryPlacementSchema.safeParse({ type: 'equipped', owner, slot })

    if (!parsed.success) return { reason: 'Invalid equipment destination' }
    const item = this.items.get(itemId)

    if (!item) return { reason: `Unknown item: ${itemId}` }

    if (inventoryOwner(this.items, itemId) !== owner)
      return { reason: 'Item must belong to the equipment owner' }
    const staged = new Map(this.items)
    const destination = parsed.data

    const displaced = [...staged.entries()].find(
      ([id, item]) =>
        id !== itemId &&
        item.placement.type === 'equipped' &&
        item.placement.owner === owner &&
        item.placement.slot === slot,
    )

    if (displaced)
      staged.set(
        displaced[0],
        Object.freeze({
          ...displaced[1],
          placement: Object.freeze({ type: 'carried' as const, owner }),
        }),
      )
    staged.set(itemId, Object.freeze({ ...item, placement: Object.freeze(destination) }))

    for (const id of [itemId, ...(displaced ? [displaced[0]] : [])]) {
      const reason = inventoryPlacementIssue(this.definition, staged, id, staged.get(id)!.placement)

      if (reason) return { reason }
    }

    return { staged, changed: !samePlacement(item.placement, destination) }
  }

  checkEquip(itemId: string, owner: string, slot: string): string | undefined {
    return this.prepareEquip(itemId, owner, slot).reason
  }

  equip(itemId: string, owner: string, slot: string): InventoryMoveResult {
    const result = this.prepareEquip(itemId, owner, slot)

    if (!result.staged) return { status: 'rejected', reason: result.reason }

    if (!result.changed) return { status: 'applied', changed: false }

    for (const [id, item] of result.staged) this.items.set(id, item)
    this.revision++
    this.notify()

    return { status: 'applied', changed: true }
  }

  private notify(): void {
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
  }

  prepareTransfer(
    itemId: string,
    destination: InventoryPlacement,
  ): PreparedInventoryTransfer | undefined {
    const result = this.validate(itemId, destination)

    if (!result.destination) return
    const item = this.items.get(itemId)!
    const next = Object.freeze({ ...item, placement: Object.freeze(result.destination) })
    const revision = this.revision
    let committed = false
    let notified = false

    return {
      isCurrent: () => !this.disposed && !committed && this.revision === revision,
      commit: () => {
        if (this.disposed || committed || this.revision !== revision) return
        this.items.set(itemId, next)
        this.revision++
        committed = true
      },
      notify: () => {
        if (!committed || notified) return
        notified = true
        this.notify()
      },
    }
  }

  prepareCreate(items: readonly InventoryItemSnapshot[]): PreparedInventoryTransfer | undefined {
    if (
      this.disposed ||
      new Set(items.map((item) => item.id)).size !== items.length ||
      items.some((item) => this.items.has(item.id))
    )
      return

    const parsed = inventorySchema.shape.items.safeParse(
      Object.fromEntries(items.map((item) => [item.id, item])),
    )

    if (!parsed.success) return
    const staged = new Map(this.items)

    for (const [id, item] of Object.entries(parsed.data))
      staged.set(
        id,
        Object.freeze({
          id,
          ...item,
          placement: Object.freeze({ ...item.placement }),
          colors: Object.freeze({ ...item.colors }),
        }),
      )

    for (const source of items) {
      const item = staged.get(source.id)

      if (!item || inventoryPlacementIssue(this.definition, staged, source.id, item.placement))
        return
    }

    return this.prepareBatch(staged)
  }

  prepareTransfers(
    transfers: readonly { readonly item: string; readonly destination: InventoryPlacement }[],
  ): PreparedInventoryTransfer | undefined {
    if (
      this.disposed ||
      new Set(transfers.map((transfer) => transfer.item)).size !== transfers.length
    )
      return
    const staged = new Map(this.items)

    for (const transfer of transfers) {
      const item = staged.get(transfer.item)
      const placement = inventoryPlacementSchema.safeParse(transfer.destination)

      if (!item || !placement.success) return
      staged.set(item.id, Object.freeze({ ...item, placement: Object.freeze(placement.data) }))
    }

    for (const [id, item] of staged)
      if (inventoryPlacementIssue(this.definition, staged, id, item.placement)) return

    return this.prepareBatch(staged)
  }

  private prepareBatch(
    staged: ReadonlyMap<string, InventoryItemSnapshot>,
  ): PreparedInventoryTransfer {
    const revision = this.revision
    let committed = false
    let notified = false

    return {
      isCurrent: () => !this.disposed && !committed && this.revision === revision,
      commit: () => {
        if (this.disposed || committed || this.revision !== revision) return

        for (const [id, item] of staged) this.items.set(id, item)
        this.revision++
        committed = true
      },
      notify: () => {
        if (!committed || notified) return
        notified = true
        this.notify()
      },
    }
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
