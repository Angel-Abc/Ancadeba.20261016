import {
  inventoryEntry,
  inventoryOwner,
  type EquipmentComponentDefinition,
} from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameInventorySelection, InventorySelectionSnapshot } from './inventoryContext.js'
import type { IGameInventory } from './inventory.js'
import type { IGameCombatStats } from './combatStats.js'

export interface EquipmentSelection {
  readonly item: string | undefined
  readonly slot: string | undefined
}

export interface IGameEquipment {
  reason(
    scene: SceneInstance,
    equipment: string,
    operation: 'equip' | 'unequip',
  ): string | undefined
  get(scene: SceneInstance, equipment: string): EquipmentSelection | undefined
  selectSlot(scene: SceneInstance, equipment: string, slot: string): void
  isEnabled(scene: SceneInstance, equipment: string, operation: 'equip' | 'unequip'): boolean
  activate(scene: SceneInstance, equipment: string, operation: 'equip' | 'unequip'): void
  subscribe(listener: () => void): () => void
}

interface Target {
  version?: object | undefined
  selection: InventorySelectionSnapshot | undefined
  owner: string | undefined
  token: EquipmentSelection
}

/** Coordinates explicit equipment destinations using the inventory's atomic operations. */
export class GameEquipment implements IGameEquipment {
  private scene: SceneInstance | undefined
  private readonly targets = new Map<string, Target>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[]
  private disposed = false
  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly selection: IGameInventorySelection,
    inventory?: IGameInventory,
    stats?: IGameCombatStats,
  ) {
    this.cleanups = [
      selection.subscribe(() => this.notify()),
      lifecycle.subscribeSceneChanges(({ current }) => {
        if (current === this.scene) return
        const changed = this.targets.size > 0
        this.scene = undefined
        this.targets.clear()

        if (changed) this.notify()
      }),
    ]

    if (inventory) this.cleanups.push(inventory.subscribeChanges(() => this.notify()))

    if (stats) this.cleanups.push(stats.subscribeChanges(() => this.notify()))
  }
  private definition(scene: SceneInstance, id: string): EquipmentComponentDefinition | undefined {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return
    const component = scene.data.components.find((entry) => entry.id === id)

    return component?.type === 'equipment' ? component : undefined
  }
  get(scene: SceneInstance, id: string): EquipmentSelection | undefined {
    const component = this.definition(scene, id)

    if (!component || scene.type !== 'game') return

    if (this.scene !== scene) {
      this.targets.clear()
      this.scene = scene
    }

    const selection = this.selection.get(scene, component.inventory)
    let target = this.targets.get(id)
    const items = new Map(scene.game.inventory?.snapshot.map((item) => [item.id, item]))
    const item = selection && items.get(selection.item)
    const ownerId = item ? inventoryOwner(items, item.id) : undefined
    const version = scene.game.combatStats?.snapshot(component.owner)?.version

    if (
      !target ||
      target.selection !== selection ||
      target.owner !== ownerId ||
      target.version !== version
    ) {
      const inventory = scene.game.data.inventory
      const owner = inventory && inventoryEntry(inventory.owners, component.owner)
      const type = item && inventory && inventoryEntry(inventory.itemTypes, item.itemType)

      const own = ownerId === component.owner

      const compatible =
        own && type && owner
          ? Object.keys(owner.equipmentSlots).filter((slot) => type.equipmentSlots.includes(slot))
          : []

      target = {
        selection,
        owner: ownerId,
        version,
        token: Object.freeze({
          item: selection?.item,
          slot:
            target && target.selection === selection && target.owner === ownerId
              ? target.token.slot
              : compatible.length === 1
                ? compatible[0]
                : undefined,
        }),
      }
      this.targets.set(id, target)
    }

    return target.token
  }
  selectSlot(scene: SceneInstance, id: string, slot: string): void {
    const component = this.definition(scene, id)
    const token = this.get(scene, id)

    if (!component || !token || scene.type !== 'game') return

    const owner =
      scene.game.data.inventory && inventoryEntry(scene.game.data.inventory.owners, component.owner)

    if (!owner || !Object.hasOwn(owner.equipmentSlots, slot) || token.slot === slot) return
    const target = this.targets.get(id)!
    target.token = Object.freeze({ item: token.item, slot })
    this.notify()
  }
  isEnabled(scene: SceneInstance, id: string, operation: 'equip' | 'unequip'): boolean {
    const component = this.definition(scene, id)
    const token = this.get(scene, id)

    if (
      !component ||
      component.readOnly ||
      scene.type !== 'game' ||
      !token?.item ||
      !scene.game.inventory
    )
      return false
    const item = scene.game.inventory.snapshot.find((item) => item.id === token.item)

    if (!item) return false

    if (operation === 'unequip')
      return (
        item.placement.type === 'equipped' &&
        item.placement.owner === component.owner &&
        scene.game.inventory.checkMove(item.id, { type: 'carried', owner: component.owner }) ===
          undefined
      )

    if (!token.slot) return false

    if (
      item.placement.type === 'equipped' &&
      item.placement.owner === component.owner &&
      item.placement.slot === token.slot
    )
      return false

    return scene.game.inventory.checkEquip(item.id, component.owner, token.slot) === undefined
  }
  reason(scene: SceneInstance, id: string, operation: 'equip' | 'unequip'): string | undefined {
    const component = this.definition(scene, id)

    if (!component || scene.type !== 'game') return
    const lock = scene.game.combatStats?.reason(component.owner)

    if (lock) return lock
    const token = this.get(scene, id)

    if (!token?.item || component.readOnly) return

    return operation === 'unequip'
      ? scene.game.inventory?.checkMove(token.item, { type: 'carried', owner: component.owner })
      : token.slot
        ? scene.game.inventory?.checkEquip(token.item, component.owner, token.slot)
        : undefined
  }
  activate(scene: SceneInstance, id: string, operation: 'equip' | 'unequip'): void {
    if (!this.isEnabled(scene, id, operation) || scene.type !== 'game') return
    const component = this.definition(scene, id)!
    const token = this.get(scene, id)!

    if (operation === 'equip')
      scene.game.inventory!.equip(token.item!, component.owner, token.slot!)
    else scene.game.inventory!.move(token.item!, { type: 'carried', owner: component.owner })
  }
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  private notify(): void {
    if (
      !this.lifecycle.activeScene?.data.components.some(
        (component) => component.type === 'equipment',
      )
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

    if (errors.length) throw new AggregateError(errors, 'Equipment observers failed')
  }
  dispose(): void {
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.targets.clear()
    this.listeners.clear()
    this.scene = undefined
  }
}
