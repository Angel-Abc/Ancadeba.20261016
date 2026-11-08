import { assetIdSchema, type MapDefinition } from '@ancadeba/schemas'

export type MapDraftIssue =
  | 'invalidSize'
  | 'invalidTerrain'
  | 'terrainExists'
  | 'lastTerrain'
  | 'replacementRequired'
  | 'invalidLayer'
  | 'layerExists'
  | 'layerLimit'
  | 'invalidSelection'
  | 'pasteOutsideMap'
  | 'clipboardTerrainMissing'
  | 'cutSourceChanged'
  | 'invalidGroundFill'

export interface TilePoint {
  x: number
  y: number
}

export interface TileRectangle extends TilePoint {
  width: number
  height: number
}

export interface TileMoveSource {
  layer: string
  rectangle: TileRectangle
  fill: string | null
}

export class MapDraftError extends Error {
  constructor(readonly code: MapDraftIssue) {
    super(code)
  }
}

const maxTiles = 65_536

/** Owns a detached map draft, keeping painting and resizing independent of the DOM. */
export class MapDraft {
  readonly data: MapDefinition

  constructor(map?: MapDefinition) {
    this.data = map
      ? structuredClone(map)
      : {
          'schema-version': '1.0.0',
          type: 'square-grid',
          width: 16,
          height: 12,
          terrain: { ground: { color: '#608c4f' }, wall: { color: '#4f5969', walkable: false } },
          tiles: Array.from({ length: 12 }, () => Array<string>(16).fill('ground')),
        }
  }

  resize(width: number, height: number, fill: string): void {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > maxTiles
    )
      throw new MapDraftError('invalidSize')

    if (!Object.hasOwn(this.data.terrain, fill)) throw new MapDraftError('invalidTerrain')
    this.data.tiles = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => this.data.tiles[y]?.[x] ?? fill),
    )

    for (const layer of this.data.layers ?? [])
      layer.tiles = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x) => layer.tiles[y]?.[x] ?? null),
      )
    this.data.width = width
    this.data.height = height
  }

  tile(x: number, y: number, layer = '') {
    return this.rows(layer)[y]?.[x]
  }

  private rows(layer: string): (string | null)[][] {
    if (!layer) return this.data.tiles
    const selected = this.data.layers?.find((value) => value.id === layer)

    if (!selected) throw new MapDraftError('invalidLayer')

    return selected.tiles
  }

  private validRectangle(rectangle: TileRectangle): boolean {
    return (
      [rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isSafeInteger) &&
      rectangle.x >= 0 &&
      rectangle.y >= 0 &&
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      rectangle.x + rectangle.width <= this.data.width &&
      rectangle.y + rectangle.height <= this.data.height
    )
  }

  copyRegion(rectangle: TileRectangle, layer = ''): (string | null)[][] {
    if (!this.validRectangle(rectangle)) throw new MapDraftError('invalidSelection')
    const rows = this.rows(layer)

    return rows
      .slice(rectangle.y, rectangle.y + rectangle.height)
      .map((row) => row.slice(rectangle.x, rectangle.x + rectangle.width))
  }

  /** Validates the entire transfer before writing; destination writes win when a move overlaps. */
  pasteRegion(
    tiles: readonly (readonly (string | null)[])[],
    point: TilePoint,
    layer = '',
    skipEmpty = true,
    source?: TileMoveSource,
  ): boolean {
    const height = tiles.length
    const width = tiles[0]?.length ?? 0

    if (!height || !width || tiles.some((row) => row.length !== width))
      throw new MapDraftError('invalidSelection')

    if (!this.validRectangle({ ...point, width, height }))
      throw new MapDraftError('pasteOutsideMap')
    const destination = this.rows(layer)

    const writes = new Map<
      string,
      { rows: (string | null)[][]; x: number; y: number; value: string | null }
    >()

    const write = (
      rows: (string | null)[][],
      owner: string,
      x: number,
      y: number,
      value: string | null,
    ) => writes.set(`${owner}:${x},${y}`, { rows, x, y, value })

    for (const row of tiles)
      for (const value of row)
        if (value !== null && !Object.hasOwn(this.data.terrain, value))
          throw new MapDraftError('clipboardTerrainMissing')

    if (source) {
      const current = this.copyRegion(source.rectangle, source.layer)

      if (
        current.length !== height ||
        current.some(
          (row, y) => row.length !== width || row.some((value, x) => value !== tiles[y]![x]),
        )
      )
        throw new MapDraftError('cutSourceChanged')

      if (source.fill === null ? !source.layer : !Object.hasOwn(this.data.terrain, source.fill))
        throw new MapDraftError('invalidGroundFill')
      const origin = this.rows(source.layer)

      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          write(origin, source.layer, source.rectangle.x + x, source.rectangle.y + y, source.fill)
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = tiles[y]![x] ?? null

        if (value === null && skipEmpty) continue

        if (value === null && !layer) throw new MapDraftError('invalidGroundFill')
        write(destination, layer, point.x + x, point.y + y, value)
      }
    }

    let changed = false

    for (const { rows, x, y, value } of writes.values()) {
      if (rows[y]![x] === value) continue
      rows[y]![x] = value
      changed = true
    }

    return changed
  }

  addLayer(id: string): void {
    if (!assetIdSchema.safeParse(id).success) throw new MapDraftError('invalidLayer')

    if (this.data.layers?.some((layer) => layer.id === id)) throw new MapDraftError('layerExists')

    if ((this.data.layers?.length ?? 0) >= 32) throw new MapDraftError('layerLimit')
    this.data.layers ??= []
    this.data.layers.push({
      id,
      name: id,
      tiles: Array.from({ length: this.data.height }, () =>
        Array<string | null>(this.data.width).fill(null),
      ),
    })
  }

  removeLayer(id: string): void {
    this.rows(id)

    if (!id) throw new MapDraftError('invalidLayer')
    this.data.layers = this.data.layers?.filter((layer) => layer.id !== id)
  }

  moveLayer(id: string, direction: -1 | 1): void {
    const layers = this.data.layers ?? []
    const index = layers.findIndex((layer) => layer.id === id)

    if (index < 0) throw new MapDraftError('invalidLayer')
    const destination = index + direction

    if (destination < 0 || destination >= layers.length) return
    const [layer] = layers.splice(index, 1)
    layers.splice(destination, 0, layer!)
  }

  paint(x: number, y: number, terrain: string | null, layer = ''): boolean {
    const row = this.rows(layer)[y]

    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !row ||
      x < 0 ||
      x >= this.data.width ||
      (terrain === null ? !layer : !Object.hasOwn(this.data.terrain, terrain)) ||
      row[x] === terrain
    )
      return false
    row[x] = terrain

    return true
  }

  fill(terrain: string | null, layer = ''): void {
    if (terrain === null ? !layer : !Object.hasOwn(this.data.terrain, terrain))
      throw new MapDraftError('invalidTerrain')

    for (const row of this.rows(layer)) row.fill(terrain)
  }

  addTerrain(id: string): void {
    if (!assetIdSchema.safeParse(id).success) throw new MapDraftError('invalidTerrain')

    if (Object.hasOwn(this.data.terrain, id)) throw new MapDraftError('terrainExists')
    this.data.terrain[id] = { color: '#608c4f' }
  }

  removeTerrain(id: string, replacement?: string): void {
    if (!Object.hasOwn(this.data.terrain, id)) throw new MapDraftError('invalidTerrain')

    if (Object.keys(this.data.terrain).length === 1) throw new MapDraftError('lastTerrain')
    const grids = [this.data.tiles, ...(this.data.layers ?? []).map((layer) => layer.tiles)]
    const used = grids.some((tiles) => tiles.some((row) => row.includes(id)))

    if (
      used &&
      (!replacement || replacement === id || !Object.hasOwn(this.data.terrain, replacement))
    )
      throw new MapDraftError('replacementRequired')

    if (used)
      for (const tiles of grids)
        for (const row of tiles)
          for (let x = 0; x < row.length; x++) if (row[x] === id) row[x] = replacement!
    delete this.data.terrain[id]
  }
}
