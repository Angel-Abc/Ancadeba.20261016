import {
  inventoryEntry,
  inventoryOwner,
  type ShopComponentDefinition,
  type ShopMessage,
} from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameBindings } from './gameBindings.js'
import type { IGameInventory, InventoryItemSnapshot } from './inventory.js'
import type { IGameInventorySelection, InventorySelectionSnapshot } from './inventoryContext.js'
import type { ITradeState, TradeStateWrite } from './tradeState.js'

export type TradeOperation = 'buy' | 'sell'

export interface TradeQuote {
  readonly item: string
  readonly operation: TradeOperation
  readonly amount: number | undefined
  readonly playerBalance: number | undefined
  readonly merchantBalance: number | 'unlimited' | undefined
  readonly reason: ShopMessage | undefined
}

export interface TradeSelection {
  readonly selection: InventorySelectionSnapshot
  readonly item: InventoryItemSnapshot
  readonly operation: TradeOperation
  readonly amount: number | undefined
}

export type TradeResult =
  | { readonly status: 'applied' }
  | { readonly status: 'rejected'; readonly reason: ShopMessage }

export interface IGameTrading {
  getSelection(scene: SceneInstance, shop: string): TradeSelection | undefined
  quote(scene: SceneInstance, shop: string): TradeQuote | undefined
  quoteItem(
    scene: SceneInstance,
    shop: string,
    item: string,
    operation: TradeOperation,
  ): TradeQuote | undefined
  balances(
    scene: SceneInstance,
    shop: string,
  ): { player: number | undefined; merchant: number | 'unlimited' | undefined }
  checkTrade(scene: SceneInstance, shop: string, operation: TradeOperation): ShopMessage | undefined
  trade(
    scene: SceneInstance,
    shop: string,
    operation: TradeOperation,
    expected?: TradeSelection,
  ): TradeResult
  feedback(scene: SceneInstance, shop: string): string
  subscribeChanges(listener: () => void): () => void
}

function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Coordinates prepared inventory and state commits. Views never write currency bindings. */
export class GameTrading implements IGameTrading {
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private readonly selections = new Map<string, TradeSelection>()
  private readonly results = new Map<
    string,
    { code: ShopMessage; itemType?: string; amount?: number }
  >()
  private scene: SceneInstance | undefined
  private publishing = false
  private disposed = false

  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly selection: IGameInventorySelection,
    private readonly inventory: IGameInventory | undefined,
    private readonly bindings: IGameBindings,
    private readonly state: ITradeState | undefined,
    private readonly invalidate: () => void,
  ) {
    const changed = () => {
      if (!this.publishing) this.notify()
    }

    this.cleanups.push(
      selection.subscribe(changed),
      bindings.subscribeChanges(changed),
      lifecycle.subscribeSceneChanges(({ current }) => {
        if (this.scene === current) return
        this.scene = undefined
        this.selections.clear()
        this.results.clear()
      }),
    )

    if (inventory) this.cleanups.push(inventory.subscribeChanges(changed))
  }

  private definition(scene: SceneInstance, id: string): ShopComponentDefinition | undefined {
    if (
      this.disposed ||
      scene.disposed ||
      scene.type !== 'game' ||
      scene !== this.lifecycle.activeScene
    )
      return

    if (this.scene !== scene) {
      this.scene = scene
      this.selections.clear()
      this.results.clear()
    }

    const component = scene.game.data.scenes
      .get(scene.data.id)
      ?.components.find((component) => component.id === id)

    return component?.type === 'shop' ? component : undefined
  }

  private owners(scene: SceneInstance, shop: ShopComponentDefinition) {
    const player = scene.data.components.find((component) => component.id === shop.playerInventory)

    const merchant = scene.data.components.find(
      (component) => component.id === shop.merchantInventory,
    )

    return {
      player: player?.type === 'inventory' ? player.owners[0] : undefined,
      merchant: merchant?.type === 'inventory' ? merchant.owners[0] : undefined,
    }
  }

  private writes(
    shop: ShopComponentDefinition,
    operation: TradeOperation,
    player: number,
    merchant: number | 'unlimited',
    amount: number,
  ): TradeStateWrite[] {
    return [
      {
        path: shop.playerBalance.path,
        expected: player,
        value: player + (operation === 'buy' ? -amount : amount),
      },
      ...(shop.merchantFunds.type === 'finite' && typeof merchant === 'number'
        ? [
            {
              path: shop.merchantFunds.balance.path,
              expected: merchant,
              value: merchant + (operation === 'buy' ? amount : -amount),
            },
          ]
        : []),
    ]
  }

  balances(scene: SceneInstance, id: string) {
    const shop = this.definition(scene, id)

    const read = (binding: ShopComponentDefinition['playerBalance']) => {
      const result = this.bindings.read(binding)

      return result.status === 'resolved' ? money(result.value) : undefined
    }

    return {
      player: shop ? read(shop.playerBalance) : undefined,
      merchant:
        shop?.merchantFunds.type === 'unlimited'
          ? ('unlimited' as const)
          : shop
            ? read(shop.merchantFunds.balance)
            : undefined,
    }
  }

  quoteItem(
    scene: SceneInstance,
    id: string,
    itemId: string,
    operation: TradeOperation,
  ): TradeQuote | undefined {
    const shop = this.definition(scene, id)

    if (!shop) return
    const balances = this.balances(scene, id)
    const items = new Map(this.inventory?.snapshot.map((item) => [item.id, item]))
    const item = items.get(itemId)
    const price = item && inventoryEntry(shop.prices, item.itemType)?.[operation]
    const value = typeof price === 'object' ? this.bindings.read(price) : undefined

    const amount = money(
      typeof price === 'object' ? (value?.status === 'resolved' ? value.value : undefined) : price,
    )

    const owners = this.owners(scene, shop)
    const owner = operation === 'buy' ? owners.merchant : owners.player
    let reason: ShopMessage | undefined

    if (!item || inventoryOwner(items, itemId) !== owner) reason = 'wrongOwner'
    else if (price === undefined) reason = 'unavailable'
    else if (
      amount === undefined ||
      balances.player === undefined ||
      balances.merchant === undefined
    )
      reason = 'invalidAmount'
    else if (item.placement.type === 'equipped') reason = 'equipped'
    else if (this.inventory?.isReserved?.(itemId)) reason = 'reserved'
    else if (
      [...items.values()].some(
        (item) => item.placement.type === 'inside' && item.placement.container === itemId,
      )
    )
      reason = 'containerNotEmpty'
    else if (!this.state || !this.inventory?.prepareTransfer) reason = 'unsupportedState'
    else if (operation === 'buy' && balances.player < amount) reason = 'insufficientPlayerFunds'
    else if (
      operation === 'sell' &&
      typeof balances.merchant === 'number' &&
      balances.merchant < amount
    )
      reason = 'insufficientMerchantFunds'
    else if (
      money(balances.player + (operation === 'buy' ? -amount : amount)) === undefined ||
      (typeof balances.merchant === 'number' &&
        money(balances.merchant + (operation === 'buy' ? amount : -amount)) === undefined)
    )
      reason = 'invalidAmount'

    if (
      !reason &&
      balances.player !== undefined &&
      balances.merchant !== undefined &&
      amount !== undefined &&
      !this.state?.prepare(this.writes(shop, operation, balances.player, balances.merchant, amount))
    )
      reason = 'unsupportedState'

    return {
      item: itemId,
      operation,
      amount,
      playerBalance: balances.player,
      merchantBalance: balances.merchant,
      reason,
    }
  }

  getSelection(scene: SceneInstance, id: string): TradeSelection | undefined {
    const shop = this.definition(scene, id)

    if (!shop) return
    const buy = this.selection.get(scene, shop.merchantInventory)
    const sell = this.selection.get(scene, shop.playerInventory)
    const selected = buy ?? sell
    const operation = buy ? 'buy' : 'sell'
    const item = this.inventory?.snapshot.find((item) => item.id === selected?.item)

    if (!selected || !item) {
      this.selections.delete(id)

      return
    }

    const amount = this.quoteItem(scene, id, item.id, operation)?.amount
    let token = this.selections.get(id)

    if (
      !token ||
      token.selection !== selected ||
      token.item !== item ||
      token.amount !== amount ||
      token.operation !== operation
    ) {
      token = Object.freeze({ selection: selected, item, amount, operation })
      this.selections.set(id, token)
    }

    return token
  }

  quote(scene: SceneInstance, id: string): TradeQuote | undefined {
    const selected = this.getSelection(scene, id)

    return selected && this.quoteItem(scene, id, selected.item.id, selected.operation)
  }

  checkTrade(scene: SceneInstance, id: string, operation: TradeOperation): ShopMessage | undefined {
    const quote = this.quote(scene, id)

    return !quote ? 'selectItem' : quote.operation !== operation ? 'unavailable' : quote.reason
  }

  trade(
    scene: SceneInstance,
    id: string,
    operation: TradeOperation,
    expected = this.getSelection(scene, id),
  ): TradeResult {
    const shop = this.definition(scene, id)
    const selected = this.getSelection(scene, id)

    const rejected = (reason: ShopMessage): TradeResult => {
      if (shop) {
        this.results.set(id, { code: reason })
        this.notify()
      }

      return { status: 'rejected', reason }
    }

    if (!shop || !selected || expected !== selected) return rejected('stale')
    const reason = this.checkTrade(scene, id, operation)

    if (reason) return rejected(reason)
    const quote = this.quote(scene, id)!
    const amount = quote.amount!
    const owner = this.owners(scene, shop)[operation === 'buy' ? 'player' : 'merchant']

    if (!owner) return rejected('wrongOwner')
    const transfer = this.inventory?.prepareTransfer?.(selected.item.id, { type: 'carried', owner })

    const state = this.state?.prepare(
      this.writes(shop, operation, quote.playerBalance!, quote.merchantBalance!, amount),
    )

    if (!state || !transfer) return rejected('unsupportedState')

    if (!state.isCurrent() || !transfer.isCurrent()) return rejected('stale')
    state.commit()
    transfer.commit()
    this.results.set(id, {
      code: operation === 'buy' ? 'bought' : 'sold',
      itemType: selected.item.itemType,
      amount,
    })
    const errors: unknown[] = []
    this.publishing = true

    try {
      for (const notify of [
        () => transfer.notify(),
        () =>
          this.selection.select(
            scene,
            operation === 'buy' ? shop.merchantInventory : shop.playerInventory,
          ),
        this.invalidate,
      ]) {
        try {
          notify()
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      this.publishing = false
    }

    try {
      this.notify()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length) throw new AggregateError(errors, 'Trade committed but observers failed')

    return { status: 'applied' }
  }

  feedback(scene: SceneInstance, id: string): string {
    const shop = this.definition(scene, id)
    const result = this.results.get(id)

    if (!shop || !result || scene.type !== 'game') return ''

    const type =
      result.itemType &&
      scene.game.data.inventory &&
      inventoryEntry(scene.game.data.inventory.itemTypes, result.itemType)

    return shop.messages[result.code].replace(/\{(item|price|currency)\}/g, (_, key: string) =>
      key === 'item'
        ? type
          ? type.label
          : ''
        : key === 'price'
          ? String(result.amount ?? '')
          : shop.currency,
    )
  }

  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  private notify(): void {
    if (
      this.disposed ||
      !this.lifecycle.activeScene?.data.components.some((component) => component.type === 'shop')
    )
      return
    const errors: unknown[] = []

    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue

      try {
        listener()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) throw new AggregateError(errors, 'Trading subscribers failed')
  }
  dispose(): void {
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.listeners.clear()
    this.selections.clear()
    this.results.clear()
    this.scene = undefined
  }
}
