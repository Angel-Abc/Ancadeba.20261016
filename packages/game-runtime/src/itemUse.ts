import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameInventorySelection, InventorySelectionSnapshot } from './inventoryContext.js'
import type { IGameInventory, InventoryItemSnapshot } from './inventory.js'
import type { IGameBindings } from './gameBindings.js'
import type { IStateTransactions } from './stateTransactions.js'
import type { IGameCombat, CombatCapture } from './combat.js'
import type { IMessageBus } from '@ancadeba/utilities'
import type { EngineMessages } from './messages.js'
import type { ActionOrigin } from './actions.js'
import { usableItem } from './itemUseEligibility.js'

export interface ItemUseCapture {
  readonly owner: string | undefined
  readonly lineage: readonly InventoryItemSnapshot[]
  readonly selection: InventorySelectionSnapshot | undefined
  readonly item: InventoryItemSnapshot | undefined
  readonly combat: CombatCapture | undefined
  readonly mode: string | undefined
}

export interface ItemUseRequest {
  readonly scene: SceneInstance
  readonly inventory: string
  readonly combat?: string | undefined
  readonly capture: ItemUseCapture
  readonly origin: ActionOrigin
}

export interface IGameItemUse {
  reason(scene: SceneInstance, inventory: string, combat?: string): string | undefined
  capture(scene: SceneInstance, inventory: string, combat?: string): ItemUseCapture | undefined
  request(
    scene: SceneInstance,
    inventory: string,
    combat?: string,
    capture?: ItemUseCapture,
    origin?: ActionOrigin,
  ): void
  details(scene: SceneInstance, inventory: string, combat?: string): string
  feedback(scene: SceneInstance, inventory: string): string
  subscribeChanges(listener: () => void): () => void
}

/** Coordinates selected item requests; combat owns queued execution and round commits. */
export class GameItemUse implements IGameItemUse {
  private readonly listeners = new Set<() => void>()
  private readonly captures = new WeakMap<SceneInstance, Map<string, ItemUseCapture>>()
  private readonly results = new WeakMap<
    SceneInstance,
    Map<string, { itemType: string; amount: number }>
  >()
  private readonly cleanups: (() => void)[] = []
  private disposed = false

  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly selection: IGameInventorySelection,
    private readonly inventory: IGameInventory | undefined,
    private readonly bindings: IGameBindings,
    private readonly state: IStateTransactions | undefined,
    private readonly combat: () => IGameCombat | undefined,
    private readonly messages: IMessageBus<EngineMessages>,
    private readonly invalidate: () => void,
  ) {
    this.cleanups.push(
      selection.subscribe(() => this.notify()),
      bindings.subscribeChanges(() => this.notify()),
      messages.subscribe('item-use.request', (request) => this.execute(request)),
    )

    if (inventory) this.cleanups.push(inventory.subscribeChanges(() => this.notify()))
  }

  start(): void {
    const cleanup = this.combat()?.subscribeChanges(() => this.notify())

    if (cleanup) this.cleanups.push(cleanup)
  }

  private resolve(scene: SceneInstance, panel: string, combat?: string) {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return

    const component = scene.data.components.find(
      (entry) => entry.type === 'inventory' && entry.id === panel,
    )

    if (component?.type !== 'inventory') return
    const selected = this.selection.get(scene, panel)

    const item = usableItem(
      this.inventory,
      scene.game.data.inventory,
      selected?.item ?? '',
      this.bindings,
    )

    const ability =
      item.use &&
      scene.game.data.combatLibraries?.get(item.use.ability.library)?.moves[item.use.ability.id]

    const combatComponent = combat
      ? scene.data.components.find((entry) => entry.id === combat && entry.type === 'combat')
      : undefined

    const snapshot = combatComponent
      ? this.combat()?.snapshot(scene, combatComponent.id)
      : undefined

    const mode = snapshot?.phase === 'planning' ? combatComponent?.id : undefined

    return {
      ...item,
      selected,
      component,
      ability,
      snapshot,
      mode,
      invalidCombat: Boolean(combat && !combatComponent),
    }
  }

  reason(scene: SceneInstance, panel: string, combat?: string): string | undefined {
    const value = this.resolve(scene, panel, combat)

    if (!value) return 'Item use is unavailable.'
    const { messages, use, ability, owner } = value

    if (value.component.readOnly) return messages.readOnly

    if (value.reason) return value.reason

    if (!use || !ability || ability.type !== 'ability' || !owner || value.invalidCombat)
      return messages.unavailable

    if (value.mode) return this.combat()?.itemIssue(scene, value.mode, value.item!.id) ?? undefined

    if (this.combat()?.unfinishedOwner(owner)) return messages.paused

    if (!use.contexts.includes('outside-combat')) return messages.context

    if (
      ability.target !== 'self' ||
      Boolean(ability.apCostScaling) ||
      ability.effects.some(
        (effect) =>
          effect.type !== 'heal' || Boolean(effect.conditions?.length) || Boolean(effect.scaling),
      ) ||
      Object.keys(ability.resourceCosts ?? {}).length > 0
    )
      return messages.context
    const profile = scene.type === 'game' ? scene.game.combatStats?.snapshot(owner) : undefined

    if (!profile || !this.state || !this.inventory?.prepareRemove) return messages.unavailable

    if (
      !profile.health ||
      profile.health >= profile.total.maximumHealth ||
      !ability.effects.some((effect) => effect.type === 'heal' && effect.amount > 0)
    )
      return messages.noEffect

    const field =
      scene.type === 'game'
        ? scene.game.data.inventory?.owners[owner]?.combatStats?.health
        : undefined

    if (
      !field ||
      !this.state.prepare([{ path: field.path, expected: profile.health, value: profile.health }])
    )
      return messages.unavailable
  }

  capture(scene: SceneInstance, panel: string, combat?: string): ItemUseCapture | undefined {
    const value = this.resolve(scene, panel, combat)

    if (!value) return
    let entries = this.captures.get(scene)

    if (!entries) {
      entries = new Map()
      this.captures.set(scene, entries)
    }

    const key = JSON.stringify([panel, combat])

    const combatCapture =
      value.mode && value.item
        ? this.combat()?.capture(scene, value.mode, {
            type: 'queue-item',
            item: value.item.id,
            inventory: panel,
          })
        : undefined

    let capture = entries.get(key)

    if (
      !capture ||
      capture.selection !== value.selected ||
      capture.item !== value.item ||
      capture.combat !== combatCapture ||
      capture.mode !== value.mode ||
      capture.owner !== value.owner ||
      capture.lineage.length !== value.lineage.length ||
      capture.lineage.some((entry, index) => entry !== value.lineage[index])
    ) {
      capture = Object.freeze({
        owner: value.owner,
        lineage: Object.freeze(value.lineage),
        selection: value.selected,
        item: value.item,
        combat: combatCapture,
        mode: value.mode,
      })
      entries.set(key, capture)
    }

    return capture
  }

  request(
    scene: SceneInstance,
    inventory: string,
    combat?: string,
    capture = this.capture(scene, inventory, combat),
    origin: ActionOrigin = { type: 'direct' },
  ): void {
    if (
      !capture ||
      capture !== this.capture(scene, inventory, combat) ||
      this.reason(scene, inventory, combat)
    )
      return

    if (capture.mode && capture.item) {
      this.combat()?.request(
        scene,
        capture.mode,
        { type: 'queue-item', item: capture.item.id, inventory },
        capture.combat,
        origin,
      )

      return
    }

    this.messages.publish(
      'item-use.request',
      Object.freeze({ scene, inventory, combat, capture, origin }),
    )
  }

  private execute(request: ItemUseRequest): void {
    const { scene, inventory, combat, capture } = request

    if (
      scene.type !== 'game' ||
      capture !== this.capture(scene, inventory, combat) ||
      this.reason(scene, inventory, combat)
    )
      return
    const value = this.resolve(scene, inventory, combat)

    if (
      !value?.item ||
      !value.owner ||
      !value.use ||
      value.ability?.type !== 'ability' ||
      value.mode
    )
      return
    const profile = scene.game.combatStats?.snapshot(value.owner)
    const field = scene.game.data.inventory?.owners[value.owner]?.combatStats?.health

    if (!profile || !field) return
    let health = profile.health

    for (const effect of value.ability.effects)
      if (effect.type === 'heal')
        health += Math.min(effect.amount, profile.total.maximumHealth - health)

    const writes = this.state?.prepare([
      { path: field.path, expected: profile.health, value: health },
    ])

    const removal =
      value.use.consumption === 'consume'
        ? this.inventory?.prepareRemove?.([value.item.id])
        : undefined

    if (
      !writes?.isCurrent() ||
      (value.use.consumption === 'consume' && !removal?.isCurrent()) ||
      health === profile.health
    )
      return
    removal?.commit()
    writes.commit()
    let results = this.results.get(scene)

    if (!results) {
      results = new Map()
      this.results.set(scene, results)
    }

    results.set(inventory, { itemType: value.item.itemType, amount: health - profile.health })
    const errors: unknown[] = []

    for (const notify of [() => removal?.notify(), this.invalidate, () => this.notify()])
      try {
        notify()
      } catch (error) {
        errors.push(error)
      }

    if (errors.length) throw new AggregateError(errors, 'Item use committed but observers failed')
  }

  details(scene: SceneInstance, panel: string, combat?: string): string {
    const value = this.resolve(scene, panel, combat)

    if (!value?.use || !value.ability) return ''
    const { use, ability, messages } = value
    const definition = value.mode && this.combat()?.definition(scene, value.mode)

    const apCost = definition
      ? (value.snapshot?.moveCosts[definition.player.id]?.[use.ability.id] ?? ability.apCost)
      : ability.apCost

    return [
      messages.details
        .replaceAll('{ability}', ability.label)
        .replaceAll('{consumption}', messages[use.consumption])
        .replaceAll(
          '{contexts}',
          use.contexts
            .map((context) => (context === 'combat' ? messages.combat : messages.outside))
            .join(', '),
        ),
      messages.cost
        .replaceAll('{ap}', String(apCost))
        .replaceAll('{cooldown}', String(ability.cooldown ?? 0)),
      this.reason(scene, panel, combat),
    ]
      .filter(Boolean)
      .join('\n')
  }

  feedback(scene: SceneInstance, panel: string): string {
    const result = this.results.get(scene)?.get(panel)

    const type =
      scene.type === 'game' && result
        ? scene.game.data.inventory?.itemTypes[result.itemType]
        : undefined

    return type?.use && result
      ? type.use.messages.used
          .replaceAll('{item}', type.label)
          .replaceAll('{amount}', String(result.amount))
      : ''
  }

  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }
  private notify(): void {
    if (this.disposed) return
    const errors: unknown[] = []

    for (const listener of [...this.listeners])
      try {
        listener()
      } catch (error) {
        errors.push(error)
      }

    if (errors.length) throw new AggregateError(errors, 'Item-use observers failed')
  }
  dispose(): void {
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.listeners.clear()
  }
}
