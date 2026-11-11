import {
  getMapMovementCostMs,
  isBlockingMapObject,
  mapPositionSchema,
  resolveMapObject,
  type SceneTransition,
} from '@ancadeba/schemas'
import type { GameData } from './gameData.js'
import type { IGameMapMovement } from './mapMovement.js'

/** Navigation checks use live collision, or the initial authored flags before a game starts. */
export function canEnterScene(
  game: GameData,
  action: SceneTransition,
  movement?: Pick<IGameMapMovement, 'getTileCost'>,
): boolean {
  const scene = game.scenes.get(action.scene)

  if (!scene) return false

  if (!action.position) return true
  const view = scene.components.find(({ id }) => id === action.mapView)

  if (
    scene.type !== 'game' ||
    view?.type !== 'map-view' ||
    !view.playerSpawn ||
    view.interactive === false ||
    !mapPositionSchema.safeParse(action.position).success
  )
    return false

  const readInitialState = (path: readonly string[]) =>
    game.rules?.state.find((field) => JSON.stringify(field.path) === JSON.stringify(path))?.value

  const cost = movement
    ? movement.getTileCost(view.map, action.position)
    : getMapMovementCostMs(view.map, action.position, (object) =>
        isBlockingMapObject(resolveMapObject(object, readInitialState)),
      )

  return cost !== undefined
}
