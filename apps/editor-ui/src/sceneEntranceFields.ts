import type { ProjectView } from '@ancadeba/editor-core'
import type { SceneTransition } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

/** Shared entrance controls for rules, scene buttons, and action-bar navigation. */
export function sceneEntranceFields(
  controls: RuleFormControls,
  view: ProjectView,
  action: SceneTransition,
  render: () => void,
  chargeTime = false,
): HTMLElement[] {
  const { select, input, create, t } = controls

  const maps =
    view.scenes
      .find(({ id }) => id === action.scene)
      ?.components.filter(
        (component) =>
          component.type === 'map-view' && component.playerSpawn && component.interactive !== false,
      ) ?? []

  const fields: HTMLElement[] = [
    select(
      t(chargeTime ? 'rules.chargeTime' : 'entrance.mapView'),
      action.mapView ?? '',
      [['', t('form.none')], ...maps.map(({ id }) => id)],
      (next) => {
        if (next) action.mapView = next
        else delete action.mapView
        delete action.position
        render()
      },
    ),
  ]

  if (!action.mapView) return fields
  fields.push(
    select(
      t('entrance.placePlayer'),
      action.position ? 'yes' : 'no',
      [
        ['no', t('form.no')],
        ['yes', t('form.yes')],
      ],
      (next) => {
        const map = maps.find(({ id }) => id === action.mapView)

        if (next === 'yes')
          action.position = map?.type === 'map-view' ? { ...map.playerSpawn! } : { x: 0, y: 0 }
        else delete action.position
        render()
      },
    ),
  )

  if (action.position) {
    const position = action.position
    const coordinates = ['x', 'y'] as const

    for (const coordinate of coordinates) {
      const field = input(
        t(coordinate === 'x' ? 'entrance.x' : 'entrance.y'),
        String(position[coordinate]),
        (value) => {
          position[coordinate] = Number(value)
        },
        'number',
      )

      const control = field.querySelector('input')!
      control.min = '0'
      control.step = '1'
      fields.push(field)
    }

    const help = create('p')
    help.className = 'help'
    help.textContent = t('entrance.help')
    fields.push(help)
  }

  return fields
}
