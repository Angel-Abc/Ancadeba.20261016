import { rewardItemId, type CombatDefinition, type RewardOperation } from '@ancadeba/schemas'
import type { GameInstance, IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameBindings } from './gameBindings.js'
import type { IStateTransactions, StateWrite } from './stateTransactions.js'
import type { IGameInventory, InventoryItemSnapshot } from './inventory.js'
import type { IGameInventorySelection } from './inventoryContext.js'
import type { CombatCapture } from './combat.js'

type RewardIssue = 'rewardUnavailable' | 'rewardInvalidAmount' | 'rewardInventory'

interface RewardBundle {
  readonly numeric: readonly {
    readonly id: string
    readonly path: readonly string[]
    readonly amount: number
  }[]
  readonly items: readonly InventoryItemSnapshot[]
  delivered: boolean
  issue: RewardIssue | undefined
  token: object
  taken: readonly string[]
}

export interface CombatRewardSnapshot {
  readonly delivered: boolean
  readonly numeric: readonly { readonly id: string; readonly amount: number }[]
  readonly items: readonly string[]
  readonly remaining: readonly string[]
  readonly issue: RewardIssue | undefined
}

export interface IGameCombatRewards {
  snapshot(scene: SceneInstance, component: string): CombatRewardSnapshot | undefined
  text(scene: SceneInstance, component: string): string
  subscribeChanges(listener: () => void): () => void
}

/** Owns exactly-once reward delivery and ordinary inventory loot for one playthrough. */
export class GameCombatRewards implements IGameCombatRewards {
  private readonly bundles = new Map<string, RewardBundle>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private readonly captures = new Map<
    string,
    {
      scene: SceneInstance
      bundle: object
      inventory: object
      selection: object | undefined
      capture: CombatCapture
    }
  >()
  private inventoryToken = {}
  private disposed = false
  private publishing = false
  constructor(
    private readonly game: GameInstance,
    private readonly lifecycle: IGameLifecycle,
    private readonly bindings: IGameBindings,
    private readonly state: IStateTransactions | undefined,
    private readonly inventory: IGameInventory | undefined,
    private readonly selection: IGameInventorySelection | undefined,
    private readonly invalidate: () => void,
  ) {
    if (inventory)
      this.cleanups.push(
        inventory.subscribeChanges(() => {
          this.inventoryToken = {}

          if (!this.publishing) this.notify()
        }),
      )

    if (selection)
      this.cleanups.push(
        selection.subscribe(() => {
          if (!this.publishing) this.notify()
        }),
      )
  }
  private view(scene: SceneInstance, id: string) {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game' ||
      scene.game !== this.game
    )
      return

    const component = this.game.data.scenes
      .get(scene.data.id)
      ?.components.find((entry) => entry.id === id)

    if (component?.type !== 'combat') return
    const definition = this.game.data.combat?.get(component.encounter)

    return definition?.rewards ? { component, definition, rewards: definition.rewards } : undefined
  }
  private remaining(definition: CombatDefinition, bundle: RewardBundle): InventoryItemSnapshot[] {
    const ids = new Set(bundle.items.map((item) => item.id))

    return bundle.delivered
      ? (this.inventory?.snapshot.filter(
          (item) =>
            ids.has(item.id) &&
            item.placement.type === 'carried' &&
            item.placement.owner === definition.rewards?.lootOwner,
        ) ?? [])
      : []
  }
  snapshot(scene: SceneInstance, id: string): CombatRewardSnapshot | undefined {
    const view = this.view(scene, id)
    const bundle = view && this.bundles.get(view.definition.id)

    if (!view || !bundle) return

    return Object.freeze({
      delivered: bundle.delivered,
      numeric: Object.freeze(
        bundle.numeric.map((entry) => Object.freeze({ id: entry.id, amount: entry.amount })),
      ),
      items: Object.freeze(bundle.items.map((item) => item.id)),
      remaining: Object.freeze(this.remaining(view.definition, bundle).map((item) => item.id)),
      issue: bundle.issue,
    })
  }
  /** Called only after a winning round commits, before any of its observers run. */
  complete(definition: CombatDefinition): (() => void) | undefined {
    if (!definition.rewards || this.bundles.has(definition.id) || this.disposed) return
    let seed = (definition.seed ^ 0x9e3779b9) >>> 0 || 1
    const items: InventoryItemSnapshot[] = []

    for (const drop of definition.rewards.drops) {
      if (drop.chance === 0) continue

      if (drop.chance < 10000) {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        seed >>>= 0

        if (seed / 0x100000000 >= drop.chance / 10000) continue
      }

      items.push(
        Object.freeze({
          id: rewardItemId(definition.id, drop.id),
          itemType: drop.itemType,
          colors: Object.freeze({ ...drop.colors }),
          placement: Object.freeze({ type: 'carried', owner: definition.rewards.lootOwner! }),
        }),
      )
    }

    const bundle: RewardBundle = {
      numeric: Object.freeze(
        definition.rewards.numeric.map((entry) =>
          Object.freeze({
            id: entry.id,
            path: Object.freeze([...entry.field.path]),
            amount: entry.amount,
          }),
        ),
      ),
      items: Object.freeze(items),
      delivered: false,
      token: {},
      issue: undefined,
      taken: [],
    }

    this.bundles.set(definition.id, bundle)

    return this.deliver(bundle)
  }
  private deliver(bundle: RewardBundle): () => void {
    if (bundle.delivered) return () => {}

    let notifyInventory: (() => void) | undefined

    try {
      const totals = new Map<string, StateWrite>()

      for (const entry of bundle.numeric) {
        const current = this.bindings.read({ source: 'game.state', path: [...entry.path] })

        if (
          current.status !== 'resolved' ||
          typeof current.value !== 'number' ||
          !Number.isSafeInteger(current.value) ||
          current.value < 0
        ) {
          bundle.issue = 'rewardInvalidAmount'

          return () => this.notify()
        }

        const key = JSON.stringify(entry.path)
        const value = (totals.get(key)?.value ?? current.value) + entry.amount

        if (!Number.isSafeInteger(value)) {
          bundle.issue = 'rewardInvalidAmount'

          return () => this.notify()
        }

        totals.set(key, { path: entry.path, expected: current.value, value })
      }

      const state = totals.size ? this.state?.prepare([...totals.values()]) : undefined

      if (totals.size && !state) {
        bundle.issue = 'rewardUnavailable'

        return () => this.notify()
      }

      const creation = bundle.items.length
        ? this.inventory?.prepareCreate?.(bundle.items)
        : undefined

      if (bundle.items.length && !creation) {
        bundle.issue = 'rewardInventory'

        return () => this.notify()
      }

      if ((state && !state.isCurrent()) || (creation && !creation.isCurrent())) {
        bundle.issue = 'rewardUnavailable'

        return () => this.notify()
      }

      state?.commit()
      creation?.commit()
      bundle.delivered = true
      bundle.issue = undefined
      bundle.token = {}
      notifyInventory = creation && (() => creation.notify())
    } catch {
      bundle.issue = 'rewardUnavailable'
    }

    return () => this.publish([notifyInventory, this.invalidate])
  }
  capture(scene: SceneInstance, id: string, operation: RewardOperation): CombatCapture | undefined {
    const view = this.view(scene, id)
    const bundle = view && this.bundles.get(view.definition.id)

    if (!view || !bundle) return

    const selection =
      operation === 'take-loot' && view.component.lootInventory
        ? this.selection?.get(scene, view.component.lootInventory)
        : undefined

    const inventory = operation === 'retry-rewards' ? bundle.token : this.inventoryToken
    const key = `${id}/${operation}`
    let cached = this.captures.get(key)

    if (
      !cached ||
      cached.scene !== scene ||
      cached.bundle !== bundle.token ||
      cached.inventory !== inventory ||
      cached.selection !== selection
    ) {
      cached = {
        scene,
        bundle: bundle.token,
        inventory,
        selection,
        capture: Object.freeze({ round: bundle.token, target: selection }),
      }
      this.captures.set(key, cached)
    }

    return cached.capture
  }
  canCommand(scene: SceneInstance, id: string, operation: RewardOperation): boolean {
    const view = this.view(scene, id)
    const bundle = view && this.bundles.get(view.definition.id)

    if (!view || !bundle) return false

    if (operation === 'retry-rewards') return !bundle.delivered
    const remaining = this.remaining(view.definition, bundle)

    const selected =
      view.component.lootInventory && this.selection?.get(scene, view.component.lootInventory)?.item

    const items =
      operation === 'take-loot' ? remaining.filter((item) => item.id === selected) : remaining

    return Boolean(
      view.component.lootInventory &&
      items.length &&
      this.inventory?.prepareTransfers?.(
        items.map((item) => ({
          item: item.id,
          destination: { type: 'carried', owner: view.rewards.recipient! },
        })),
      ),
    )
  }
  execute(scene: SceneInstance, id: string, operation: RewardOperation): void {
    const view = this.view(scene, id)
    const bundle = view && this.bundles.get(view.definition.id)

    if (!view || !bundle || !this.canCommand(scene, id, operation)) return

    if (operation === 'retry-rewards') {
      this.deliver(bundle)()

      return
    }

    const selected =
      view.component.lootInventory && this.selection?.get(scene, view.component.lootInventory)?.item

    const items = this.remaining(view.definition, bundle).filter(
      (item) => operation === 'take-all-loot' || item.id === selected,
    )

    const transfer = this.inventory?.prepareTransfers?.(
      items.map((item) => ({
        item: item.id,
        destination: { type: 'carried', owner: view.rewards.recipient! },
      })),
    )

    if (!transfer?.isCurrent()) return
    transfer.commit()
    bundle.taken = Object.freeze(items.map((item) => item.itemType))
    bundle.token = {}
    this.publish([
      () => transfer.notify(),
      () => {
        if (view.component.lootInventory)
          this.selection?.select(scene, view.component.lootInventory)
      },
    ])
  }
  text(scene: SceneInstance, id: string): string {
    const view = this.view(scene, id)
    const bundle = view && this.bundles.get(view.definition.id)

    if (!view || !bundle) return ''
    const { messages } = view.definition

    if (!bundle.delivered)
      return messages.rewardsPending.replaceAll(
        '{reason}',
        messages[bundle.issue ?? 'rewardUnavailable'],
      )

    const amounts = bundle.numeric.map((entry) =>
      messages.rewardAmount
        .replaceAll(
          '{label}',
          view.rewards.numeric.find((value) => value.id === entry.id)?.label ?? entry.id,
        )
        .replaceAll('{amount}', String(entry.amount)),
    )

    const items = bundle.taken
      .map((type) => this.game.data.inventory?.itemTypes[type]?.label ?? type)
      .join(', ')

    return [
      messages.rewardsDelivered,
      ...amounts,
      messages.lootRemaining.replaceAll(
        '{count}',
        String(this.remaining(view.definition, bundle).length),
      ),
      ...(items ? [messages.lootTaken.replaceAll('{items}', items)] : []),
    ].join('\n')
  }
  private publish(notifications: readonly ((() => void) | undefined)[]): void {
    const errors: unknown[] = []
    this.publishing = true

    try {
      for (const notify of notifications)
        try {
          notify?.()
        } catch (error) {
          errors.push(error)
        }
    } finally {
      this.publishing = false
    }

    try {
      this.notify()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length)
      throw new AggregateError(errors, 'Combat rewards committed but observers failed')
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  private notify(): void {
    if (
      this.disposed ||
      !this.lifecycle.activeScene?.data.components.some((component) => component.type === 'combat')
    )
      return
    const errors: unknown[] = []

    for (const listener of [...this.listeners])
      try {
        if (this.listeners.has(listener)) listener()
      } catch (error) {
        errors.push(error)
      }

    if (errors.length) throw new AggregateError(errors, 'Combat reward observers failed')
  }
  dispose(): void {
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.bundles.clear()
    this.captures.clear()
    this.listeners.clear()
  }
}
