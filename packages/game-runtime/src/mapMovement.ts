import {
  getMapMovementCostMs,
  getMapPotentialMovementCostMs,
  resolveMapObject,
  isBlockingMapObject,
  type MapDefinition,
  type MapObjectStateReader,
  type MapPosition,
  type ButtonComponentDefinition,
  type SavedMapPositions,
  type MapEntryTrigger,
} from '@ancadeba/schemas'
import type { ITaskScheduler } from '@ancadeba/utilities'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import { GameSaveError } from './gameSaves.js'
import type { GameData } from './gameData.js'
import type { PreparedProgression } from './progression.js'

export type MapDirection = Extract<
  NonNullable<ButtonComponentDefinition['action']>,
  { type: 'move-map' }
>['direction']

export interface IGameMapMovement {
  getTileCost(map: MapDefinition, position: MapPosition): number | undefined
  getPosition(scene: SceneInstance, mapView: string): Readonly<MapPosition> | undefined
  canMove(scene: SceneInstance, mapView: string, direction: MapDirection): boolean
  isMoving(scene: SceneInstance, mapView: string): boolean
  move(scene: SceneInstance, mapView: string, direction: MapDirection): boolean
  place(scene: SceneInstance, mapView: string, position: Readonly<MapPosition>): void
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

/** Owns each scene's map-view positions for the lifetime of a playthrough. */
export class GameMapMovement implements IGameMapMovement {
  private scene: SceneInstance | undefined
  private readonly maps = new Map<string, Map<string, MapState>>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeState: (() => void) | undefined
  private disposed = false

  save(): Record<string, MapPosition> {
    const positions = this.savePositions()

    return (this.scene && positions[this.scene.data.id]) || {}
  }

  savePositions(): SavedMapPositions {
    if ([...this.maps.values()].some((maps) => [...maps.values()].some((state) => state.pending)))
      throw new GameSaveError('busy')

    return Object.fromEntries(
      [...this.maps].map(([scene, maps]) => [
        scene,
        Object.fromEntries([...maps].map(([id, state]) => [id, { ...state.position }])),
      ]),
    )
  }

  /** Validate all locations before publishing them, including scenes that are not active. */
  restorePositions(data: GameData, positions: SavedMapPositions): void {
    const restored = new Map<string, Map<string, MapState>>()

    for (const [sceneId, maps] of Object.entries(positions)) {
      const scene = data.scenes.get(sceneId)

      if (scene?.type !== 'game') throw new Error('Invalid saved map scene')
      const states = new Map<string, MapState>()

      for (const [id, position] of Object.entries(maps)) {
        const component = scene.components.find((component) => component.id === id)

        if (
          component?.type !== 'map-view' ||
          !component.playerSpawn ||
          component.interactive === false ||
          getMapPotentialMovementCostMs(component.map, position) === undefined
        )
          throw new Error('Invalid saved map position')
        states.set(id, { position: Object.freeze({ ...position }) })
      }

      restored.set(sceneId, states)
    }

    this.cancelSteps()
    this.maps.clear()

    for (const [scene, maps] of restored) this.maps.set(scene, maps)
  }

  restore(scene: SceneInstance, positions: Readonly<Record<string, MapPosition>>): void {
    for (const [id, position] of Object.entries(positions)) {
      const resolved = this.resolve(scene, id)

      if (!resolved || this.getTileCost(resolved.component.map, position) === undefined)
        throw new Error('Invalid saved map position')
      resolved.state.position = Object.freeze({ ...position })
    }

    this.notify()
  }

  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly scheduler: ITaskScheduler,
    private readonly onTileEntry?: (
      scene: SceneInstance,
      mapView: string,
      trigger: MapEntryTrigger,
    ) => void,
    private readonly objectState?: {
      read: MapObjectStateReader
      subscribe(listener: () => void): () => void
    },
    private readonly prepareProgression?: (cost: number) => PreparedProgression | undefined,
  ) {
    this.unsubscribe = lifecycle.subscribeSceneChanges(({ current }) => {
      if (current === this.scene) return
      const changed = this.scene !== undefined
      this.cancelSteps()

      if (changed) this.notify()
    })
    this.unsubscribeState = objectState?.subscribe(() => this.notify())
  }

  getTileCost(map: MapDefinition, position: MapPosition): number | undefined {
    return getMapMovementCostMs(map, position, (object) =>
      isBlockingMapObject(resolveMapObject(object, this.objectState?.read)),
    )
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
      this.cancelSteps()
      this.scene = scene
    }

    let maps = this.maps.get(scene.data.id)

    if (!maps) {
      maps = new Map()
      this.maps.set(scene.data.id, maps)
    }

    let state = maps.get(mapView)

    if (!state) {
      state = { position: Object.freeze({ ...component.playerSpawn }) }
      maps.set(mapView, state)
    }

    return { component, state }
  }

  getPosition(scene: SceneInstance, mapView: string): Readonly<MapPosition> | undefined {
    return this.resolve(scene, mapView)?.state.position
  }

  isMoving(scene: SceneInstance, mapView: string): boolean {
    return Boolean(this.resolve(scene, mapView)?.state.pending)
  }

  /** Place an arriving player without walking, charging a delay, or firing entry triggers. */
  place(scene: SceneInstance, mapView: string, position: Readonly<MapPosition>): void {
    const resolved = this.resolve(scene, mapView)

    if (!resolved || this.getTileCost(resolved.component.map, position) === undefined)
      throw new Error('Invalid destination map position')
    resolved.state.cancel?.()
    resolved.state.cancel = undefined
    resolved.state.pending = undefined
    resolved.state.position = Object.freeze({ ...position })
    this.notify()
  }

  private destination(scene: SceneInstance, mapView: string, direction: MapDirection) {
    const resolved = this.resolve(scene, mapView)

    if (!resolved || resolved.state.pending) return
    const step = directions[direction]

    const position = {
      x: resolved.state.position.x + step.x,
      y: resolved.state.position.y + step.y,
    }

    const duration = this.getTileCost(resolved.component.map, position)

    return duration === undefined
      ? undefined
      : { state: resolved.state, component: resolved.component, position, duration }
  }

  canMove(scene: SceneInstance, mapView: string, direction: MapDirection): boolean {
    return this.destination(scene, mapView, direction) !== undefined
  }

  move(scene: SceneInstance, mapView: string, direction: MapDirection): boolean {
    const destination = this.destination(scene, mapView, direction)

    if (!destination) return false
    const { state, component, position, duration } = destination

    const arrive = () => {
      const progression = this.prepareProgression?.(duration)

      if (this.prepareProgression && !progression?.isCurrent()) {
        this.notify()

        return false
      }

      state.position = Object.freeze(position)
      progression?.commit()
      const errors: unknown[] = []

      for (const notify of [
        () => progression?.notify(),
        () => this.notify(),
        () => {
          if (!this.disposed && !scene.disposed && this.lifecycle.activeScene === scene) {
            const trigger = component.map.entryTriggers?.find(
              (entry) => entry.x === position.x && entry.y === position.y,
            )

            if (trigger) this.onTileEntry?.(scene, mapView, trigger)
          }
        },
      ]) {
        try {
          notify()
        } catch (error) {
          errors.push(error)
        }
      }

      if (errors.length) throw new AggregateError(errors, 'Map arrival subscribers failed')

      return true
    }

    if (duration === 0) return arrive()
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

        if (this.getTileCost(component.map, position) === undefined) {
          this.notify()

          return
        }

        arrive()
      }, duration)
    } catch (error) {
      state.pending = undefined
      throw error
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

  private cancelSteps(): void {
    for (const maps of this.maps.values())
      for (const state of maps.values()) {
        state.pending = undefined
        const cancel = state.cancel
        state.cancel = undefined
        cancel?.()
      }

    this.scene = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.unsubscribeState?.()
    this.cancelSteps()
    this.maps.clear()
    this.listeners.clear()
  }
}
