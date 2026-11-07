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

export interface InventoryReservation {
  readonly encounter: string
}

export interface IGameInventory {
  reserveItem?(item: string, token: InventoryReservation): string | undefined
  releaseItems?(token: InventoryReservation, item?: string): void
  isReserved?(item: string): boolean
  /** Publish a completed batch of reservation changes, after the combat plan is updated. */
  notifyReservations?(): void
  prepareRemove?(
    items: readonly string[],
    token?: InventoryReservation,
  ): PreparedInventoryTransfer | undefined
  /** Internal transaction participant, installed by the playthrough's equipment stat service. */
  setEquipmentPolicy?(policy: InventoryEquipmentPolicy): () => void
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

export interface InventoryEquipmentPolicy {
  prepare(
    before: ReadonlyMap<string, InventoryItemSnapshot>,
    after: ReadonlyMap<string, InventoryItemSnapshot>,
  ): InventoryEquipmentPreparation
}

export interface InventoryEquipmentPreparation {
  reason?: string
  effects?: PreparedInventoryTransfer
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
  private readonly reservations = new Map<string, InventoryReservation>()
  private equipmentPolicy: InventoryEquipmentPolicy | undefined

  setEquipmentPolicy(policy: InventoryEquipmentPolicy): () => void {
    if (this.equipmentPolicy) throw new Error('An equipment policy is already installed')
    this.equipmentPolicy = policy

    return () => {
      if (this.equipmentPolicy === policy) this.equipmentPolicy = undefined
    }
  }

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
    const validation = this.validate(itemId, destination)

    if (!validation.destination) return validation.reason
    const staged = new Map(this.items)
    staged.set(itemId, { ...staged.get(itemId)!, placement: validation.destination })

    return this.reservationIssue(staged) ?? this.equipmentPolicy?.prepare(this.items, staged).reason
  }

  move(itemId: string, destination: InventoryPlacement): InventoryMoveResult {
    const result = this.validate(itemId, destination)

    if (!result.destination) return { status: 'rejected', reason: result.reason }
    const item = this.items.get(itemId)!

    if (samePlacement(item.placement, result.destination))
      return { status: 'applied', changed: false }

    const reason = this.checkMove(itemId, result.destination)

    if (reason) return { status: 'rejected', reason }
    const staged = this.prepareTransfer(itemId, result.destination)

    if (!staged?.isCurrent())
      return { status: 'rejected', reason: 'Equipment transaction is unavailable' }
    staged.commit()
    staged.notify()

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
    const result = this.prepareEquip(itemId, owner, slot)

    return result.staged
      ? (this.reservationIssue(result.staged) ??
          this.equipmentPolicy?.prepare(this.items, result.staged).reason)
      : result.reason
  }

  equip(itemId: string, owner: string, slot: string): InventoryMoveResult {
    const result = this.prepareEquip(itemId, owner, slot)

    if (!result.staged) return { status: 'rejected', reason: result.reason }

    if (!result.changed) return { status: 'applied', changed: false }

    const reason = this.equipmentPolicy?.prepare(this.items, result.staged).reason

    if (reason) return { status: 'rejected', reason }
    const staged = this.prepareBatch(result.staged)

    if (!staged?.isCurrent())
      return { status: 'rejected', reason: 'Equipment transaction is unavailable' }
    staged.commit()
    staged.notify()

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
    const staged = new Map(this.items)
    staged.set(itemId, next)

    return this.prepareBatch(staged)
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

  reserveItem(item: string, token: InventoryReservation): string | undefined {
    if (this.disposed || !this.items.has(item)) return 'Item is unavailable'

    if (this.reservations.has(item)) return 'Item is reserved by a combat plan'
    this.reservations.set(item, token)
  }

  releaseItems(token: InventoryReservation, item?: string): void {
    for (const [id, owner] of this.reservations)
      if (owner === token && (item === undefined || item === id)) this.reservations.delete(id)
  }

  isReserved(item: string): boolean {
    return this.reservations.has(item)
  }
  notifyReservations(): void {
    this.notify()
  }

  private reservationIssue(
    staged: ReadonlyMap<string, InventoryItemSnapshot>,
    token?: InventoryReservation,
  ): string | undefined {
    for (const [id, owner] of this.reservations) {
      if (owner === token) continue
      let item = this.items.get(id)
      const seen = new Set<string>()

      while (item && !seen.has(item.id)) {
        seen.add(item.id)
        const next = staged.get(item.id)

        if (!next || !samePlacement(item.placement, next.placement))
          return 'Item is reserved by a combat plan'
        item =
          item.placement.type === 'inside' ? this.items.get(item.placement.container) : undefined
      }
    }
  }

  prepareRemove(
    ids: readonly string[],
    token?: InventoryReservation,
  ): PreparedInventoryTransfer | undefined {
    if (this.disposed || new Set(ids).size !== ids.length) return
    const staged = new Map(this.items)

    for (const id of ids) {
      const item = this.items.get(id)

      if (
        !item ||
        item.placement.type === 'equipped' ||
        [...this.items.values()].some(
          (entry) => entry.placement.type === 'inside' && entry.placement.container === id,
        )
      )
        return
      staged.delete(id)
    }

    return this.prepareBatch(staged, token)
  }

  private prepareBatch(
    staged: ReadonlyMap<string, InventoryItemSnapshot>,
    token?: InventoryReservation,
  ): PreparedInventoryTransfer | undefined {
    if (this.reservationIssue(staged, token)) return
    const policy = this.equipmentPolicy?.prepare(this.items, staged)

    if (policy?.reason) return
    const effects = policy?.effects
    const revision = this.revision
    let committed = false
    let notified = false

    return {
      isCurrent: () =>
        !this.disposed &&
        !committed &&
        this.revision === revision &&
        !this.reservationIssue(staged, token) &&
        (effects?.isCurrent() ?? true),
      commit: () => {
        if (
          this.disposed ||
          committed ||
          this.revision !== revision ||
          this.reservationIssue(staged, token) ||
          (effects && !effects.isCurrent())
        )
          return

        effects?.commit()

        this.items.clear()

        for (const [id, item] of staged) this.items.set(id, item)
        this.revision++
        committed = true
      },
      notify: () => {
        if (!committed || notified) return
        notified = true
        const errors: unknown[] = []

        for (const notify of [() => this.notify(), () => effects?.notify()]) {
          try {
            notify()
          } catch (error) {
            errors.push(error)
          }
        }

        if (errors.length)
          throw new AggregateError(errors, 'Inventory transaction committed but observers failed')
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
    this.reservations.clear()
  }
}
