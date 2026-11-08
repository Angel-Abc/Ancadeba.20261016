import {
  mapTileRegion,
  type AssetCatalog,
  type ImageAsset,
  type MapDefinition,
  type MapTileRegion,
} from '@ancadeba/schemas'
import type { GraphicLease, IGraphicResources } from './graphicResources.js'

interface TileSurface {
  readonly style: Pick<
    CSSStyleDeclaration,
    | 'backgroundColor'
    | 'backgroundImage'
    | 'backgroundRepeat'
    | 'backgroundSize'
    | 'backgroundPosition'
  >
}

/** Paints a source rectangle without stretching neighboring sprites into the tile. */
export function applyMapTileImage(
  element: TileSurface,
  region: MapTileRegion | undefined,
  url?: string,
) {
  element.style.backgroundImage = region && url ? `url(${JSON.stringify(url)})` : 'none'
  element.style.backgroundRepeat = 'no-repeat'

  if (!region || !url) {
    element.style.backgroundSize = ''
    element.style.backgroundPosition = ''

    return
  }

  const { image, width, height, x, y } = region

  const position = (start: number, origin: number, extent: number, tile: number) =>
    extent === tile ? 0 : (100 * (start - origin)) / (extent - tile)

  element.style.backgroundSize = `${(100 * image.bounds.width) / width}% ${(100 * image.bounds.height) / height}%`
  element.style.backgroundPosition = `${position(x, image.bounds.x, image.bounds.width, width)}% ${position(y, image.bounds.y, image.bounds.height, height)}%`
}

export function applyMapTileAppearance(
  element: TileSurface,
  map: MapDefinition,
  terrain: string,
  assets: AssetCatalog | undefined,
  imageUrl: (image: ImageAsset) => string | undefined,
) {
  element.style.backgroundColor = map.terrain[terrain]?.color ?? 'transparent'
  const region = mapTileRegion(map, terrain, assets)
  applyMapTileImage(element, region, region && imageUrl(region.image))
}

/** One lease per image, shared by all rendered cells and released with the map view. */
export function mapTileImages(
  map: MapDefinition,
  assets: AssetCatalog | undefined,
  graphics: IGraphicResources | undefined,
  changed: () => void,
  failed: (message: string) => void,
) {
  const urls = new Map<ImageAsset, string>()
  const leases: GraphicLease[] = []
  let active = true
  const images = new Map<string, ImageAsset>()

  for (const tileset of Object.values(map.tilesets ?? {})) {
    const image = assets?.images[tileset.image]

    if (image) images.set(tileset.image, image)
  }

  for (const [imageId, image] of images) {
    if (!graphics) {
      failed('The game host has no graphics resource service')
      break
    }

    void graphics
      .acquire({ imageId, image, colors: image.colors, layer: 'map', transform: '' })
      .then((lease) => {
        if (!active) {
          lease.release()

          return
        }

        leases.push(lease)
        urls.set(image, lease.url)
        changed()
      })
      .catch((error: unknown) => {
        if (active) failed(error instanceof Error ? error.message : String(error))
      })
  }

  return {
    url: (image: ImageAsset) => urls.get(image),
    dispose() {
      if (!active) return
      active = false

      for (const lease of leases) lease.release()
      leases.length = 0
      urls.clear()
    },
  }
}
