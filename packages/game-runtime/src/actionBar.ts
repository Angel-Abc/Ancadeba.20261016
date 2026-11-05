import type { ActionBarSlotDefinition } from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { VirtualInput } from './input.js'

export interface IGameActionBar {
  isEnabled(scene: SceneInstance, bar: string, slot: string): boolean
  activate(scene: SceneInstance, bar: string, slot: string): void
}

interface CapturedSlot {
  readonly scene: SceneInstance
  readonly bar: string
  readonly slot: string
}

/** Resolves scene-owned slots before general input bindings, independently of the host. */
export class GameActionBar implements IGameActionBar {
  private readonly gestures = new Map<string, CapturedSlot | null>()
  private captured = new WeakMap<VirtualInput, CapturedSlot | null>()
  private disposed = false

  constructor(private readonly lifecycle: IGameLifecycle) {}

  private definition(
    scene: SceneInstance,
    bar: string,
    slot: string,
  ): ActionBarSlotDefinition | undefined {
    const component = scene.data.components.find((component) => component.id === bar)

    return component?.type === 'action-bar' ? component.slots[slot] : undefined
  }

  isEnabled(scene: SceneInstance, bar: string, slot: string): boolean {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return false
    const action = this.definition(scene, bar, slot)?.action

    if (!action) return false

    if (action.type !== 'request-action') return true

    if (!scene.game.actions) return false

    if (!action.enabledWhen) return true
    const result = scene.game.bindings?.read(action.enabledWhen)

    return result?.status === 'resolved' && result.value === true
  }

  activate(scene: SceneInstance, bar: string, slot: string): void {
    this.activateSlot({ scene, bar, slot })
  }

  private activateSlot(target: CapturedSlot, request?: (action: string) => void): void {
    const { scene, bar, slot } = target

    if (!this.isEnabled(scene, bar, slot) || scene.type !== 'game') return
    const action = this.definition(scene, bar, slot)!.action

    if (action.type === 'request-action') {
      if (request) request(action.action)
      else scene.game.actions?.request(action.action)

      return
    }

    if (action.type === 'new-game') this.lifecycle.startGame()
    this.lifecycle.enterScene(action.scene)
  }

  /** Capture before queued delivery so a later scene cannot claim an earlier press. */
  captureInput(event: VirtualInput): void {
    if (this.disposed) return
    const key = JSON.stringify([event.context, event.input])
    let target = this.gestures.get(key) ?? null

    if (event.phase === 'pressed') {
      target = null
      const scene = this.lifecycle.activeScene

      if (scene?.type === 'game') {
        const bar = scene.data.components.find((component) => component.type === 'action-bar')

        const slot =
          bar &&
          Object.entries(bar.slots).find(
            ([, definition]) =>
              definition.inputBinding?.context === event.context &&
              definition.inputBinding.input === event.input,
          )

        if (bar && slot) target = { scene, bar: bar.id, slot: slot[0] }
      }

      this.gestures.set(key, target)
    } else this.gestures.delete(key)

    this.captured.set(event, target)
  }

  handleInput(event: VirtualInput, request: (action: string) => void): boolean {
    if (!this.captured.has(event)) this.captureInput(event)
    const target = this.captured.get(event)

    if (!target) return false

    if (event.phase === 'pressed') this.activateSlot(target, request)

    return true
  }

  dispose(): void {
    this.disposed = true
    this.gestures.clear()
    this.captured = new WeakMap()
  }
}
