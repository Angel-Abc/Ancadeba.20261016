import { z } from 'zod'
import { gameIdSchema } from './game.js'
import {
  getMapPotentialMovementCostMs,
  mapPositionSchema,
  type MapDefinition,
  type MapPosition,
} from './map.js'
import type { SceneDefinition } from './scene.js'

export const sceneTransitionSchema = z
  .strictObject({
    type: z.literal('enter-scene'),
    scene: gameIdSchema,
    mapView: gameIdSchema.optional(),
    position: mapPositionSchema.optional(),
  })
  .refine((action) => !action.position || action.mapView !== undefined, {
    path: ['mapView'],
    message: 'Choose a destination map view when setting tile coordinates',
  })

export type SceneTransition = z.infer<typeof sceneTransitionSchema>

export interface SceneEntrance {
  readonly mapView: string
  readonly position: Readonly<MapPosition>
}

/** Checks destination resources for rules, navigation buttons, and action-bar slots. */
export function sceneTransitionIssues(
  action: SceneTransition,
  scenes: ReadonlyMap<string, SceneDefinition>,
  maps: ReadonlyMap<string, MapDefinition>,
): { path: (string | number)[]; message: string }[] {
  if (action.mapView === undefined) return []
  const scene = scenes.get(action.scene)
  const view = scene?.components.find(({ id }) => id === action.mapView)
  const map = view?.type === 'map-view' && maps.get(view.map)

  if (
    scene?.type !== 'game' ||
    !map ||
    view?.type !== 'map-view' ||
    !view.playerSpawn ||
    (action.position && view.interactive === false)
  )
    return [
      {
        path: ['mapView'],
        message: 'Expected a destination map view with a player and interactive movement',
      },
    ]

  if (getMapPotentialMovementCostMs(map, action.position ?? view.playerSpawn) === undefined)
    return [
      {
        path: [action.position ? 'position' : 'mapView'],
        message: 'Destination tile must be inside the map and walkable',
      },
    ]

  return []
}
