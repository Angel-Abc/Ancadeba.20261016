/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  assetCatalogSchema,
  mapDefinitionSchema,
  mapTileRegion,
  mapTilesetSize,
  mapVisualIssues,
} from '@ancadeba/schemas'
import { applyCommand, createStarterProject, inspectProject } from '@ancadeba/editor-core'
import { assembleGameData } from '@ancadeba/game-runtime'
import { applyMapTileAppearance, mapTileImages, type GraphicLease } from '@ancadeba/ui-components'

const assets = assetCatalogSchema.parse({
  'schema-version': '1.0.0',
  images: {
    sheet: {
      format: 'svg',
      source: 'assets/sheet.svg',
      bounds: { x: 10, y: 20, width: 38, height: 20 },
    },
  },
})

const map = mapDefinitionSchema.parse({
  'schema-version': '1.0.0',
  type: 'square-grid',
  width: 3,
  height: 1,
  tilesets: { nature: { image: 'sheet', tileWidth: 16, tileHeight: 16, margin: 2, spacing: 2 } },
  terrain: {
    color: { color: '#112233' },
    image: { tile: { tileset: 'nature', column: 0, row: 0 } },
    overlay: { color: '#22aa44', tile: { tileset: 'nature', column: 1, row: 0 }, walkable: false },
  },
  tiles: [['color', 'image', 'overlay']],
})

describe('map tilesets', () => {
  it('accepts legacy colors, image tiles and overlays, and computes crops including image origin, margins and spacing', () => {
    expect(mapVisualIssues(map, assets)).toEqual([])
    expect(mapTilesetSize(map.tilesets!.nature!, assets.images.sheet!)).toEqual({
      columns: 2,
      rows: 1,
    })
    expect(mapTileRegion(map, 'overlay', assets)).toMatchObject({
      x: 30,
      y: 22,
      width: 16,
      height: 16,
    })
    expect(mapTileRegion(map, 'color', assets)).toBeUndefined()
    const invalid = structuredClone(map)
    invalid.terrain.overlay!.tile!.column = 2
    expect(mapVisualIssues(invalid, assets)).toContainEqual({
      path: ['terrain', 'overlay', 'tile'],
      message: 'Image tile must be inside its tileset',
    })
    expect(mapVisualIssues(map)).toHaveLength(3)
    delete invalid.terrain.color!.color
    expect(mapDefinitionSchema.safeParse(invalid).success).toBe(false)
    invalid.terrain.color!.color = '#112233'
    invalid.terrain.image!.tile!.tileset = 'missing'
    expect(mapDefinitionSchema.safeParse(invalid).success).toBe(false)
  })

  it('validates even unused maps and prevents removing referenced assets or shrinking an image below its selected tile', () => {
    const documents = { ...createStarterProject({ path: 'game', title: 'Tiles', description: '' }) }
    documents['game.json'] = { ...documents['game.json']!, assets: 'catalog', maps: ['garden'] }
    documents['assets/catalog.json'] = assets
    documents['maps/garden.json'] = map
    const project = { revision: 'one', documents }
    expect(inspectProject(project).diagnostics).toEqual([])
    const imageOnly = structuredClone(map)
    delete imageOnly.terrain.overlay!.color

    const changed = applyCommand(project, {
      type: 'game.upsertMap',
      mapId: 'garden',
      map: imageOnly,
    })

    expect(inspectProject(changed.project).maps!.garden!.terrain.overlay!.color).toBeUndefined()
    const invalid = structuredClone(map)
    invalid.tilesets!.nature!.tileWidth = 100
    expect(() =>
      applyCommand(project, { type: 'game.upsertMap', mapId: 'garden', map: invalid }),
    ).toThrow('invalid project')
    expect(
      inspectProject({
        ...project,
        documents: { ...documents, 'assets/catalog.json': { ...assets, images: {} } },
      }).diagnostics.some((issue) => issue.file === 'maps/garden.json'),
    ).toBe(true)
    const view = inspectProject(project)
    expect(() =>
      assembleGameData(
        view.game!,
        new Map(view.scenes.map((scene) => [scene.id, scene])),
        undefined,
        undefined,
        new Map([['garden', map]]),
      ),
    ).toThrow('Unknown tileset image')
  })

  it('renders image-only tiles transparently and overlays images on the color with matching source rectangles', () => {
    const element = {
      style: {
        backgroundColor: '',
        backgroundImage: '',
        backgroundRepeat: '',
        backgroundPosition: '',
        backgroundSize: '',
      },
    }

    applyMapTileAppearance(element, map, 'overlay', assets, () => 'blob:sheet')
    expect(element.style).toMatchObject({
      backgroundColor: '#22aa44',
      backgroundImage: 'url("blob:sheet")',
      backgroundSize: '237.5% 125%',
      backgroundPosition: `${(100 * 20) / 22}% 50%`,
    })
    applyMapTileAppearance(element, map, 'image', assets, () => 'blob:sheet')
    expect(element.style.backgroundColor).toBe('transparent')
    applyMapTileAppearance(element, map, 'color', assets, () => 'blob:sheet')
    expect(element.style).toMatchObject({
      backgroundColor: '#112233',
      backgroundImage: 'none',
      backgroundPosition: '',
      backgroundSize: '',
    })
  })

  it('shares an image lease across tilesets and releases both active and late-loading images on disposal', async () => {
    const release = vi.fn()
    const graphics = { acquire: vi.fn(async () => ({ url: 'blob:sheet', release })) }
    const changed = vi.fn()
    const failed = vi.fn()

    const images = mapTileImages(
      { ...map, tilesets: { ...map.tilesets, duplicate: map.tilesets!.nature! } },
      assets,
      graphics,
      changed,
      failed,
    )

    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(graphics.acquire).toHaveBeenCalledOnce()
    expect(images.url(assets.images.sheet!)).toBe('blob:sheet')
    images.dispose()
    images.dispose()
    expect(release).toHaveBeenCalledOnce()
    let finish: (lease: GraphicLease) => void = () => {}

    const pending = mapTileImages(
      map,
      assets,
      {
        acquire: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      },
      changed,
      failed,
    )

    pending.dispose()
    finish({ url: 'blob:late', release })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(changed).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()

    const broken = mapTileImages(
      map,
      assets,
      {
        acquire: async () => {
          throw new Error('Cannot decode image')
        },
      },
      changed,
      failed,
    )

    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith('Cannot decode image'))
    broken.dispose()
  })
})
