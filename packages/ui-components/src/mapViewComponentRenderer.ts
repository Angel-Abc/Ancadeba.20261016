import type { MapViewComponentData, MapDirection } from '@ancadeba/game-runtime'
import { getMapMovementCostMs, type MapPosition } from '@ancadeba/schemas'
import { createBrowserTiming } from './browserTiming.js'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

const directions = new Map([
  ['ArrowUp', { x: 0, y: -1 }],
  ['ArrowDown', { x: 0, y: 1 }],
  ['ArrowLeft', { x: -1, y: 0 }],
  ['ArrowRight', { x: 1, y: 0 }],
])

const movementDirections = new Map<string, MapDirection>([
  ['ArrowUp', 'north'],
  ['ArrowRight', 'east'],
  ['ArrowDown', 'south'],
  ['ArrowLeft', 'west'],
])

function clampCoordinate(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, value))
}

export class MapViewComponentRenderer implements IComponentRenderer<MapViewComponentData> {
  render(
    component: MapViewComponentData,
    { document, scene }: ComponentRenderContext,
  ): RenderedComponent {
    const { map, viewport } = component
    const movement = scene?.type === 'game' ? scene.game.mapMovement : undefined

    const sharedMovement =
      movement && scene && movement.getPosition(scene, component.id) !== undefined

    const root = document.createElement('div')
    root.className = 'ancadeba-map-view'

    if (component.interactive !== false) root.tabIndex = 0
    root.setAttribute('role', 'region')
    root.setAttribute('aria-label', component.label)
    root.style.setProperty('--ge-map-view-columns', String(viewport.columns))
    root.style.setProperty('--ge-map-view-rows', String(viewport.rows))

    const clip = document.createElement('div')
    clip.className = 'ancadeba-map-window'
    const grid = document.createElement('div')
    grid.className = 'ancadeba-map-grid'
    grid.setAttribute('aria-hidden', 'true')
    grid.style.setProperty('--ge-map-columns', String(map.width))
    grid.style.setProperty('--ge-map-rows', String(map.height))

    for (const row of map.tiles) {
      for (const id of row) {
        const tile = document.createElement('div')
        tile.className = 'ancadeba-map-tile'
        tile.style.setProperty('--ge-map-tile-color', map.terrain[id]!.color)
        grid.append(tile)
      }
    }

    const player = component.playerSpawn && document.createElement('div')

    if (player) {
      player.className = 'ancadeba-map-player'
      grid.append(player)
    }

    clip.append(grid)
    root.append(clip)

    const maxX = map.width - viewport.columns
    const maxY = map.height - viewport.rows
    let x = 0
    let y = 0

    let playerPosition = sharedMovement
      ? movement.getPosition(scene, component.id)
      : component.playerSpawn

    let cancelStep: (() => void) | undefined

    const panTo = (nextX: number, nextY: number) => {
      x = clampCoordinate(nextX, maxX)
      y = clampCoordinate(nextY, maxY)
      grid.style.setProperty('--ge-map-x', String(x))
      grid.style.setProperty('--ge-map-y', String(y))
    }

    const showPlayer = (position: MapPosition) => {
      player?.style.setProperty('--ge-map-player-column', String(position.x + 1))
      player?.style.setProperty('--ge-map-player-row', String(position.y + 1))
      panTo(
        position.x - Math.floor((viewport.columns - 1) / 2),
        position.y - Math.floor((viewport.rows - 1) / 2),
      )
    }

    if (playerPosition) showPlayer(playerPosition)
    else panTo(viewport.x, viewport.y)

    const unsubscribeMovement = sharedMovement
      ? movement.subscribeChanges(() => {
          const position = movement.getPosition(scene, component.id)

          if (position) {
            playerPosition = position
            showPlayer(position)
          }
        })
      : undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      )
        return
      const direction = directions.get(event.key)

      if (!direction) return
      event.preventDefault()

      if (sharedMovement) {
        const direction = movementDirections.get(event.key)

        if (direction) movement.move(scene, component.id, direction)

        return
      }

      if (playerPosition) {
        if (cancelStep) return

        const destination = {
          x: playerPosition.x + direction.x,
          y: playerPosition.y + direction.y,
        }

        const duration = getMapMovementCostMs(map, destination)

        if (duration === undefined) return

        const arrive = () => {
          cancelStep = undefined
          playerPosition = destination
          showPlayer(destination)
        }

        if (duration === 0) arrive()
        else
          cancelStep = createBrowserTiming(document.defaultView ?? window).scheduler.schedule(
            arrive,
            duration,
          )
      } else panTo(x + direction.x, y + direction.y)
    }

    if (component.interactive !== false) root.addEventListener('keydown', onKeyDown)

    return {
      element: root,
      dispose() {
        cancelStep?.()
        unsubscribeMovement?.()
        root.removeEventListener('keydown', onKeyDown)
        root.remove()
      },
    }
  }
}
