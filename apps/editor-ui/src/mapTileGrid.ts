import type { Translate } from '@ancadeba/utilities'
import { applyMapCellAppearance } from '@ancadeba/ui-components'
import { getMapMovementCostMs, type AssetCatalog, type ImageAsset } from '@ancadeba/schemas'
import type { MapDraft, TilePoint } from './mapDraft.js'
import type { MapTileTool } from './mapTileSelection.js'
import { MapViewport, mapGridViewport } from './mapViewport.js'
import { mapViewportControls } from './mapViewportControls.js'
import { mapMinimap } from './mapMinimap.js'

export { mapGridViewport } from './mapViewport.js'

export interface MapGridSelectionInteraction {
  tool(): MapTileTool
  start(point: TilePoint, extend: boolean): void
  drag(point: TilePoint): void
  hover(point: TilePoint | undefined): boolean
  activate(point: TilePoint, extend: boolean): void
  move(from: TilePoint, to: TilePoint, extend: boolean): void
  keydown(event: KeyboardEvent, point: TilePoint): boolean
  decorate(element: HTMLElement, point: TilePoint): void
}

/** A bounded window onto the map, with pointer painting and roving keyboard focus. */
export function mapTileGrid(
  document: Document,
  draft: MapDraft,
  brush: () => string,
  changed: () => void,
  disabled: () => boolean,
  t: Translate,
  spawns: ReadonlySet<string>,
  assets?: AssetCatalog,
  imageUrl: (image: ImageAsset) => string | undefined = () => undefined,
  layer: () => string = () => '',
  erasing: () => boolean = () => false,
  viewport?: ReturnType<typeof mapGridViewport>,
  selection?: MapGridSelectionInteraction,
  history?: { begin(): void; end(): void },
) {
  const element = document.createElement('section')
  element.className = 'map-painter'
  const surface = document.createElement('div')
  surface.className = 'map-canvas'
  const grid = document.createElement('div')
  grid.className = 'map-tile-grid'
  grid.setAttribute('role', 'grid')
  grid.setAttribute('aria-label', t('maps.tiles'))
  grid.setAttribute('aria-rowcount', String(draft.data.height))
  grid.setAttribute('aria-colcount', String(draft.data.width))
  const cells = new Map<string, HTMLButtonElement>()
  const abort = new AbortController()
  const camera = new MapViewport(draft.data.width, draft.data.height, viewport)
  let panning = viewport?.panning ?? false

  let focused = {
    x: Math.max(camera.x, Math.min(camera.x + camera.columns - 1, viewport?.focusX ?? camera.x)),
    y: Math.max(camera.y, Math.min(camera.y + camera.rows - 1, viewport?.focusY ?? camera.y)),
  }

  let painting = false
  let editing = false

  let drag:
    | {
        pointerId: number
        button: number
        startX: number
        startY: number
        x: number
        y: number
        cellWidth: number
        cellHeight: number
      }
    | undefined

  const key = (x: number, y: number) => `${x},${y}`

  const updateCell = (button: HTMLButtonElement) => {
    const x = Number(button.dataset.mapX)
    const y = Number(button.dataset.mapY)
    const terrain = draft.tile(x, y, layer()) ?? t('maps.emptyTile')
    applyMapCellAppearance(button, draft.data, x, y, assets, imageUrl)
    button.classList.toggle(
      'map-tile-blocked',
      getMapMovementCostMs(draft.data, { x, y }) === undefined,
    )

    if (spawns.has(key(x, y))) {
      const marker = document.createElement('span')
      marker.className = 'map-spawn-marker'
      marker.textContent = '●'
      button.append(marker)
    }

    const label = t('maps.tile', { x: x + 1, y: y + 1, terrain })
    button.setAttribute('aria-label', label)
    button.title = label
    selection?.decorate(button, { x, y })
  }

  const paint = (button: HTMLButtonElement) => {
    if (disabled() || panning || drag) return

    if (
      draft.paint(
        Number(button.dataset.mapX),
        Number(button.dataset.mapY),
        erasing() ? null : brush(),
        layer(),
      )
    ) {
      updateCell(button)
      minimap.paintCell(Number(button.dataset.mapX), Number(button.dataset.mapY))
      changed()
    }
  }

  const point = (button: HTMLButtonElement) => ({
    x: Number(button.dataset.mapX),
    y: Number(button.dataset.mapY),
  })

  const activate = (button: HTMLButtonElement, extend: boolean) => {
    if (disabled() || panning || drag) return

    if (selection && selection.tool() !== 'paint') selection.activate(point(button), extend)
    else paint(button)
  }

  const stroke = (button: HTMLButtonElement) => {
    if (disabled() || panning || drag) return

    if (selection?.tool() === 'select') {
      button.focus()
      selection.drag(point(button))
    } else if (selection?.tool() !== 'paste') paint(button)
  }

  const clampFocus = () => {
    focused = {
      x: Math.max(camera.x, Math.min(camera.x + camera.columns - 1, focused.x)),
      y: Math.max(camera.y, Math.min(camera.y + camera.rows - 1, focused.y)),
    }
  }

  const changeView = (operation: () => void) => {
    stop()
    operation()
    clampFocus()
    selection?.hover(undefined)
    render()
  }

  const controls = mapViewportControls(document, camera, t, {
    change: changeView,
    panning: () => panning,
    setPanning: (value) => {
      panning = value
    },
    focusGrid: () => cells.get(key(focused.x, focused.y))?.focus(),
  })

  const minimap = mapMinimap(document, draft.data, camera, t, {
    navigate: (point) =>
      changeView(() => {
        camera.centerOn(point.x, point.y)
        focused = { ...point }
      }),
    pan: (x, y) => changeView(() => camera.pan(x, y)),
    focusGrid: () => cells.get(key(focused.x, focused.y))?.focus(),
    assets,
    imageUrl,
    spawns,
  })

  const navigation = document.createElement('div')
  navigation.className = 'map-navigation'
  navigation.append(controls.element, minimap.element)

  const render = () => {
    const columns = camera.columns
    const rows = camera.rows
    cells.clear()
    controls.refresh()
    minimap.refreshView()
    grid.replaceChildren()
    grid.style.setProperty('--map-editor-columns', String(columns))
    grid.style.setProperty('--map-editor-tile-size', `${(1.75 * camera.zoom) / 100}rem`)
    surface.classList.toggle('map-pan-mode', panning)

    for (let y = camera.y; y < camera.y + rows; y++) {
      const row = document.createElement('div')
      row.className = 'map-tile-row'
      row.setAttribute('role', 'row')
      row.setAttribute('aria-rowindex', String(y + 1))

      for (let x = camera.x; x < camera.x + columns; x++) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'map-tile'
        button.dataset.mapX = String(x)
        button.dataset.mapY = String(y)
        button.setAttribute('role', 'gridcell')
        button.setAttribute('aria-colindex', String(x + 1))
        button.tabIndex = focused.x === x && focused.y === y ? 0 : -1
        updateCell(button)
        cells.set(key(x, y), button)
        button.addEventListener('focus', () => {
          cells.get(key(focused.x, focused.y))?.setAttribute('tabindex', '-1')
          focused = { x, y }
          button.tabIndex = 0

          if (!panning && !drag && selection?.hover({ x, y }))
            for (const cell of cells.values()) updateCell(cell)
        })
        button.addEventListener('click', (event) => {
          if (event.detail > 0) return
          activate(button, event.shiftKey)
        })
        button.addEventListener('pointerdown', (event) => {
          if (event.button !== 0 || disabled() || panning || drag) return
          event.preventDefault()
          button.focus()
          painting = selection?.tool() !== 'paste'

          if (!selection || selection.tool() === 'paint') {
            editing = true
            history?.begin()
          }

          if (selection?.tool() === 'select') selection.start({ x, y }, event.shiftKey)
          else activate(button, event.shiftKey)

          if (painting) element.setPointerCapture?.(event.pointerId)
        })
        button.addEventListener('pointerenter', (event) => {
          if (painting && (event.buttons & 1) !== 0) stroke(button)
        })
        button.addEventListener('keydown', (event) => {
          if (event.defaultPrevented || event.isComposing) return

          if (panning && event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            changeView(() => {
              panning = false
            })
            cells.get(key(focused.x, focused.y))?.focus()

            return
          }

          if (
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            ['+', '=', '-', '0'].includes(event.key)
          ) {
            event.preventDefault()
            event.stopPropagation()
            changeView(() =>
              event.key === '0' ? camera.zoomTo(100) : camera.zoomBy(event.key === '-' ? -1 : 1),
            )
            cells.get(key(focused.x, focused.y))?.focus()

            return
          }

          if (!panning && selection?.keydown(event, { x, y })) {
            if (selection.tool() !== 'paint') stop()

            return
          }

          if (event.altKey || event.ctrlKey || event.metaKey) return

          if (panning && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()

            return
          }

          if (
            selection &&
            selection.tool() !== 'paint' &&
            (event.key === 'Enter' || event.key === ' ')
          ) {
            event.preventDefault()
            activate(button, event.shiftKey)

            return
          }

          const delta = new Map<string, readonly [number, number]>([
            ['ArrowLeft', [-1, 0]],
            ['ArrowRight', [1, 0]],
            ['ArrowUp', [0, -1]],
            ['ArrowDown', [0, 1]],
          ]).get(event.key)

          if (!delta) return
          event.preventDefault()

          if (panning) {
            changeView(() => camera.pan(delta[0]!, delta[1]!))
            cells.get(key(focused.x, focused.y))?.focus()

            return
          }

          const nextX = Math.max(0, Math.min(draft.data.width - 1, x + delta[0]!))
          const nextY = Math.max(0, Math.min(draft.data.height - 1, y + delta[1]!))
          focused = { x: nextX, y: nextY }
          selection?.move({ x, y }, focused, event.shiftKey)

          if (
            nextX < camera.x ||
            nextX >= camera.x + columns ||
            nextY < camera.y ||
            nextY >= camera.y + rows
          ) {
            camera.moveTo(
              Math.min(Math.max(camera.x, nextX - columns + 1), nextX),
              Math.min(Math.max(camera.y, nextY - rows + 1), nextY),
            )
            render()
          }

          cells.get(key(nextX, nextY))?.focus()
        })
        row.append(button)
      }

      grid.append(row)
    }
  }

  element.addEventListener(
    'pointermove',
    (event) => {
      if (panning || drag) return

      const button = document
        .elementFromPoint?.(event.clientX, event.clientY)
        ?.closest<HTMLButtonElement>('button[data-map-x]')

      if (button && grid.contains(button)) {
        if (painting && (event.buttons & 1) !== 0) stroke(button)
        else if (selection?.hover(point(button))) {
          for (const cell of cells.values()) updateCell(cell)
        }
      }
    },
    { signal: abort.signal },
  )
  element.addEventListener(
    'pointerleave',
    () => {
      if (!painting && selection?.hover(undefined))
        for (const cell of cells.values()) updateCell(cell)
    },
    { signal: abort.signal },
  )

  const stop = () => {
    painting = false
    const pointerId = drag?.pointerId
    drag = undefined
    surface.classList.toggle('map-panning', false)

    if (pointerId !== undefined && surface.hasPointerCapture?.(pointerId))
      surface.releasePointerCapture(pointerId)

    if (editing) {
      editing = false
      history?.end()
    }
  }

  surface.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 1 && !(panning && event.button === 0)) return
      event.preventDefault()
      stop()
      const bounds = grid.getBoundingClientRect()
      drag = {
        pointerId: event.pointerId,
        button: event.button,
        startX: event.clientX,
        startY: event.clientY,
        x: camera.x,
        y: camera.y,
        cellWidth: bounds.width / camera.columns,
        cellHeight: bounds.height / camera.rows,
      }
      surface.classList.toggle('map-panning', true)
      surface.setPointerCapture?.(event.pointerId)
      selection?.hover(undefined)

      for (const cell of cells.values()) updateCell(cell)
    },
    { signal: abort.signal },
  )
  surface.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return

      if ((event.buttons & (drag.button === 1 ? 4 : 1)) === 0) {
        stop()

        return
      }

      event.preventDefault()
      const x = drag.x - Math.round((event.clientX - drag.startX) / drag.cellWidth)
      const y = drag.y - Math.round((event.clientY - drag.startY) / drag.cellHeight)

      if (camera.moveTo(x, y)) {
        clampFocus()
        render()
        cells.get(key(focused.x, focused.y))?.focus()
      }
    },
    { signal: abort.signal },
  )
  surface.addEventListener('lostpointercapture', stop, { signal: abort.signal })
  surface.addEventListener(
    'auxclick',
    (event) => {
      if (event.button === 1) event.preventDefault()
    },
    { signal: abort.signal },
  )
  surface.addEventListener(
    'wheel',
    (event) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return
      event.preventDefault()
      const bounds = grid.getBoundingClientRect()

      const anchor = {
        x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
      }

      changeView(() => camera.zoomBy(event.deltaY < 0 ? 1 : -1, anchor))
    },
    { signal: abort.signal, passive: false },
  )

  document.addEventListener('pointerup', stop, { signal: abort.signal })
  document.addEventListener('pointercancel', stop, { signal: abort.signal })
  document.defaultView?.addEventListener('blur', stop, { signal: abort.signal })
  surface.append(grid)
  element.append(navigation, surface)
  render()

  return {
    element,
    focus: () => cells.get(key(focused.x, focused.y))?.focus(),
    refresh: (overview = true) => {
      for (const cell of cells.values()) updateCell(cell)

      if (overview) minimap.refresh()
    },
    refreshOverview: minimap.refresh,
    dispose: () => {
      stop()
      minimap.dispose()

      if (viewport)
        Object.assign(viewport, {
          x: camera.x,
          y: camera.y,
          focusX: focused.x,
          focusY: focused.y,
          zoom: camera.zoom,
          panning,
        })
      abort.abort()
      element.remove()
    },
  }
}
