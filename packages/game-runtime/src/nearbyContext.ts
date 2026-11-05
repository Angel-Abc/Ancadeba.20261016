import { inventoryEntry, type NearbyEntryDefinition } from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameBindings } from './gameBindings.js'

export interface NearbySelection {
  readonly entry: string
}

export interface IGameNearby {
  getSelection(scene: SceneInstance, panel: string): NearbySelection | undefined
  getEntry(scene: SceneInstance, panel: string, entry: string): NearbyEntryDefinition | undefined
  select(scene: SceneInstance, panel: string, entry?: string): void
  subscribeChanges(listener: () => void): () => void
}

/** Owns nearby target selection and invalidates it when a target becomes unavailable. */
export class GameNearbyContext implements IGameNearby {
  private scene: SceneInstance | undefined
  private readonly selections = new Map<string, NearbySelection>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[]
  private disposed = false

  constructor(
    private readonly lifecycle: IGameLifecycle,
    bindings: IGameBindings,
  ) {
    this.cleanups = [
      bindings.subscribeChanges(() => this.prune()),
      lifecycle.subscribeSceneChanges(({ current }) => {
        if (current === this.scene) return
        this.scene = undefined

        if (!this.selections.size) return
        this.selections.clear()
        this.notify()
      }),
    ]
  }

  getEntry(scene: SceneInstance, panel: string, id: string): NearbyEntryDefinition | undefined {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return
    const data = scene.game.data.localization?.current.scenes.get(scene.data.id) ?? scene.data
    const component = data.components.find((component) => component.id === panel)

    if (component?.type !== 'nearby') return
    const entry = inventoryEntry(component.entries, id)

    if (!entry) return

    if (entry.visibleWhen) {
      const result = scene.game.bindings?.read(entry.visibleWhen)

      if (result?.status !== 'resolved' || result.value !== true) return
    }

    return entry
  }

  getSelection(scene: SceneInstance, panel: string): NearbySelection | undefined {
    const selected = this.scene === scene ? this.selections.get(panel) : undefined

    return selected && this.getEntry(scene, panel, selected.entry) ? selected : undefined
  }

  select(scene: SceneInstance, panel: string, id?: string): void {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return

    if (id !== undefined && !this.getEntry(scene, panel, id)) return

    if (this.scene !== scene) {
      this.selections.clear()
      this.scene = scene
    }

    if (this.selections.get(panel)?.entry === id) return

    if (id === undefined) this.selections.delete(panel)
    else this.selections.set(panel, Object.freeze({ entry: id }))
    this.notify()
  }

  private prune(): void {
    let changed = false

    for (const [panel, selected] of this.selections) {
      if (this.scene && this.getEntry(this.scene, panel, selected.entry)) continue
      this.selections.delete(panel)
      changed = true
    }

    if (changed) this.notify()
  }

  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    const errors: unknown[] = []

    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue

      try {
        listener()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) throw new AggregateError(errors, 'Nearby selection subscribers failed')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.selections.clear()
    this.listeners.clear()
    this.scene = undefined
  }
}
