import type { ProjectView } from '@ancadeba/editor-core'
import type { ButtonComponentDefinition } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function mapInteractFields(
  controls: RuleFormControls,
  view: ProjectView,
  sceneId: string,
  action: Extract<NonNullable<ButtonComponentDefinition['action']>, { type: 'interact-map' }>,
  render: () => void,
) {
  const maps =
    view.scenes
      .find(({ id }) => id === sceneId)
      ?.components.filter(
        (component) =>
          component.type === 'map-view' && component.playerSpawn && component.interactive !== false,
      ) ?? []

  const map = maps.find(({ id }) => id === action.mapView)
  const objects = map?.type === 'map-view' ? (view.maps?.[map.map]?.objects ?? []) : []
  const help = controls.create('p')
  help.className = 'help'
  help.textContent = controls.t('maps.interactHelp')

  return [
    controls.select(
      controls.t('controls.targetMapView'),
      action.mapView,
      maps.map(({ id }) => id),
      (value) => {
        action.mapView = value
        delete action.object
        render()
      },
    ),
    controls.select(
      controls.t('maps.interactTarget'),
      action.object ?? '',
      [
        ['', controls.t('maps.onlyAdjacent')],
        ...objects.map((object) => [object.id, object.label] as const),
      ],
      (value) => {
        if (value) action.object = value
        else delete action.object
      },
    ),
    help,
  ]
}
