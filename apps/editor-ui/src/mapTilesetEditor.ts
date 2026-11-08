import {
  assetIdSchema,
  mapTileRegion,
  mapTilesetSize,
  type AssetCatalog,
  type ImageAsset,
  type MapDefinition,
} from '@ancadeba/schemas'
import { applyMapTileImage } from '@ancadeba/ui-components'
import type { Translate } from '@ancadeba/utilities'
import type { RuleFormControls } from './ruleFormControls.js'

export interface TilesetEditorState {
  selected: string
  newId: string
  column: number
  row: number
}

export function mapTilesetEditor(
  document: Document,
  map: MapDefinition,
  assets: AssetCatalog | undefined,
  terrain: string,
  controls: RuleFormControls,
  t: Translate,
  imageUrl: (image: ImageAsset) => string | undefined,
  state: TilesetEditorState,
  update: () => void,
  repaint: () => void,
  report: (error: unknown) => void,
) {
  const element = document.createElement('fieldset')
  element.className = 'map-tilesets'
  const legend = document.createElement('legend')
  legend.textContent = t('maps.tilesets')
  element.append(legend)
  const ids = Object.keys(map.tilesets ?? {})

  if (!ids.includes(state.selected)) state.selected = ids[0] ?? ''
  element.append(
    controls.select(
      t('maps.editTileset'),
      state.selected,
      ids,
      (id) => {
        state.selected = id
        state.column = 0
        state.row = 0
        update()
      },
      false,
    ),
  )
  const sheet = map.tilesets?.[state.selected]
  const images = Object.keys(assets?.images ?? {})
  const help = document.createElement('p')
  help.className = 'help'
  help.textContent = t(images.length ? 'maps.tilesetHelp' : 'maps.importHelp')
  element.append(help)
  const preview = document.createElement('div')
  preview.className = 'map-tileset-picker'

  const refresh = () => {
    preview.replaceChildren()
    const image = sheet && assets?.images[sheet.image]

    if (!sheet || !image) return
    const size = mapTilesetSize(sheet, image)

    if (
      !Number.isFinite(size.columns) ||
      !Number.isFinite(size.rows) ||
      size.columns < 1 ||
      size.rows < 1 ||
      sheet.tileWidth < 1 ||
      sheet.tileHeight < 1
    )
      return
    const columns = Math.min(12, size.columns)
    const rows = Math.min(8, size.rows)
    state.column = Math.max(0, Math.min(size.columns - columns, state.column))
    state.row = Math.max(0, Math.min(size.rows - rows, state.row))
    const pages = document.createElement('div')
    pages.className = 'map-window-controls'

    const page = (label: string, x: number, y: number, disabled: boolean) =>
      controls.button(
        label,
        () => {
          state.column = x
          state.row = y
          refresh()
        },
        disabled,
      )

    pages.append(
      page(t('maps.left'), state.column - columns, state.row, state.column === 0),
      page(
        t('maps.right'),
        state.column + columns,
        state.row,
        state.column + columns >= size.columns,
      ),
      page(t('maps.up'), state.column, state.row - rows, state.row === 0),
      page(t('maps.down'), state.column, state.row + rows, state.row + rows >= size.rows),
    )
    const range = document.createElement('span')
    range.textContent = t('maps.range', {
      x: state.column + 1,
      endX: state.column + columns,
      y: state.row + 1,
      endY: state.row + rows,
    })
    pages.append(range)
    const grid = document.createElement('div')
    grid.className = 'map-tileset-grid'
    grid.style.setProperty('--map-editor-columns', String(columns))
    const selection = document.createElement('p')
    selection.className = 'help'

    const showSelection = () => {
      const tile = map.terrain[terrain]?.tile
      selection.textContent = tile
        ? `${tile.tileset}: ${t('maps.chosenTile', { column: tile.column + 1, row: tile.row + 1 })}`
        : ''
    }

    showSelection()

    for (let row = state.row; row < state.row + rows; row++) {
      for (let column = state.column; column < state.column + columns; column++) {
        const tile = document.createElement('button')
        tile.type = 'button'
        tile.className = 'map-tileset-tile'
        const label = t('maps.pickTile', { column: column + 1, row: row + 1 })
        tile.setAttribute('aria-label', label)
        tile.title = label
        const current = map.terrain[terrain]!.tile
        tile.setAttribute(
          'aria-pressed',
          String(
            current?.tileset === state.selected && current.column === column && current.row === row,
          ),
        )

        const previewMap = {
          ...map,
          terrain: { preview: { tile: { tileset: state.selected, column, row } } },
        }

        applyMapTileImage(tile, mapTileRegion(previewMap, 'preview', assets), imageUrl(image))
        tile.addEventListener('click', () => {
          map.terrain[terrain]!.tile = { tileset: state.selected, column, row }
          controls.markEdited()
          repaint()
          showSelection()

          for (const cell of grid.querySelectorAll('button'))
            cell.setAttribute('aria-pressed', String(cell === tile))
        })
        grid.append(tile)
      }
    }

    preview.append(pages, grid, selection)
  }

  if (sheet) {
    element.append(
      controls.select(t('maps.tilesetImage'), sheet.image, images, (value) => {
        sheet.image = value
        update()
      }),
    )

    for (const [key, label] of [
      ['tileWidth', 'maps.tileWidth'],
      ['tileHeight', 'maps.tileHeight'],
      ['margin', 'maps.margin'],
      ['spacing', 'maps.spacing'],
    ] as const) {
      const field = controls.input(
        t(label),
        String(sheet[key] ?? 0),
        (value) => {
          sheet[key] = Number(value)
          repaint()
          refresh()
        },
        'number',
      )

      const input = field.querySelector('input')!
      input.min = key === 'margin' || key === 'spacing' ? '0' : '1'
      input.step = '1'
      element.append(field)
    }

    element.append(
      controls.button(t('maps.removeTileset'), () => {
        if (Object.values(map.terrain).some((value) => value.tile?.tileset === state.selected)) {
          report(new Error(t('maps.tilesetInUse')))

          return
        }

        delete map.tilesets![state.selected]
        controls.markEdited()
        update()
      }),
    )
  }

  element.append(
    controls.input(t('maps.newTilesetId'), state.newId, (id) => {
      state.newId = id.trim()
    }),
    controls.button(
      t('maps.addTileset'),
      () => {
        if (
          !assetIdSchema.safeParse(state.newId).success ||
          Object.hasOwn(map.tilesets ?? {}, state.newId)
        ) {
          report(new Error(t('maps.invalidTilesetId')))

          return
        }

        const image = images[0]

        if (!image) {
          report(new Error(t('maps.importHelp')))

          return
        }

        map.tilesets ??= {}
        map.tilesets[state.newId] = {
          image,
          tileWidth: Math.max(1, Math.min(32, Math.floor(assets!.images[image]!.bounds.width))),
          tileHeight: Math.max(1, Math.min(32, Math.floor(assets!.images[image]!.bounds.height))),
        }
        state.selected = state.newId
        state.newId = ''
        state.column = 0
        state.row = 0
        controls.markEdited()
        update()
      },
      images.length === 0,
    ),
  )
  element.append(preview)
  refresh()

  return { element, refresh }
}
