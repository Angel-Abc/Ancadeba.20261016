import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameInventory } from './inventory.js'

export interface InventorySelectionSnapshot {
  readonly item: string
}

export interface IGameInventorySelection {
  get(scene: SceneInstance, panel: string): InventorySelectionSnapshot | undefined
  select(scene: SceneInstance, panel: string, item?: string): void
  subscribe(listener: () => void): () => void
}

/** Scene-local item selection shared by inventory panels and contextual commands. */
export class GameInventoryContext implements IGameInventorySelection {
  private scene: SceneInstance | undefined
  private readonly selections = new Map<string, InventorySelectionSnapshot>()
  private readonly subscribers = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private disposed = false

  constructor(
    private readonly lifecycle: IGameLifecycle,
    inventory?: IGameInventory,
  ) {
    if (inventory) this.cleanups.push(inventory.subscribeChanges(() => this.prune()))
    this.cleanups.push(
      lifecycle.subscribeSceneChanges(({ current }) => {
        if (current === this.scene) return
        this.scene = undefined

        if (!this.selections.size) return
        this.selections.clear()
        this.notify()
      }),
    )
  }

  private visible(scene: SceneInstance, panel: string, item: string): boolean {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return false
    const component = scene.data.components.find((component) => component.id === panel)

    if (component?.type !== 'inventory') return false
    const items = new Map(scene.game.inventory?.snapshot.map((entry) => [entry.id, entry]))
    const visited = new Set<string>()
    let current = items.get(item)

    while (current && !visited.has(current.id)) {
      visited.add(current.id)

      if (current.placement.type !== 'inside')
        return component.owners.includes(current.placement.owner)
      current = items.get(current.placement.container)
    }

    return false
  }

  get(scene: SceneInstance, panel: string): InventorySelectionSnapshot | undefined {
    const selected = this.scene === scene ? this.selections.get(panel) : undefined

    return selected && this.visible(scene, panel, selected.item) ? selected : undefined
  }

  select(scene: SceneInstance, panel: string, item?: string): void {
    if (this.disposed || scene.disposed || scene !== this.lifecycle.activeScene) return

    if (item !== undefined && !this.visible(scene, panel, item)) return

    if (this.scene !== scene) {
      this.selections.clear()
      this.scene = scene
    }

    if (this.selections.get(panel)?.item === item) return

    if (item !== undefined) {
      const shop = scene.data.components.find(
        (component) =>
          component.type === 'shop' &&
          [component.playerInventory, component.merchantInventory].includes(panel),
      )

      if (shop?.type === 'shop')
        this.selections.delete(
          panel === shop.playerInventory ? shop.merchantInventory : shop.playerInventory,
        )
    }

    if (item === undefined) this.selections.delete(panel)
    else this.selections.set(panel, Object.freeze({ item }))
    this.notify()
  }

  private prune(): void {
    let changed = false

    for (const [panel, selected] of this.selections) {
      if (this.scene && this.visible(this.scene, panel, selected.item)) continue
      this.selections.delete(panel)
      changed = true
    }

    if (changed) this.notify()
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.subscribers.add(listener)

    return () => this.subscribers.delete(listener)
  }

  private notify(): void {
    const errors: unknown[] = []

    for (const listener of [...this.subscribers]) {
      if (!this.subscribers.has(listener)) continue

      try {
        listener()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) throw new AggregateError(errors, 'Inventory context subscribers failed')
  }

  dispose(): void {
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.selections.clear()
    this.subscribers.clear()
    this.scene = undefined
  }
}
