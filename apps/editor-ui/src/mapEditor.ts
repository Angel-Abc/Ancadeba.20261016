import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import { MapDraft, MapDraftError } from './mapDraft.js'
import { mapTileGrid, mapGridViewport } from './mapTileGrid.js'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'
import { mapTileImages, type IGraphicResources } from '@ancadeba/ui-components'
import { mapTilesetEditor, type TilesetEditorState } from './mapTilesetEditor.js'
import { mapLayerEditor, type MapLayerEditorState } from './mapLayerEditor.js'
import { MapTileSelection } from './mapTileSelection.js'
import { mapSelectionTools } from './mapSelectionTools.js'
import { MapDraftHistory } from './mapDraftHistory.js'

type MapCommand = Extract<EditorCommand, { type: 'game.upsertMap' | 'game.removeMap' }>

export function bindMapEditor(
  root: HTMLElement,
  save: (command: MapCommand) => void,
  t: Translate,
  options: {
    confirm: (message: string) => boolean | Promise<boolean>
    onNavigate?: (id: string | undefined) => void
    onSaved?: (id: string | undefined) => void
    createGraphics?: (path: string) => IGraphicResources & { dispose(): void }
    onHistoryChange?: () => void
  },
) {
  const document = root.ownerDocument
  root.classList.add('map-editor')
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let selected = ''
  let creating = true
  let id = ''
  let draft = new MapDraft()
  let brush = 'ground'
  let width = '16'
  let height = '12'
  let newTerrain = ''
  let dirty = false
  let busy = false
  let confirming = false
  let submitted: MapCommand | undefined
  let board: ReturnType<typeof mapTileGrid> | undefined
  let images: ReturnType<typeof mapTileImages> | undefined
  let graphics: (IGraphicResources & { dispose(): void }) | undefined
  let tilesetEditor: ReturnType<typeof mapTilesetEditor> | undefined
  let graphicsRevision = ''
  let tilesetState: TilesetEditorState = { selected: '', newId: '', column: 0, row: 0 }
  let layerState: MapLayerEditorState = { selected: '', newId: '', erasing: false }
  let gridViewport = mapGridViewport()
  let selection = new MapTileSelection()
  let tileTools: ReturnType<typeof mapSelectionTools> | undefined
  const capture = () => ({ map: draft.data, id })
  const history = new MapDraftHistory(capture())
  const inputGroups = new WeakMap<Element, number>()
  let nextInputGroup = 1
  let strokeActive = false
  let strokeChanged = false

  const draftHistory = () => ({
    active: history.active || strokeChanged,
    canUndo: history.canUndo || strokeChanged,
    canRedo: !strokeChanged && history.canRedo,
    blocked: busy || confirming,
  })

  const notifyHistory = () => {
    tileTools?.refresh()
    options.onHistoryChange?.()
  }

  const syncDirty = () => {
    dirty =
      strokeChanged ||
      history.dirty ||
      width !== String(draft.data.width) ||
      height !== String(draft.data.height) ||
      Boolean(newTerrain || layerState.newId || tilesetState.newId) ||
      (!creating && !view?.maps?.[selected])
  }

  const record = (group?: number) => {
    history.record(capture(), layerState.selected, group)
    syncDirty()
    notifyHistory()
  }

  const finishStroke = () => {
    if (!strokeActive) return
    strokeActive = false
    strokeChanged = false
    record()
  }

  const controls = ruleFormControls(document, () => {
    const input = document.activeElement
    let group: number | undefined

    if (input?.tagName === 'INPUT' || input?.tagName === 'TEXTAREA') {
      group = inputGroups.get(input)

      if (group === undefined) {
        group = nextInputGroup++
        inputGroups.set(input, group)
      }
    }

    record(group)
  })

  const report = (cause: unknown) => {
    error.textContent =
      cause instanceof MapDraftError
        ? t(`maps.${cause.code}`)
        : cause instanceof Error
          ? cause.message
          : String(cause)
  }

  const change = (operation: () => void) => {
    try {
      finishStroke()
      history.breakGroup()
      operation()
      record()
      error.textContent = ''
      render()
    } catch (cause) {
      report(cause)
    }
  }

  const reset = () => {
    finishStroke()

    if (!creating && !view?.maps?.[selected]) {
      selected = view?.game?.maps?.[0] ?? ''
      selection = new MapTileSelection()
    }

    if (!selected) creating = true
    draft = new MapDraft(creating ? undefined : view?.maps?.[selected])
    id = creating ? 'new-map' : selected

    if (creating) {
      let suffix = 2

      while (view?.game?.maps?.some((mapId) => mapId.toLowerCase() === id.toLowerCase()))
        id = `new-map-${suffix++}`
    }

    brush = Object.hasOwn(draft.data.terrain, brush)
      ? brush
      : (Object.keys(draft.data.terrain)[0] ?? '')
    width = String(draft.data.width)
    height = String(draft.data.height)
    newTerrain = ''
    const retainedLayer = draft.data.layers?.find((layer) => layer.id === layerState.selected)
    layerState = {
      selected: retainedLayer?.id ?? '',
      newId: '',
      erasing: Boolean(retainedLayer && layerState.erasing),
    }
    const tile = draft.data.terrain[brush]?.tile
    tilesetState = {
      selected: tile?.tileset ?? '',
      newId: '',
      column: tile?.column ?? 0,
      row: tile?.row ?? 0,
    }
    history.reset(capture())
    dirty = false
    error.textContent = ''
    render()
    notifyHistory()
  }

  const confirm = async (message: string) => {
    if (busy || confirming) return false
    confirming = true
    fields.disabled = true
    notifyHistory()

    try {
      return await options.confirm(message)
    } finally {
      confirming = false
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
      notifyHistory()
    }
  }

  const resize = async () => {
    finishStroke()
    const nextWidth = Number(width)
    const nextHeight = Number(height)

    if (nextWidth === draft.data.width && nextHeight === draft.data.height) return true
    // Validate dimensions before asking about cropping or allocating a larger map.
    const candidate = new MapDraft(draft.data)
    const groundFill = layerState.selected ? (draft.data.tiles[0]?.[0] ?? brush) : brush
    candidate.resize(nextWidth, nextHeight, groundFill)

    if (
      (nextWidth < draft.data.width || nextHeight < draft.data.height) &&
      !(await confirm(t('maps.cropConfirm')))
    )
      return false
    draft = candidate
    width = String(draft.data.width)
    height = String(draft.data.height)
    record()
    render()

    return true
  }

  const submit = (command: MapCommand) => {
    finishStroke()
    const parsed = commandSchema.safeParse(command)

    if (!parsed.success) {
      error.textContent = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('\n')

      return
    }

    submitted = command
    error.textContent = ''
    save(command)
  }

  const navigate = (mapId?: string, newMap = false): boolean => {
    const next = newMap
      ? ''
      : (mapId ?? (view?.maps?.[selected] ? selected : (view?.game?.maps?.[0] ?? '')))

    const nextCreating = newMap || !next

    if (next === selected && nextCreating === creating) return true

    if (dirty) {
      error.textContent = t('maps.saveFirst')

      return false
    }

    selected = next
    creating = nextCreating
    brush = ''
    gridViewport = mapGridViewport()
    selection = new MapTileSelection()
    layerState = { selected: '', newId: '', erasing: false }
    reset()

    return true
  }

  const restoreDraft = (direction: 'undo' | 'redo') => {
    if (busy || confirming) return
    finishStroke()
    const restored = direction === 'undo' ? history.undo() : history.redo()

    if (!restored) return
    const pendingWidth = width !== String(draft.data.width)
    const pendingHeight = height !== String(draft.data.height)
    draft = new MapDraft(restored.state.map)
    id = restored.state.id

    if (!pendingWidth) width = String(draft.data.width)

    if (!pendingHeight) height = String(draft.data.height)
    layerState.selected = draft.data.layers?.some((layer) => layer.id === restored.layer)
      ? restored.layer
      : ''
    layerState.erasing = Boolean(layerState.selected && layerState.erasing)

    if (!Object.hasOwn(draft.data.terrain, brush)) brush = Object.keys(draft.data.terrain)[0] ?? ''
    selection.setTool(selection.tool === 'paste' ? 'select' : selection.tool)
    selection.reconcile(draft, layerState.selected)
    syncDirty()
    error.textContent = ''
    render()
    notifyHistory()
    board?.focus()
  }

  const render = () => {
    board?.dispose()
    images?.dispose()
    board = undefined
    fields.replaceChildren()

    if (!view?.game) return
    images = mapTileImages(
      draft.data,
      view.assets,
      graphics,
      () => {
        board?.refresh()
        tilesetEditor?.refresh()
      },
      (message) => {
        error.textContent = message
      },
    )
    const form = document.createElement('form')
    form.className = 'map-editor-form'
    const savedIds = view.game.maps ?? []

    const picker = controls.select(
      t('maps.map'),
      creating ? '' : selected,
      [['', t('maps.new')], ...savedIds.map((mapId) => [mapId, mapId] as const)],
      (value) => {
        if (!navigate(value || undefined, value === ''))
          picker.querySelector('select')!.value = creating ? '' : selected
        else options.onNavigate?.(value || undefined)
      },
      false,
    )

    const name = controls.input(t('maps.id'), id, (value) => {
      id = value.trim()
    })

    name.querySelector('input')!.readOnly = !creating
    form.append(picker, name)
    const dimensions = document.createElement('div')
    dimensions.className = 'map-editor-dimensions'
    dimensions.append(
      controls.input(
        t('maps.width'),
        width,
        (value) => {
          width = value
        },
        'number',
      ),
      controls.input(
        t('maps.height'),
        height,
        (value) => {
          height = value
        },
        'number',
      ),
      controls.button(t('maps.resize'), async () => {
        if (busy || confirming) return

        try {
          await resize()
        } catch (cause) {
          report(cause)
        }
      }),
    )

    for (const input of dimensions.querySelectorAll('input')) {
      input.min = '1'
      input.step = '1'
    }

    const references = view.scenes.flatMap((scene) =>
      scene.components.flatMap((component) =>
        component.type === 'map-view' && component.map === selected
          ? [{ scene: scene.id, component }]
          : [],
      ),
    )

    const help = document.createElement('p')
    help.className = 'help'
    help.textContent = references.length
      ? t('maps.references', {
          scenes: [...new Set(references.map((reference) => reference.scene))].join(', '),
        })
      : t('maps.placeHelp')
    const terrain = document.createElement('fieldset')
    const legend = document.createElement('legend')
    legend.textContent = t('maps.terrain')
    terrain.append(
      legend,
      controls.select(
        t('maps.brush'),
        brush,
        Object.keys(draft.data.terrain),
        (value) => {
          brush = value
          const tile = draft.data.terrain[brush]?.tile

          if (tile) {
            tilesetState.selected = tile.tileset
            tilesetState.column = tile.column
            tilesetState.row = tile.row
          }

          render()
        },
        false,
      ),
    )
    const definition = draft.data.terrain[brush]
    let tileChoice: HTMLSelectElement | undefined

    if (definition) {
      terrain.append(
        controls.select(
          t('maps.baseColor'),
          definition.color ? 'yes' : 'no',
          [
            ['yes', t('maps.yes')],
            ['no', t('maps.no')],
          ],
          (value) =>
            change(() => {
              if (value === 'yes') definition.color ??= '#608c4f'
              else delete definition.color
            }),
        ),
      )
      terrain.append(
        controls.input(
          t('maps.color'),
          definition.color ?? '#608c4f',
          (value) => {
            definition.color = value
            board?.refresh()
          },
          'color',
        ),
        controls.select(
          t('maps.walkable'),
          definition.walkable === false ? 'no' : 'yes',
          [
            ['yes', t('maps.yes')],
            ['no', t('maps.no')],
          ],
          (value) => {
            definition.walkable = value === 'yes'
            board?.refresh()
          },
        ),
        controls.input(
          t('maps.cost'),
          String(definition.movementCostMs ?? 0),
          (value) => {
            definition.movementCostMs = Number(value)
          },
          'number',
        ),
      )

      const colorInput = terrain.querySelector('input')!
      colorInput.disabled = definition.color === undefined

      const tileField = controls.select(
        t('maps.tileImage'),
        definition.tile?.tileset ?? '',
        [
          ['', t('maps.noImage')],
          ...Object.keys(draft.data.tilesets ?? {}).map((id) => [id, id] as const),
        ],
        (value) =>
          change(() => {
            if (!value) {
              delete definition.tile
              definition.color ??= '#608c4f'
            } else {
              definition.tile = { tileset: value, column: 0, row: 0 }
              tilesetState.selected = value
            }
          }),
      )

      tileChoice = tileField.querySelector('select')!
      terrain.append(tileField)

      const alternatives = Object.keys(draft.data.terrain).filter(
        (terrainId) => terrainId !== brush,
      )

      let replacement = alternatives[0] ?? ''
      terrain.append(
        controls.select(
          t('maps.replacement'),
          replacement,
          alternatives,
          (value) => {
            replacement = value
          },
          false,
        ),
        controls.button(
          t('maps.removeTerrain'),
          () =>
            change(() => {
              draft.removeTerrain(brush, replacement)
              brush = replacement || Object.keys(draft.data.terrain)[0]!
            }),
          alternatives.length === 0,
        ),
      )
    }

    terrain.append(
      controls.input(t('maps.newTerrain'), newTerrain, (value) => {
        newTerrain = value.trim()
      }),
      controls.button(t('maps.addTerrain'), () =>
        change(() => {
          draft.addTerrain(newTerrain)
          brush = newTerrain
          newTerrain = ''
        }),
      ),
    )
    const instructions = document.createElement('p')
    instructions.className = 'help'
    instructions.textContent = t('maps.paintHelp')

    const spawns = new Set(
      references.flatMap(({ component }) =>
        component.playerSpawn ? [`${component.playerSpawn.x},${component.playerSpawn.y}`] : [],
      ),
    )

    const layers = mapLayerEditor(document, draft, controls, t, layerState, render, change, confirm)

    const gridDisabled = () =>
      busy ||
      confirming ||
      draft.data.layers?.find((layer) => layer.id === layerState.selected)?.visible === false

    tileTools = mapSelectionTools(document, draft, layerState, selection, t, {
      disabled: gridDisabled,
      repaint: () => board?.refresh(false),
      focusGrid: () => board?.focus(),
      edited: () => {
        record()
        board?.refreshOverview()
        error.textContent = ''
      },
      report,
      assets: view.assets,
      imageUrl: (image) => images?.url(image),
      history: { state: draftHistory, restore: restoreDraft },
    })

    board = mapTileGrid(
      document,
      draft,
      () => brush,
      () => {
        if (strokeActive) {
          strokeChanged = true
          dirty = true
          notifyHistory()
        } else record()
      },
      gridDisabled,
      t,
      spawns,
      view.assets,
      (image) => images?.url(image),
      () => layerState.selected,
      () => layerState.erasing,
      gridViewport,
      tileTools.interaction,
      {
        begin: () => {
          finishStroke()
          history.breakGroup()
          strokeActive = true
        },
        end: finishStroke,
      },
    )
    tilesetEditor = mapTilesetEditor(
      document,
      draft.data,
      view.assets,
      brush,
      controls,
      t,
      (image) => images?.url(image),
      tilesetState,
      render,
      () => {
        board?.refresh()

        if (tileChoice) tileChoice.value = draft.data.terrain[brush]?.tile?.tileset ?? ''
      },
      report,
    )
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = t(creating ? 'maps.create' : 'maps.save')
    saveButton.disabled = !creating && !view.maps?.[selected]
    const actions = saveBar(document, saveButton, controls.button(t('maps.discard'), reset))

    if (!creating)
      actions.append(
        controls.button(
          t('maps.delete'),
          async () => {
            if (busy || confirming) return

            if (dirty) {
              error.textContent = t('maps.saveFirst')

              return
            }

            if (await confirm(t('maps.deleteConfirm', { id: selected })))
              submit({ type: 'game.removeMap', mapId: selected })
          },
          dirty,
        ),
      )
    form.append(
      dimensions,
      help,
      layers,
      terrain,
      tilesetEditor.element,
      instructions,
      tileTools.element,
      board.element,
      controls.button(t(layerState.selected ? 'maps.fillLayer' : 'maps.fill'), async () => {
        if (busy || confirming) return

        const message = layerState.selected
          ? t('maps.fillLayerConfirm', {
              layer:
                draft.data.layers?.find((layer) => layer.id === layerState.selected)?.name ??
                layerState.selected,
              terrain: layerState.erasing ? t('maps.emptyTile') : brush,
            })
          : t('maps.fillConfirm', { terrain: brush })

        if (await confirm(message))
          change(() => draft.fill(layerState.erasing ? null : brush, layerState.selected))
      }),
      actions,
    )
    form.addEventListener('submit', async (event) => {
      event.preventDefault()

      if (busy || confirming) return

      try {
        if (!(await resize())) return

        if (creating && savedIds.some((mapId) => mapId.toLowerCase() === id.toLowerCase())) {
          error.textContent = t('maps.mapExists')

          return
        }

        submit({ type: 'game.upsertMap', mapId: id, map: draft.data, createOnly: creating })
      } catch (cause) {
        report(cause)
      }
    })
    fields.append(form)

    for (const input of fields.querySelectorAll('input'))
      input.addEventListener('blur', () => history.breakGroup())
    fields.disabled = busy || confirming || Boolean(view.diagnostics.length)
  }

  return {
    navigate,
    draftHistory,
    restoreDraft,
    hasDrafts: () => dirty,
    dispose: () => {
      board?.dispose()
      images?.dispose()
      graphics?.dispose()
    },
    render(state: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = path !== state.path
      const changed = view !== state.view
      const busyChanged = busy !== state.busy
      path = state.path
      view = state.view
      busy = state.busy

      if (
        changed &&
        !projectChanged &&
        !creating &&
        (dirty || history.active) &&
        view?.maps?.[selected]
      ) {
        history.setBaseline({ map: view.maps[selected]!, id: selected })
        syncDirty()
      }

      const revision = `${path}:${view?.revision}`

      if (revision !== graphicsRevision) {
        images?.dispose()
        graphics?.dispose()
        graphics = view && options.createGraphics?.(path ?? '')
        graphicsRevision = revision
      }

      if (submitted && !busy && state.error) submitted = undefined

      const saved =
        submitted && replaceFields && state.lastCommand === submitted.type && !state.error

      if (saved && submitted) {
        if (submitted.type === 'game.removeMap') selection = new MapTileSelection()
        selected =
          submitted.type === 'game.upsertMap' ? submitted.mapId : (view?.game?.maps?.[0] ?? '')
        creating = !selected
        submitted = undefined
        reset()
        options.onSaved?.(selected || undefined)
      } else if (projectChanged || (replaceFields && !state.preserveDrafts)) {
        if (projectChanged) {
          layerState = { selected: '', newId: '', erasing: false }
          brush = ''
          gridViewport = mapGridViewport()
          selection = new MapTileSelection()
        }

        selected = projectChanged ? (view?.game?.maps?.[0] ?? '') : selected
        creating = !selected
        reset()
      } else if (changed && !dirty && !history.active) reset()
      else if (changed || !busyChanged) render()
      fields.disabled = busy || confirming || !view?.game || Boolean(view.diagnostics.length)
      notifyHistory()
    },
  }
}
