import type { ProjectView } from '@ancadeba/editor-core'
import {
  gameBindingSchema,
  type ActionBarComponentDefinition,
  type ActionBarSlotDefinition,
} from '@ancadeba/schemas'
import { statePath, type RuleFormControls } from './ruleFormControls.js'

function shortcut(view: ProjectView, binding: ActionBarSlotDefinition['inputBinding']): string {
  if (!binding || !view.input) return ''
  const mappings = view.input.contexts[binding.context]

  return Object.entries(view.input.keyboard)
    .filter(([, key]) => mappings?.[key] === binding.input)
    .map(([code]) => code.replace(/^(?:Key(?=[A-Z]$)|Digit(?=[0-9]$))/, ''))
    .join(' / ')
}

export function actionBarForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: ActionBarComponentDefinition,
  selectedSlot: string,
  selectSlot: (id: string) => void,
  change: (edit: () => void) => void,
  sceneId?: string,
): HTMLElement[] {
  const { create, input, select, button, group } = controls
  const grid = create('div')
  grid.className = 'action-bar-slot-grid'

  for (let index = 1; index <= 15; index++) {
    const id = String(index)
    const slot = draft.slots[id]
    const keys = shortcut(view, slot?.inputBinding)
    const label = slot?.label || slot?.labelKey || 'Empty'
    const control = button('', () => selectSlot(id))
    control.className = 'action-bar-slot'
    const title = `Slot ${id} · ${label}${keys ? ` · ${keys}` : ''}`
    control.title = title
    control.setAttribute('aria-label', title)
    const heading = create('span')
    heading.className = 'action-bar-slot-heading'
    heading.textContent = `${id}${keys ? ` · ${keys}` : ''}`
    const caption = create('span')
    caption.className = 'action-bar-slot-label'
    caption.textContent = label
    control.append(heading, caption)
    control.setAttribute('aria-pressed', String(id === selectedSlot))
    grid.append(control)
  }

  const slot = draft.slots[selectedSlot]
  const actions = Object.keys(view.rules?.actions ?? {})
  const gameScenes = view.scenes.filter(({ type }) => type === 'game').map(({ id }) => id)

  const inventoryPanels =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter((component) => component.type === 'inventory') ?? []

  const nearbyPanels =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter((component) => component.type === 'nearby') ?? []

  const mapViews =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter(
        (component) =>
          component.type === 'map-view' && component.interactive !== false && component.playerSpawn,
      ) ?? []

  const detail = group(`Slot ${selectedSlot}`)
  detail.append(
    select(
      'Action type',
      slot?.action.type ?? '',
      [
        ['', 'Empty slot'],
        ['request-action', 'Request game action'],
        ['enter-scene', 'Enter scene'],
        ['new-game', 'New game'],
        ['inventory-action', 'Selected inventory item'],
        ['nearby-action', 'Selected nearby target'],
        ['move-map', 'Move on map'],
      ],
      (type) =>
        change(() => {
          if (!type) {
            delete draft.slots[selectedSlot]

            return
          }

          draft.slots[selectedSlot] = {
            ...(slot ?? { label: '' }),
            action:
              type === 'move-map'
                ? { type, mapView: mapViews[0]?.id ?? '', direction: 'north' }
                : type === 'nearby-action'
                  ? { type, nearby: nearbyPanels[0]?.id ?? '', action: 'talk' }
                  : type === 'inventory-action'
                    ? { type, inventory: inventoryPanels[0]?.id ?? '', action: 'inspect' }
                    : type === 'request-action'
                      ? { type, action: actions[0] ?? '' }
                      : {
                          type: type === 'new-game' ? 'new-game' : 'enter-scene',
                          scene: gameScenes[0] ?? '',
                        },
          }
        }),
    ),
  )

  if (slot) {
    detail.append(
      input('Slot label', slot.label, (value) => {
        slot.label = value
      }),
      select(
        'Label translation',
        slot.labelKey ?? '',
        [['', 'Use literal label'], ...(view.translationKeys ?? [])],
        (value) => {
          if (value) slot.labelKey = value
          else delete slot.labelKey
        },
      ),
    )
    const action = slot.action

    if (action.type === 'nearby-action') {
      detail.append(
        select(
          'Nearby panel',
          action.nearby,
          nearbyPanels.map(({ id }) => id),
          (value) => {
            action.nearby = value
          },
        ),
        input('Target action ID', action.action, (value) => {
          action.action = value.trim()
        }),
      )
    } else if (action.type === 'move-map') {
      detail.append(
        select(
          'Target map view',
          action.mapView,
          mapViews.map(({ id }) => id),
          (value) => {
            action.mapView = value
          },
        ),
        select('Direction', action.direction, ['north', 'east', 'south', 'west'], (value) => {
          if (value === 'north' || value === 'east' || value === 'south' || value === 'west')
            action.direction = value
        }),
      )

      if (!mapViews.length)
        detail.append('Add an interactive map view with a player spawn in this scene first.')
    } else if (action.type === 'inventory-action') {
      detail.append(
        select(
          'Inventory panel',
          action.inventory,
          inventoryPanels.map(({ id }) => id),
          (value) => {
            action.inventory = value
          },
        ),
        input('Item action ID', action.action, (value) => {
          action.action = value.trim()
        }),
      )
      const help = create('p')
      help.textContent =
        'The slot appears when a selected item supports this action. The inspect ID uses its existing inspection action.'
      detail.append(help)
    } else if (action.type === 'request-action') {
      const binding = action.enabledWhen

      const options = (view.rules?.state ?? [])
        .filter(({ value }) => typeof value === 'boolean')
        .map(
          ({ path }) => [JSON.stringify({ source: 'game.state', path }), statePath(path)] as const,
        )

      if (binding && !options.some(([value]) => value === JSON.stringify(binding)))
        options.push([JSON.stringify(binding), `${binding.source} · ${binding.path.join('.')}`])
      detail.append(
        input('Requested action ID', action.action, (value) => {
          action.action = value.trim()
        }),
        select(
          'Enable when true',
          binding ? JSON.stringify(binding) : '',
          [['', 'Always'], ...options],
          (value) => {
            if (value) action.enabledWhen = gameBindingSchema.parse(JSON.parse(value))
            else delete action.enabledWhen
          },
        ),
      )
    } else
      detail.append(
        select(
          'Target scene',
          action.scene,
          action.type === 'new-game' ? gameScenes : view.scenes.map(({ id }) => id),
          (value) => {
            action.scene = value
          },
        ),
      )

    detail.append(
      select(
        'Input context',
        slot.inputBinding?.context ?? '',
        [['', 'Click only'], ...Object.keys(view.input?.contexts ?? {})],
        (context) =>
          change(() => {
            if (context)
              slot.inputBinding = {
                context,
                input: Object.values(view.input?.contexts[context] ?? {})[0] ?? '',
              }
            else delete slot.inputBinding
          }),
      ),
    )

    if (slot.inputBinding) {
      const binding = slot.inputBinding
      detail.append(
        select(
          'Virtual input',
          binding.input,
          [...new Set(Object.values(view.input?.contexts[binding.context] ?? {}))],
          (value) =>
            change(() => {
              binding.input = value
            }),
        ),
      )
      const keys = create('p')
      keys.textContent = `Keyboard shortcuts · ${shortcut(view, binding) || 'No physical keys mapped'}`
      detail.append(keys)
    }
  }

  const placement = group(
    'Bar placement',
    input('Component ID', draft.id, (value) => {
      draft.id = value.trim()
    }),
    ...(['row', 'column', 'rowSpan', 'columnSpan'] as const).map((key) =>
      input(
        { row: 'Row', column: 'Column', rowSpan: 'Row span', columnSpan: 'Column span' }[key],
        String(draft.placement[key]),
        (value) => {
          draft.placement[key] = Number(value)
        },
        'number',
      ),
    ),
  )

  const placementDetails = create('details')
  const summary = create('summary')
  summary.textContent = 'Bar placement'
  placementDetails.append(summary, placement)

  return [grid, detail, placementDetails]
}
