import {
  mapTileRegion,
  type AssetCatalog,
  type ImageAsset,
  type MapDefinition,
} from '@ancadeba/schemas'
import type { Translate } from '@ancadeba/utilities'
import type { TilePoint } from './mapDraft.js'
import type { MapViewport } from './mapViewport.js'

const frameWidth = 256
const frameHeight = 160

/** A bounded raster overview; the main grid and minimap share the same draft and camera. */
export function mapMinimap(
  document: Document,
  map: MapDefinition,
  camera: MapViewport,
  t: Translate,
  options: {
    navigate(point: TilePoint): void
    pan(x: number, y: number): void
    focusGrid(): void
    assets?: AssetCatalog | undefined
    imageUrl(image: ImageAsset): string | undefined
    spawns: ReadonlySet<string>
  },
) {
  const element = document.createElement('details')
  element.className = 'map-minimap'
  // A map that fits the view needs no overview, so it starts folded.
  element.open = camera.columns < map.width || camera.rows < map.height
  const summary = document.createElement('summary')
  summary.textContent = t('maps.minimap')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'map-minimap-navigate'
  button.setAttribute('aria-label', t('maps.minimapNavigate'))
  button.title = t('maps.minimapHelp')
  const canvas = document.createElement('canvas')
  canvas.width = frameWidth
  canvas.height = frameHeight
  canvas.setAttribute('aria-hidden', 'true')
  const outline = document.createElement('span')
  outline.className = 'map-minimap-viewport'
  outline.setAttribute('aria-hidden', 'true')
  button.append(canvas, outline)
  const help = document.createElement('p')
  help.className = 'help'
  help.textContent = t('maps.minimapHelp')
  element.append(summary, button, help)
  const context = canvas.getContext('2d')
  const abort = new AbortController()
  const palette = new Map<string, HTMLCanvasElement>()
  const images = new Map<string, { image: HTMLImageElement; ready: boolean }>()
  const scale = Math.min(frameWidth / map.width, frameHeight / map.height)
  const width = Math.max(1, map.width * scale)
  const height = Math.max(1, map.height * scale)
  const left = (frameWidth - width) / 2
  const top = (frameHeight - height) / 2

  const glyph = (id: string) => {
    const cached = palette.get(id)

    if (cached) return cached
    const tile = document.createElement('canvas')
    tile.width = 16
    tile.height = 16
    const brush = tile.getContext('2d')

    if (brush) {
      brush.imageSmoothingEnabled = false
      brush.fillStyle = 'transparent'
      brush.fillStyle = map.terrain[id]?.color ?? 'transparent'
      brush.fillRect(0, 0, 16, 16)
      const region = mapTileRegion(map, id, options.assets)
      const url = region && options.imageUrl(region.image)

      if (url && region) {
        let source = images.get(url)

        if (!source) {
          source = { image: document.createElement('img'), ready: false }
          images.set(url, source)
          const loading = source
          loading.image.addEventListener(
            'load',
            () => {
              loading.ready = true
              refresh()
            },
            { once: true, signal: abort.signal },
          )
          loading.image.src = url
        }

        if (source.ready)
          brush.drawImage(
            source.image,
            region.x,
            region.y,
            region.width,
            region.height,
            0,
            0,
            16,
            16,
          )
      }
    }

    palette.set(id, tile)

    // Bound thumbnail memory even on maps with a different terrain definition in every cell.
    if (palette.size > 256) palette.delete(palette.keys().next().value!)

    return tile
  }

  const paintCell = (x: number, y: number) => {
    if (!context) return
    const tileWidth = width / map.width
    const tileHeight = height / map.height
    const dx = left + x * tileWidth
    const dy = top + y * tileHeight
    context.clearRect(dx, dy, tileWidth, tileHeight)
    const ground = map.tiles[y]?.[x]

    if (ground) context.drawImage(glyph(ground), dx, dy, tileWidth, tileHeight)

    for (const layer of map.layers ?? []) {
      if (layer.visible === false) continue
      const terrain = layer.tiles[y]?.[x]

      if (terrain) context.drawImage(glyph(terrain), dx, dy, tileWidth, tileHeight)
    }

    if (options.spawns.has(`${x},${y}`)) {
      context.fillStyle = '#fff'
      context.fillRect(dx, dy, Math.max(2, tileWidth), Math.max(2, tileHeight))
    }
  }

  const refreshView = () => {
    outline.style.setProperty(
      'left',
      `${(100 * (left + (camera.x * width) / map.width)) / frameWidth}%`,
    )
    outline.style.setProperty(
      'top',
      `${(100 * (top + (camera.y * height) / map.height)) / frameHeight}%`,
    )
    outline.style.setProperty(
      'width',
      `${(100 * camera.columns * width) / map.width / frameWidth}%`,
    )
    outline.style.setProperty(
      'height',
      `${(100 * camera.rows * height) / map.height / frameHeight}%`,
    )
    button.setAttribute(
      'aria-description',
      t('maps.range', {
        x: camera.x,
        endX: camera.x + camera.columns - 1,
        y: camera.y,
        endY: camera.y + camera.rows - 1,
      }),
    )
  }

  const refresh = () => {
    if (abort.signal.aborted) return
    palette.clear()

    if (context) {
      context.imageSmoothingEnabled = false
      context.clearRect(0, 0, frameWidth, frameHeight)

      for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) paintCell(x, y)
    }

    refreshView()
  }

  button.addEventListener(
    'click',
    (event) => {
      if (event.detail === 0) {
        options.focusGrid()

        return
      }

      const bounds = canvas.getBoundingClientRect()

      if (!bounds.width || !bounds.height) return
      const x = (((event.clientX - bounds.left) * frameWidth) / bounds.width - left) / width
      const y = (((event.clientY - bounds.top) * frameHeight) / bounds.height - top) / height
      options.navigate({
        x: Math.max(0, Math.min(map.width - 1, Math.floor(x * map.width))),
        y: Math.max(0, Math.min(map.height - 1, Math.floor(y * map.height))),
      })
    },
    { signal: abort.signal },
  )
  button.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      const x = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      const y = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0

      if (x || y) {
        event.preventDefault()
        event.stopPropagation()
        options.pan(
          x * (event.shiftKey ? camera.columns : 1),
          y * (event.shiftKey ? camera.rows : 1),
        )
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        event.stopPropagation()
        options.navigate(
          event.key === 'Home' ? { x: 0, y: 0 } : { x: map.width - 1, y: map.height - 1 },
        )
      }
    },
    { signal: abort.signal },
  )
  refresh()

  return {
    element,
    refresh,
    refreshView,
    paintCell,
    dispose: () => {
      abort.abort()
      images.clear()
      palette.clear()
    },
  }
}
