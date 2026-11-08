import {
  getMapMovementCostMs,
  type MapPosition,
  type ButtonComponentDefinition,
} from '@ancadeba/schemas'
import type { ITaskScheduler } from '@ancadeba/utilities'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import { GameSaveError } from './gameSaves.js'

export type MapDirection = Extract<
  NonNullable<ButtonComponentDefinition['action']>,
  { type: 'move-map' }
>['direction']

export interface IGameMapMovement {
  getPosition(scene: SceneInstance, mapView: string): Readonly<MapPosition> | undefined
  canMove(scene: SceneInstance, mapView: string, direction: MapDirection): boolean
  move(scene: SceneInstance, mapView: string, direction: MapDirection): boolean
  subscribeChanges(listener: () => void): () => void
}

const directions = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
}

interface MapState {
  position: Readonly<MapPosition>
  pending?: object | undefined
  cancel?: (() => void) | undefined
}

/** Shares scene-local player positions between map views, buttons, and input routing. */
export class GameMapMovement implements IGameMapMovement {
  private scene: SceneInstance | undefined
  private readonly maps = new Map<string, MapState>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private disposed = false

  save(): Record<string, MapPosition> {
    if ([...this.maps.values()].some((state) => state.pending)) throw new GameSaveError('busy')

    return Object.fromEntries([...this.maps].map(([id, state]) => [id, { ...state.position }]))
  }

  restore(scene: SceneInstance, positions: Readonly<Record<string, MapPosition>>): void {
    for (const [id, position] of Object.entries(positions)) {
      const resolved = this.resolve(scene, id)

      if (!resolved || getMapMovementCostMs(resolved.component.map, position) === undefined)
        throw new Error('Invalid saved map position')
      resolved.state.position = Object.freeze({ ...position })
    }

    this.notify()
  }

  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly scheduler: ITaskScheduler,
  ) {
    this.unsubscribe = lifecycle.subscribeSceneChanges(({ current }) => {
      if (current === this.scene) return
      const changed = this.maps.size > 0
      this.clear()

      if (changed) this.notify()
    })
  }

  private resolve(scene: SceneInstance, mapView: string) {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return
    const component = scene.data.components.find((entry) => entry.id === mapView)

    if (component?.type !== 'map-view' || !component.playerSpawn || component.interactive === false)
      return

    if (this.scene !== scene) {
      this.clear()
      this.scene = scene
    }

    let state = this.maps.get(mapView)

    if (!state) {
      state = { position: Object.freeze({ ...component.playerSpawn }) }
      this.maps.set(mapView, state)
    }

    return { component, state }
  }

  getPosition(scene: SceneInstance, mapView: string): Readonly<MapPosition> | undefined {
    return this.resolve(scene, mapView)?.state.position
  }

  private destination(scene: SceneInstance, mapView: string, direction: MapDirection) {
    const resolved = this.resolve(scene, mapView)

    if (!resolved || resolved.state.pending) return
    const step = directions[direction]

    const position = {
      x: resolved.state.position.x + step.x,
      y: resolved.state.position.y + step.y,
    }

    const duration = getMapMovementCostMs(resolved.component.map, position)

    return duration === undefined ? undefined : { state: resolved.state, position, duration }
  }

  canMove(scene: SceneInstance, mapView: string, direction: MapDirection): boolean {
    return this.destination(scene, mapView, direction) !== undefined
  }

  move(scene: SceneInstance, mapView: string, direction: MapDirection): boolean {
    const destination = this.destination(scene, mapView, direction)

    if (!destination) return false
    const { state, position, duration } = destination

    if (duration === 0) state.position = Object.freeze(position)
    else {
      const token = {}
      state.pending = token

      try {
        state.cancel = this.scheduler.schedule(() => {
          if (
            this.disposed ||
            scene.disposed ||
            this.lifecycle.activeScene !== scene ||
            this.scene !== scene ||
            state.pending !== token
          )
            return
          state.pending = undefined
          state.cancel = undefined
          state.position = Object.freeze(position)
          this.notify()
        }, duration)
      } catch (error) {
        state.pending = undefined
        throw error
      }
    }

    this.notify()

    return true
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

    if (errors.length) throw new AggregateError(errors, 'Map movement subscribers failed')
  }

  private clear(): void {
    for (const state of this.maps.values()) {
      state.pending = undefined
      state.cancel?.()
    }

    this.maps.clear()
    this.scene = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.clear()
    this.listeners.clear()
  }
}
