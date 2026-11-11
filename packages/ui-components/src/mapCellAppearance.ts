import type { AssetCatalog, ImageAsset, MapDefinition } from '@ancadeba/schemas'
import { applyMapTileAppearance } from './mapTileAppearance.js'

/** A cell keeps the ground and each visible overlay separate, in map draw order. */
export function applyMapCellAppearance(
  element: HTMLElement,
  map: MapDefinition,
  x: number,
  y: number,
  assets: AssetCatalog | undefined,
  imageUrl: (image: ImageAsset) => string | undefined,
  showObjects = true,
) {
  const ground = map.tiles[y]?.[x]
  element.replaceChildren()
  applyMapTileAppearance(element, map, ground ?? '', assets, imageUrl)

  for (const layer of map.layers ?? []) {
    const terrain = layer.tiles[y]?.[x]

    if (layer.visible === false || terrain === null || terrain === undefined) continue
    const overlay = element.ownerDocument.createElement('span')
    overlay.className = 'ancadeba-map-layer-tile'
    overlay.dataset.mapLayer = layer.id
    overlay.setAttribute('aria-hidden', 'true')
    applyMapTileAppearance(overlay, map, terrain, assets, imageUrl)
    element.append(overlay)
  }

  if (showObjects)
    for (const object of map.objects ?? []) {
      if (object.x !== x || object.y !== y) continue
      const overlay = element.ownerDocument.createElement('span')
      overlay.className = 'ancadeba-map-layer-tile map-object-tile'
      overlay.dataset.mapObject = object.id
      overlay.setAttribute('aria-hidden', 'true')
      applyMapTileAppearance(overlay, map, object.terrain, assets, imageUrl)
      element.append(overlay)
    }
}
