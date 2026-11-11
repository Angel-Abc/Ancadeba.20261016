import { z } from 'zod'
import { assetIdSchema, colorSchema, type AssetCatalog, type ImageAsset } from './assets.js'
import { gameIdSchema } from './game.js'
import { storyPathSchema } from './storyConditions.js'

export const mapTilesetSchema = z.object({
  image: assetIdSchema,
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
  margin: z.number().int().nonnegative().optional(),
  spacing: z.number().int().nonnegative().optional(),
})

export const mapTerrainSchema = z
  .object({
    color: colorSchema.optional(),
    tile: z
      .object({
        tileset: assetIdSchema,
        column: z.number().int().nonnegative(),
        row: z.number().int().nonnegative(),
      })
      .optional(),
    walkable: z.boolean().optional(),
    movementCostMs: z.number().int().nonnegative().max(2_147_483_647).optional(),
  })
  .refine(
    (terrain) => terrain.color !== undefined || terrain.tile !== undefined,
    'Choose a color or image tile',
  )

export const mapLayerSchema = z.object({
  id: assetIdSchema,
  name: z.string().trim().min(1).max(100).optional(),
  visible: z.boolean().optional(),
  collision: z.boolean().optional(),
  tiles: z.array(z.array(gameIdSchema.nullable())),
})

export const mapEntryTriggerSchema = z.object({
  id: gameIdSchema,
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  action: gameIdSchema,
})

export type MapEntryTrigger = z.infer<typeof mapEntryTriggerSchema>

export const mapObjectStateSchema = z
  .object({
    id: gameIdSchema,
    when: z.object({ path: storyPathSchema, value: z.boolean() }),
    terrain: assetIdSchema.optional(),
    label: z.string().trim().min(1).max(100).optional(),
    blocking: z.boolean().optional(),
    visible: z.boolean().optional(),
  })
  .refine(
    (state) =>
      state.terrain !== undefined ||
      state.label !== undefined ||
      state.blocking !== undefined ||
      state.visible !== undefined,
    'Choose at least one object state override',
  )

export type MapObjectState = z.infer<typeof mapObjectStateSchema>

export type MapObjectStateReader = (path: readonly string[]) => unknown

export const mapObjectSchema = z.object({
  id: gameIdSchema,
  label: z.string().trim().min(1).max(100),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  terrain: assetIdSchema,
  action: gameIdSchema,
  blocking: z.boolean().optional(),
  visible: z.boolean().optional(),
  states: z.array(mapObjectStateSchema).optional(),
})

export type MapObject = z.infer<typeof mapObjectSchema>

/** Resolve authored overrides without mutating the base object or its captured action target. */
export function resolveMapObject(object: MapObject, read?: MapObjectStateReader): MapObject {
  const state = read && object.states?.find((state) => read(state.when.path) === state.when.value)

  return state
    ? {
        ...object,
        terrain: state.terrain ?? object.terrain,
        label: state.label ?? object.label,
        blocking: state.blocking ?? object.blocking,
        visible: state.visible ?? object.visible,
      }
    : object
}

/** Hidden objects are absent from collision as well as rendering and interaction. */
export function isBlockingMapObject(object: MapObject): boolean {
  return object.visible !== false && object.blocking !== false
}

export const mapDefinitionSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    type: z.literal('square-grid'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    tilesets: z.record(assetIdSchema, mapTilesetSchema).optional(),
    terrain: z.record(assetIdSchema, mapTerrainSchema),
    tiles: z.array(z.array(gameIdSchema)),
    layers: z.array(mapLayerSchema).max(32).optional(),
    entryTriggers: z.array(mapEntryTriggerSchema).optional(),
    objects: z.array(mapObjectSchema).optional(),
  })
  .superRefine((map, context) => {
    for (const [id, terrain] of Object.entries(map.terrain)) {
      if (terrain.tile && !Object.hasOwn(map.tilesets ?? {}, terrain.tile.tileset))
        context.addIssue({
          code: 'custom',
          path: ['terrain', id, 'tile', 'tileset'],
          message: `Unknown tileset: ${terrain.tile.tileset}`,
        })
    }

    const checkTiles = (tiles: (string | null)[][], path: (string | number)[]) => {
      if (tiles.length !== map.height)
        context.addIssue({
          code: 'custom',
          path,
          message: 'Row count must match map height',
        })

      tiles.forEach((row, y) => {
        if (row.length !== map.width)
          context.addIssue({
            code: 'custom',
            path: [...path, y],
            message: 'Tile count must match map width',
          })

        row.forEach((id, x) => {
          if (id !== null && !Object.hasOwn(map.terrain, id))
            context.addIssue({
              code: 'custom',
              path: [...path, y, x],
              message: `Unknown terrain: ${id}`,
            })
        })
      })
    }

    checkTiles(map.tiles, ['tiles'])
    const objectIds = new Set<string>()
    const objectTiles = new Set<string>()
    map.objects?.forEach((object, index) => {
      const path = ['objects', index]

      if (objectIds.has(object.id))
        context.addIssue({
          code: 'custom',
          path: [...path, 'id'],
          message: 'Map object IDs must be unique',
        })
      objectIds.add(object.id)
      const tile = `${object.x},${object.y}`

      if (objectTiles.has(tile))
        context.addIssue({ code: 'custom', path, message: 'Use one object per tile' })
      objectTiles.add(tile)

      if (object.x >= map.width || object.y >= map.height)
        context.addIssue({ code: 'custom', path, message: 'Object is outside the map' })

      if (!Object.hasOwn(map.terrain, object.terrain))
        context.addIssue({
          code: 'custom',
          path: [...path, 'terrain'],
          message: 'Unknown object appearance terrain',
        })
      const stateIds = new Set<string>()
      object.states?.forEach((state, stateIndex) => {
        const statePath = [...path, 'states', stateIndex]

        if (stateIds.has(state.id))
          context.addIssue({
            code: 'custom',
            path: [...statePath, 'id'],
            message: 'Object state IDs must be unique',
          })
        stateIds.add(state.id)

        if (state.terrain && !Object.hasOwn(map.terrain, state.terrain))
          context.addIssue({
            code: 'custom',
            path: [...statePath, 'terrain'],
            message: 'Unknown object state appearance terrain',
          })
      })
    })
    const triggerIds = new Set<string>()
    const triggerTiles = new Set<string>()
    map.entryTriggers?.forEach((trigger, index) => {
      if (triggerIds.has(trigger.id))
        context.addIssue({
          code: 'custom',
          path: ['entryTriggers', index, 'id'],
          message: 'Tile-entry trigger IDs must be unique',
        })
      triggerIds.add(trigger.id)
      const tile = `${trigger.x},${trigger.y}`

      if (triggerTiles.has(tile))
        context.addIssue({
          code: 'custom',
          path: ['entryTriggers', index],
          message: 'Use one entry trigger per tile',
        })
      triggerTiles.add(tile)

      if (trigger.x >= map.width || trigger.y >= map.height)
        context.addIssue({
          code: 'custom',
          path: ['entryTriggers', index],
          message: 'Tile-entry trigger is outside the map',
        })
    })
    const ids = new Set<string>()
    map.layers?.forEach((layer, index) => {
      if (ids.has(layer.id))
        context.addIssue({
          code: 'custom',
          path: ['layers', index, 'id'],
          message: 'Layer IDs must be unique',
        })
      ids.add(layer.id)
      checkTiles(layer.tiles, ['layers', index, 'tiles'])
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

export type MapTileset = z.infer<typeof mapTilesetSchema>

export type MapTerrain = z.infer<typeof mapTerrainSchema>

export type MapLayer = z.infer<typeof mapLayerSchema>

export interface MapTileRegion {
  image: ImageAsset
  x: number
  y: number
  width: number
  height: number
}

export function mapTilesetSize(tileset: MapTileset, image: ImageAsset) {
  const margin = tileset.margin ?? 0
  const spacing = tileset.spacing ?? 0

  return {
    columns: Math.max(
      0,
      Math.floor((image.bounds.width - 2 * margin + spacing) / (tileset.tileWidth + spacing)),
    ),
    rows: Math.max(
      0,
      Math.floor((image.bounds.height - 2 * margin + spacing) / (tileset.tileHeight + spacing)),
    ),
  }
}

export function mapTileRegion(
  map: MapDefinition,
  terrain: string,
  assets?: AssetCatalog,
): MapTileRegion | undefined {
  const tile = map.terrain[terrain]?.tile
  const tileset = tile && map.tilesets?.[tile.tileset]
  const image = tileset && assets?.images[tileset.image]

  if (!tile || !tileset || !image) return undefined

  if (
    !Number.isInteger(tileset.tileWidth) ||
    !Number.isInteger(tileset.tileHeight) ||
    tileset.tileWidth < 1 ||
    tileset.tileHeight < 1
  )
    return undefined
  const size = mapTilesetSize(tileset, image)

  if (
    !Number.isFinite(size.columns) ||
    !Number.isFinite(size.rows) ||
    tile.column < 0 ||
    tile.row < 0 ||
    tile.column >= size.columns ||
    tile.row >= size.rows
  )
    return undefined

  return {
    image,
    x:
      image.bounds.x +
      (tileset.margin ?? 0) +
      tile.column * (tileset.tileWidth + (tileset.spacing ?? 0)),
    y:
      image.bounds.y +
      (tileset.margin ?? 0) +
      tile.row * (tileset.tileHeight + (tileset.spacing ?? 0)),
    width: tileset.tileWidth,
    height: tileset.tileHeight,
  }
}

/** Validate map graphics even when no scene currently displays the map. */
export function mapVisualIssues(
  map: MapDefinition,
  assets?: AssetCatalog,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = []

  for (const [id, tileset] of Object.entries(map.tilesets ?? {})) {
    const image = assets?.images[tileset.image]

    if (!image)
      issues.push({
        path: ['tilesets', id, 'image'],
        message: `Unknown tileset image: ${tileset.image}`,
      })
    else {
      const size = mapTilesetSize(tileset, image)

      if (!size.columns || !size.rows)
        issues.push({
          path: ['tilesets', id],
          message: 'Tile dimensions and margins must fit the image',
        })
    }
  }

  for (const [id, terrain] of Object.entries(map.terrain)) {
    if (terrain.tile && !mapTileRegion(map, id, assets))
      issues.push({
        path: ['terrain', id, 'tile'],
        message: 'Image tile must be inside its tileset',
      })
  }

  return issues
}

export type MapViewport = z.infer<typeof mapViewportSchema>

export type MapPosition = z.infer<typeof mapPositionSchema>

/** Time to enter a tile, or undefined if the tile cannot be entered. */
export function getMapMovementCostMs(
  map: MapDefinition,
  position: MapPosition,
  isBlocking: (object: MapObject) => boolean = isBlockingMapObject,
): number | undefined {
  const id = map.tiles[position.y]?.[position.x]
  const terrain = id === undefined ? undefined : map.terrain[id]

  if (!terrain || terrain.walkable === false) return undefined

  if (
    map.objects?.some(
      (object) => object.x === position.x && object.y === position.y && isBlocking(object),
    )
  )
    return undefined
  let cost = terrain.movementCostMs ?? 0

  for (const layer of map.layers ?? []) {
    if (layer.visible === false || layer.collision === false) continue
    const overlay = layer.tiles[position.y]?.[position.x]

    if (overlay === null || overlay === undefined) continue
    const object = map.terrain[overlay]

    if (!object || object.walkable === false) return undefined
    cost = Math.max(cost, object.movementCostMs ?? 0)
  }

  return cost
}

export function isWalkableMapTile(map: MapDefinition, position: MapPosition): boolean {
  return getMapMovementCostMs(map, position) !== undefined
}

/** Resource validation permits entrances that can be unlocked later; runtime checks current state. */
export function getMapPotentialMovementCostMs(
  map: MapDefinition,
  position: MapPosition,
): number | undefined {
  return getMapMovementCostMs(
    map,
    position,
    (object) =>
      isBlockingMapObject(object) &&
      !object.states?.some((state) => state.blocking === false || state.visible === false),
  )
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

  if (playerSpawn && getMapPotentialMovementCostMs(map, playerSpawn) === undefined)
    throw new Error(`Player spawn is on blocked terrain in map: ${id}`)

  return map
}
