import { resolveMapObject, type MapObject, type MapObjectStateReader } from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameMapMovement } from './mapMovement.js'

export interface IGameMapObjects {
  getAppearance(scene: SceneInstance, mapView: string, object: string): MapObject | undefined
  getTarget(scene: SceneInstance, mapView: string, object?: string): MapObject | undefined
  interact(scene: SceneInstance, mapView: string, object?: string): boolean
  subscribeChanges(listener: () => void): () => void
}

/** Resolves adjacent authored objects; queued actions revalidate their captured target. */
export class GameMapObjects implements IGameMapObjects {
  private disposed = false

  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly movement: IGameMapMovement,
    private readonly request: (action: string, payload: string, isCurrent: () => boolean) => void,
    private readonly readState?: MapObjectStateReader,
  ) {}

  getAppearance(scene: SceneInstance, mapView: string, object: string): MapObject | undefined {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return
    const view = scene.data.components.find(({ id }) => id === mapView)

    const entry =
      view?.type === 'map-view' ? view.map.objects?.find(({ id }) => id === object) : undefined

    return entry && resolveMapObject(entry, this.readState)
  }

  getTarget(scene: SceneInstance, mapView: string, object?: string): MapObject | undefined {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return
    const position = this.movement.getPosition(scene, mapView)

    if (!position || this.movement.isMoving(scene, mapView)) return
    const view = scene.data.components.find(({ id }) => id === mapView)

    if (view?.type !== 'map-view') return

    const targets =
      view.map.objects?.filter(
        (entry) =>
          (!object || entry.id === object) &&
          resolveMapObject(entry, this.readState).visible !== false &&
          Math.abs(entry.x - position.x) + Math.abs(entry.y - position.y) === 1,
      ) ?? []

    return targets.length === 1 ? targets[0] : undefined
  }

  interact(scene: SceneInstance, mapView: string, object?: string): boolean {
    const target = this.getTarget(scene, mapView, object)

    if (!target) return false
    this.request(
      target.action,
      target.id,
      () => this.getTarget(scene, mapView, target.id) === target,
    )

    return true
  }

  subscribeChanges(listener: () => void): () => void {
    return this.disposed ? () => {} : this.movement.subscribeChanges(listener)
  }

  dispose(): void {
    this.disposed = true
  }
}
