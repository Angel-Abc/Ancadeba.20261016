import type { Translate } from '@ancadeba/utilities'
import { applyMapTileAppearance } from '@ancadeba/ui-components'
import type { AssetCatalog, ImageAsset } from '@ancadeba/schemas'
import { MapDraftError, type MapDraft, type TilePoint } from './mapDraft.js'
import type { MapLayerEditorState } from './mapLayerEditor.js'
import { MapTileSelection } from './mapTileSelection.js'
import type { MapGridSelectionInteraction } from './mapTileGrid.js'
import { ruleFormControls } from './ruleFormControls.js'

export function mapSelectionTools(
  document: Document,
  draft: MapDraft,
  layer: MapLayerEditorState,
  model: MapTileSelection,
  t: Translate,
  options: {
    disabled: () => boolean
    repaint: () => void
    focusGrid: () => void
    edited: () => void
    report: (cause: unknown) => void
    assets?: AssetCatalog | undefined
    imageUrl: (image: ImageAsset) => string | undefined
    history?: {
      state(): { active: boolean; canUndo: boolean; canRedo: boolean; blocked: boolean }
      restore(direction: 'undo' | 'redo'): void
    }
  },
) {
  const element = document.createElement('fieldset')
  element.className = 'map-selection-tools'
  const controls = ruleFormControls(document, () => {})
  model.reconcile(draft, layer.selected)

  const refresh = () => {
    element.replaceChildren()
    const legend = document.createElement('legend')
    legend.textContent = t('maps.selectionTools')
    const choices: [string, string][] = [['paint', t('maps.paint')]]

    if (layer.selected) choices.push(['erase', t('maps.erase')])
    choices.push(['select', t('maps.selectTiles')])

    if (model.size) choices.push(['paste', t('maps.paste')])
    const disabled = options.disabled()
    const selected = model.selected?.layer === layer.selected
    element.append(
      legend,
      controls.select(
        t('maps.paintTool'),
        model.tool === 'paint' ? (layer.erasing ? 'erase' : 'paint') : model.tool,
        choices,
        (tool) => {
          layer.erasing = tool === 'erase'
          model.setTool(tool === 'select' || tool === 'paste' ? tool : 'paint')
          update()
          options.focusGrid()
        },
        false,
      ),
      controls.button(
        t('maps.copySelection'),
        () => fromToolbar(() => model.copy(draft, layer.selected)),
        disabled || !selected,
      ),
      controls.button(
        t('maps.cutSelection'),
        () => fromToolbar(() => model.copy(draft, layer.selected, true)),
        disabled || !selected,
      ),
      controls.button(t('maps.paste'), () => fromToolbar(armPaste), disabled || !model.size),
      controls.button(
        t(model.tool === 'paste' ? 'maps.cancelPaste' : 'maps.clearSelection'),
        () => {
          model.cancel()
          update()
          options.focusGrid()
        },
      ),
    )

    if (!layer.selected)
      element.append(
        controls.select(
          t('maps.groundReplacement'),
          model.groundFill,
          Object.keys(draft.data.terrain),
          (value) => {
            model.groundFill = value
          },
          false,
        ),
      )
    else
      element.append(
        controls.select(
          t('maps.skipEmpty'),
          model.skipEmpty ? 'yes' : 'no',
          [
            ['yes', t('maps.yes')],
            ['no', t('maps.no')],
          ],
          (value) => {
            model.skipEmpty = value === 'yes'
            update()
          },
          false,
        ),
      )
    const status = document.createElement('p')
    status.className = 'help map-selection-status'
    status.setAttribute('role', 'status')
    const rect = model.selected?.rectangle
    status.textContent = [
      rect
        ? t('maps.selectionSize', {
            width: rect.width,
            height: rect.height,
            x: rect.x + 1,
            y: rect.y + 1,
          })
        : t('maps.noSelection'),
      model.size ? t(model.moving ? 'maps.moveReady' : 'maps.copyReady', model.size) : '',
    ]
      .filter(Boolean)
      .join(' ')
    const help = document.createElement('p')
    help.className = 'help'
    help.textContent = t('maps.selectionHelp')
    element.append(status, help)

    if (options.history) {
      const history = options.history.state()
      element.append(
        controls.button(
          t('maps.undoDraft'),
          () => options.history?.restore('undo'),
          history.blocked || !history.canUndo,
        ),
        controls.button(
          t('maps.redoDraft'),
          () => options.history?.restore('redo'),
          history.blocked || !history.canRedo,
        ),
      )
    }
  }

  const update = () => {
    refresh()
    options.repaint()
  }

  const run = (operation: () => void) => {
    if (options.disabled()) return

    try {
      operation()
      update()
    } catch (cause) {
      options.report(cause)
      update()
    }
  }

  const fromToolbar = (operation: () => void) => {
    if (options.disabled()) return
    run(operation)
    options.focusGrid()
  }

  const armPaste = () => {
    if (!model.size) throw new MapDraftError('invalidSelection')
    model.setTool('paste')
  }

  const paste = (point: TilePoint) =>
    run(() => {
      if (model.paste(draft, layer.selected, point)) options.edited()
    })

  const interaction: MapGridSelectionInteraction = {
    tool: () => model.tool,
    start(point, extend) {
      run(() => {
        if (extend) model.extend(layer.selected, point)
        else model.begin(layer.selected, point)
      })
    },
    drag(point) {
      run(() => model.extend(layer.selected, point))
    },
    activate(point, extend) {
      if (model.tool === 'paste') paste(point)
      else this.start(point, extend)
    },
    hover(point) {
      if (
        model.tool !== 'paste' ||
        options.disabled() ||
        (model.hover?.x === point?.x && model.hover?.y === point?.y)
      )
        return false
      model.hover = point && { ...point }

      return true
    },
    move(from, to, extend) {
      if (options.disabled()) return

      if (model.tool === 'select' && extend)
        run(() => {
          if (!model.anchor) model.begin(layer.selected, from)
          model.extend(layer.selected, to)
        })
      else if (model.tool === 'paste') {
        model.hover = { ...to }
        update()
      }
    },
    keydown(event, point) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return false
      const key = event.key.toLowerCase()
      const modifier = event.ctrlKey || event.metaKey

      const direction =
        modifier &&
        !event.altKey &&
        ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey))
          ? 'redo'
          : modifier && !event.altKey && key === 'z' && !event.shiftKey
            ? 'undo'
            : undefined

      if (direction && options.history?.state().active) {
        event.preventDefault()
        event.stopPropagation()
        options.history.restore(direction)

        return true
      }

      if (
        (modifier && !event.altKey && !event.shiftKey && ['c', 'x', 'v'].includes(key)) ||
        (!modifier && !event.altKey && !event.shiftKey && key === 'escape')
      ) {
        event.preventDefault()
        event.stopPropagation()

        if (key === 'escape') {
          model.cancel()
          update()
        } else if (key === 'v')
          run(() => {
            armPaste()
            model.hover = { ...point }
          })
        else
          run(() => {
            model.copy(draft, layer.selected, key === 'x')
            model.hover = { ...point }
          })

        return true
      }

      return false
    },
    decorate(cell, point) {
      const selected = model.isSelected(layer.selected, point)
      cell.setAttribute('aria-selected', String(selected))
      cell.classList.toggle('map-tile-selected', selected)
      cell.classList.toggle('map-tile-cut', selected && model.moving)
      const preview = options.disabled() ? undefined : model.preview(point, draft)
      cell.classList.toggle('map-tile-paste', Boolean(preview))
      cell.classList.toggle('map-tile-paste-invalid', preview?.valid === false)

      if (preview && preview.value !== null) {
        const ghost = document.createElement('span')
        ghost.className = 'map-paste-ghost'
        ghost.setAttribute('aria-hidden', 'true')
        applyMapTileAppearance(ghost, draft.data, preview.value, options.assets, options.imageUrl)
        cell.append(ghost)
      } else if (preview && !model.skipEmpty && layer.selected) {
        const ghost = document.createElement('span')
        ghost.className = 'map-paste-ghost map-paste-empty'
        cell.append(ghost)
      }
    },
  }

  refresh()

  return { element, interaction, refresh }
}
