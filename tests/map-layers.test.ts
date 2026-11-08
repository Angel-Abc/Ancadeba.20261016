import { describe, expect, it } from 'vite-plus/test'
import { getMapMovementCostMs, mapDefinitionSchema, resolveMapView } from '@ancadeba/schemas'
import { MapDraft } from '../apps/editor-ui/src/mapDraft.js'

function layeredMap() {
  return mapDefinitionSchema.parse({
    'schema-version': '1.0.0',
    type: 'square-grid',
    width: 2,
    height: 2,
    terrain: {
      grass: { color: '#608c4f', movementCostMs: 100 },
      tree: { color: '#204020', walkable: false },
      mud: { color: '#806040', movementCostMs: 350 },
    },
    tiles: [
      ['grass', 'grass'],
      ['grass', 'grass'],
    ],
    layers: [
      {
        id: 'objects',
        name: 'Trees',
        tiles: [
          [null, 'tree'],
          [null, null],
        ],
      },
      {
        id: 'details',
        tiles: [
          [null, null],
          ['mud', null],
        ],
      },
    ],
  })
}

describe('map layers', () => {
  it('accepts legacy ground maps and validates layer dimensions, empty cells, IDs, and terrain references', () => {
    const map = layeredMap()
    const legacy = { ...map, layers: undefined }
    expect(mapDefinitionSchema.parse(legacy).layers).toBeUndefined()
    const invalid = structuredClone(map)
    invalid.layers!.push({ ...invalid.layers![0]! })
    expect(mapDefinitionSchema.safeParse(invalid).success).toBe(false)
    invalid.layers!.pop()
    invalid.layers![0]!.tiles[0]![0] = 'missing'
    expect(mapDefinitionSchema.safeParse(invalid).success).toBe(false)
    invalid.layers![0]!.tiles[0] = [null]
    expect(mapDefinitionSchema.safeParse(invalid).success).toBe(false)
    invalid.layers![0]!.tiles = []
    expect(mapDefinitionSchema.safeParse(invalid).success).toBe(false)
    expect(
      mapDefinitionSchema.safeParse({
        ...map,
        tiles: [
          [null, 'grass'],
          ['grass', 'grass'],
        ],
      }).success,
    ).toBe(false)
  })

  it('uses visible collidable layers for blocking and the longest movement delay, without overriding blocked ground', () => {
    const map = layeredMap()
    expect(getMapMovementCostMs(map, { x: 0, y: 0 })).toBe(100)
    expect(getMapMovementCostMs(map, { x: 1, y: 0 })).toBeUndefined()
    expect(getMapMovementCostMs(map, { x: 0, y: 1 })).toBe(350)
    expect(() =>
      resolveMapView(
        new Map([['garden', map]]),
        'garden',
        { columns: 2, rows: 2, x: 0, y: 0 },
        { x: 1, y: 0 },
      ),
    ).toThrow('blocked terrain')
    map.layers![0]!.collision = false
    expect(getMapMovementCostMs(map, { x: 1, y: 0 })).toBe(100)
    map.layers![0]!.collision = true
    map.layers![0]!.visible = false
    expect(getMapMovementCostMs(map, { x: 1, y: 0 })).toBe(100)
    map.layers![1]!.collision = false
    expect(getMapMovementCostMs(map, { x: 0, y: 1 })).toBe(100)
    map.tiles[0]![1] = 'tree'
    expect(getMapMovementCostMs(map, { x: 1, y: 0 })).toBeUndefined()
    expect(getMapMovementCostMs(map, { x: 4, y: 4 })).toBeUndefined()
  })

  it('paints, erases, fills, reorders and removes layers independently while resizing all grids', () => {
    const original = layeredMap()
    const draft = new MapDraft(original)
    draft.addLayer('roof')
    draft.paint(0, 0, 'tree', 'roof')
    expect(draft.tile(0, 0)).toBe('grass')
    expect(draft.tile(0, 0, 'roof')).toBe('tree')
    expect(original.layers).toHaveLength(2)
    expect(draft.paint(0, 0, null)).toBe(false)
    expect(draft.paint(0, 0, null, 'roof')).toBe(true)
    draft.fill('mud', 'roof')
    draft.moveLayer('roof', -1)
    expect(draft.data.layers!.map((layer) => layer.id)).toEqual(['objects', 'roof', 'details'])
    draft.resize(3, 3, 'grass')
    expect(draft.tile(2, 2)).toBe('grass')
    expect(draft.tile(2, 2, 'roof')).toBeNull()
    expect(draft.tile(1, 1, 'roof')).toBe('mud')
    draft.resize(1, 1, 'grass')
    expect(
      draft.data.layers!.every((layer) => layer.tiles.length === 1 && layer.tiles[0]!.length === 1),
    ).toBe(true)
    draft.removeLayer('roof')
    expect(draft.data.layers!.map((layer) => layer.id)).toEqual(['objects', 'details'])
    expect(() => draft.paint(0, 0, 'tree', 'missing')).toThrow('invalidLayer')
    expect(() => draft.addLayer('objects')).toThrow('layerExists')
    expect(() => draft.removeLayer('')).toThrow('invalidLayer')
  })

  it('replaces terrain used only in overlay layers, including hidden layers', () => {
    const draft = new MapDraft(layeredMap())
    draft.data.layers![0]!.visible = false
    expect(() => draft.removeTerrain('tree')).toThrow('replacementRequired')
    draft.removeTerrain('tree', 'grass')
    expect(draft.tile(1, 0, 'objects')).toBe('grass')
    expect(draft.tile(0, 0, 'objects')).toBeNull()
    expect(mapDefinitionSchema.safeParse(draft.data).success).toBe(true)
  })
})
