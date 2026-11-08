import type { Translate } from '@ancadeba/utilities'
import type { MapDraft } from './mapDraft.js'
import type { RuleFormControls } from './ruleFormControls.js'

export interface MapLayerEditorState {
  selected: string
  newId: string
  erasing: boolean
}

export function mapLayerEditor(
  document: Document,
  draft: MapDraft,
  controls: RuleFormControls,
  t: Translate,
  state: MapLayerEditorState,
  render: () => void,
  change: (operation: () => void) => void,
  confirm: (message: string) => Promise<boolean>,
) {
  const element = document.createElement('fieldset')
  element.className = 'map-layers'
  const legend = document.createElement('legend')
  legend.textContent = t('maps.layers')
  const layers = draft.data.layers ?? []
  const layer = layers.find((layer) => layer.id === state.selected)

  if (!layer) {
    state.selected = ''
    state.erasing = false
  }

  element.append(
    legend,
    controls.select(
      t('maps.paintLayer'),
      state.selected,
      [
        ['', t('maps.groundLayer')],
        ...layers.map((layer) => [layer.id, layer.name ?? layer.id] as const),
      ],
      (id) => {
        state.selected = id
        state.erasing = false
        render()
      },
      false,
    ),
  )
  const help = document.createElement('p')
  help.className = 'help'
  help.textContent = t('maps.layerHelp')
  element.append(help)

  if (layer) {
    element.append(
      controls.input(t('maps.layerName'), layer.name ?? layer.id, (name) => {
        layer.name = name
      }),
      controls.select(
        t('maps.layerVisible'),
        layer.visible === false ? 'no' : 'yes',
        [
          ['yes', t('maps.yes')],
          ['no', t('maps.no')],
        ],
        (value) =>
          change(() => {
            layer.visible = value === 'yes'
          }),
      ),
      controls.select(
        t('maps.layerCollision'),
        layer.collision === false ? 'no' : 'yes',
        [
          ['yes', t('maps.yes')],
          ['no', t('maps.no')],
        ],
        (value) =>
          change(() => {
            layer.collision = value === 'yes'
          }),
      ),
      controls.button(
        t('maps.layerUp'),
        () => change(() => draft.moveLayer(layer.id, 1)),
        layers.indexOf(layer) === layers.length - 1,
      ),
      controls.button(
        t('maps.layerDown'),
        () => change(() => draft.moveLayer(layer.id, -1)),
        layers.indexOf(layer) === 0,
      ),
      controls.button(t('maps.clearLayer'), async () => {
        if (await confirm(t('maps.clearLayerConfirm', { layer: layer.name ?? layer.id })))
          change(() => draft.fill(null, layer.id))
      }),
      controls.button(t('maps.removeLayer'), async () => {
        if (await confirm(t('maps.removeLayerConfirm', { layer: layer.name ?? layer.id })))
          change(() => {
            draft.removeLayer(layer.id)
            state.selected = ''
            state.erasing = false
          })
      }),
    )
  }

  element.append(
    controls.input(t('maps.newLayerId'), state.newId, (value) => {
      state.newId = value.trim()
    }),
    controls.button(t('maps.addLayer'), () =>
      change(() => {
        draft.addLayer(state.newId)
        state.selected = state.newId
        state.newId = ''
        state.erasing = false
      }),
    ),
  )

  return element
}
