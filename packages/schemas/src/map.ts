import { z } from 'zod'
import { assetIdSchema, colorSchema } from './assets.js'
import { gameIdSchema } from './game.js'

export const mapDefinitionSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    type: z.literal('square-grid'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    terrain: z.record(
      assetIdSchema,
      z.object({
        color: colorSchema,
        walkable: z.boolean().optional(),
        movementCostMs: z.number().int().nonnegative().max(2_147_483_647).optional(),
      }),
    ),
    tiles: z.array(z.array(gameIdSchema)),
  })
  .superRefine((map, context) => {
    if (map.tiles.length !== map.height)
      context.addIssue({
        code: 'custom',
        path: ['tiles'],
        message: 'Row count must match map height',
      })

    map.tiles.forEach((row, y) => {
      if (row.length !== map.width)
        context.addIssue({
          code: 'custom',
          path: ['tiles', y],
          message: 'Tile count must match map width',
        })

      row.forEach((id, x) => {
        if (!Object.hasOwn(map.terrain, id))
          context.addIssue({
            code: 'custom',
            path: ['tiles', y, x],
            message: `Unknown terrain: ${id}`,
          })
      })
    })
  })

export const mapViewportSchema = z.object({
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  x: z.number().int().nonnegative().default(0),
  y: z.number().int().nonnegative().default(0),
})

export const mapPositionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
})

export type MapDefinition = z.infer<typeof mapDefinitionSchema>

export type MapViewport = z.infer<typeof mapViewportSchema>

export type MapPosition = z.infer<typeof mapPositionSchema>

/** Time to enter a tile, or undefined if the tile cannot be entered. */
export function getMapMovementCostMs(
  map: MapDefinition,
  position: MapPosition,
): number | undefined {
  const id = map.tiles[position.y]?.[position.x]
  const terrain = id === undefined ? undefined : map.terrain[id]

  if (!terrain || terrain.walkable === false) return undefined

  return terrain.movementCostMs ?? 0
}

export function isWalkableMapTile(map: MapDefinition, position: MapPosition): boolean {
  return getMapMovementCostMs(map, position) !== undefined
}

export function resolveMapView(
  maps: ReadonlyMap<string, MapDefinition>,
  id: string,
  viewport: MapViewport,
  playerSpawn?: MapPosition,
): MapDefinition {
  const map = maps.get(id)

  if (!map) throw new Error(`Map view references missing map: ${id}`)

  if (viewport.columns > map.width || viewport.rows > map.height)
    throw new Error(`Viewport exceeds the dimensions of map: ${id}`)

  if (playerSpawn && (playerSpawn.x >= map.width || playerSpawn.y >= map.height))
    throw new Error(`Player spawn is outside map: ${id}`)

  if (playerSpawn && !isWalkableMapTile(map, playerSpawn))
    throw new Error(`Player spawn is on blocked terrain in map: ${id}`)

  return map
}
