import type { Translate } from '@ancadeba/utilities'
import { MapViewport, mapZoomLevels } from './mapViewport.js'

/** View controls never mutate the map draft or its edit history. */
export function mapViewportControls(
  document: Document,
  camera: MapViewport,
  t: Translate,
  options: {
    change(operation: () => void): void
    panning(): boolean
    setPanning(value: boolean): void
    focusGrid(): void
  },
) {
  const element = document.createElement('div')
  element.className = 'map-viewport-controls'
  const zoomControls = document.createElement('div')
  zoomControls.className = 'map-window-controls'
  zoomControls.setAttribute('role', 'group')
  zoomControls.setAttribute('aria-label', t('maps.viewControls'))
  const buttons: { button: HTMLButtonElement; disabled: () => boolean }[] = []

  const button = (
    parent: HTMLElement,
    key: string,
    operation: () => void,
    disabled = () => false,
  ) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = t(key)
    button.addEventListener('click', () => options.change(operation))
    buttons.push({ button, disabled })
    parent.append(button)

    return button
  }

  button(
    zoomControls,
    'maps.zoomOut',
    () => camera.zoomBy(-1),
    () => !camera.canZoomOut,
  )
  const label = document.createElement('label')
  label.append(t('maps.zoom'))
  const zoom = document.createElement('select')

  for (const level of mapZoomLevels) {
    const option = document.createElement('option')
    option.value = String(level)
    option.textContent = `${level}%`
    zoom.append(option)
  }

  zoom.addEventListener('change', () => options.change(() => camera.zoomTo(Number(zoom.value))))
  label.append(zoom)
  zoomControls.append(label)
  button(
    zoomControls,
    'maps.zoomIn',
    () => camera.zoomBy(1),
    () => !camera.canZoomIn,
  )
  const pan = button(zoomControls, 'maps.panMap', () => options.setPanning(!options.panning()))
  pan.addEventListener('click', () => options.focusGrid())
  button(
    zoomControls,
    'maps.panLeft',
    () => camera.pan(-1, 0),
    () => camera.x === 0,
  )
  button(
    zoomControls,
    'maps.panRight',
    () => camera.pan(1, 0),
    () => camera.x + camera.columns >= camera.width,
  )
  button(
    zoomControls,
    'maps.panUp',
    () => camera.pan(0, -1),
    () => camera.y === 0,
  )
  button(
    zoomControls,
    'maps.panDown',
    () => camera.pan(0, 1),
    () => camera.y + camera.rows >= camera.height,
  )
  button(zoomControls, 'maps.resetView', () => {
    camera.zoomTo(100)
    camera.moveTo(0, 0)
    options.setPanning(false)
  })
  const pages = document.createElement('div')
  pages.className = 'map-window-controls'
  button(
    pages,
    'maps.left',
    () => camera.pan(-camera.columns, 0),
    () => camera.x === 0,
  )
  button(
    pages,
    'maps.right',
    () => camera.pan(camera.columns, 0),
    () => camera.x + camera.columns >= camera.width,
  )
  button(
    pages,
    'maps.up',
    () => camera.pan(0, -camera.rows),
    () => camera.y === 0,
  )
  button(
    pages,
    'maps.down',
    () => camera.pan(0, camera.rows),
    () => camera.y + camera.rows >= camera.height,
  )
  const range = document.createElement('span')
  range.setAttribute('role', 'status')
  pages.append(range)
  const help = document.createElement('p')
  help.className = 'help'
  help.textContent = t('maps.viewHelp')
  element.append(zoomControls, pages)

  const refresh = () => {
    zoom.value = String(camera.zoom)
    pan.setAttribute('aria-pressed', String(options.panning()))

    for (const { button, disabled } of buttons) button.disabled = disabled()
    range.textContent = t('maps.range', {
      x: camera.x,
      endX: camera.x + camera.columns - 1,
      y: camera.y,
      endY: camera.y + camera.rows - 1,
    })
  }

  refresh()

  return { element, help, refresh }
}
