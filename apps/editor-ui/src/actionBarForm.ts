import type { ProjectView } from '@ancadeba/editor-core'
import {
  gameBindingSchema,
  dialogueCommandSchema,
  questOperationSchema,
  type ActionBarComponentDefinition,
  type ActionBarSlotDefinition,
} from '@ancadeba/schemas'
import {
  placementFields,
  type RuleFormControls,
  statePath,
  translationChoices,
} from './ruleFormControls.js'
import { questChoices, sceneChoices } from './choiceLabels.js'
import { sceneEntranceFields } from './sceneEntranceFields.js'
import { mapInteractFields } from './mapInteractFields.js'

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
  const { create, input, select, button, group, translation, t } = controls
  const render = () => selectSlot(selectedSlot)
  const grid = create('div')
  grid.className = 'action-bar-slot-grid'

  for (let index = 1; index <= 15; index++) {
    const id = String(index)
    const slot = draft.slots[id]
    const keys = shortcut(view, slot?.inputBinding)
    const label = slot?.label || slot?.labelKey || t('controls.empty')
    const control = button('', () => selectSlot(id))
    control.className = 'action-bar-slot'
    const title = `${t('form.slot', { id })} · ${label}${keys ? ` · ${keys}` : ''}`
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

  const combats =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter((component) => component.type === 'combat') ?? []

  const shops =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter((component) => component.type === 'shop') ?? []

  const equipmentViews =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter((component) => component.type === 'equipment') ?? []

  const mapViews =
    view.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.filter(
        (component) =>
          component.type === 'map-view' && component.interactive !== false && component.playerSpawn,
      ) ?? []

  const detail = group(t('form.slot', { id: selectedSlot }))
  detail.append(
    select(
      t('controls.actionType'),
      slot?.action.type ?? '',
      [
        ['', t('controls.emptySlot')],
        ['request-action', t('controls.requestAction')],
        ['enter-scene', t('controls.enterScene')],
        ['new-game', t('controls.newGame')],
        ['inventory-action', t('controls.selectedItem')],
        ['item-use', t('controls.useSelectedItem')],
        ['nearby-action', t('controls.selectedTarget')],
        ['move-map', t('controls.moveOnMap')],
        ['interact-map', t('maps.interact')],
        ['equipment-action', t('controls.equipmentCommand')],
        ['shop-action', t('controls.shopCommand')],
        ['combat-action', t('controls.combatCommand')],
        ['dialogue-action', t('controls.dialogueCommand')],
        ['quest-action', t('controls.questCommand')],
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
              type === 'dialogue-action'
                ? { type, nearby: nearbyPanels[0]?.id ?? '', command: { type: 'start' } }
                : type === 'quest-action'
                  ? { type, quest: Object.keys(view.quests ?? {})[0] ?? '', operation: 'start' }
                  : type === 'item-use'
                    ? { type, inventory: inventoryPanels[0]?.id ?? '', combat: combats[0]?.id }
                    : type === 'combat-action'
                      ? { type, combat: combats[0]?.id ?? '', command: { type: 'end-turn' } }
                      : type === 'shop-action'
                        ? { type, shop: shops[0]?.id ?? '', operation: 'buy' }
                        : type === 'equipment-action'
                          ? { type, equipment: equipmentViews[0]?.id ?? '', operation: 'equip' }
                          : type === 'interact-map'
                            ? { type, mapView: mapViews[0]?.id ?? '' }
                            : type === 'move-map'
                              ? { type, mapView: mapViews[0]?.id ?? '', direction: 'north' }
                              : type === 'nearby-action'
                                ? { type, nearby: nearbyPanels[0]?.id ?? '', action: 'talk' }
                                : type === 'inventory-action'
                                  ? {
                                      type,
                                      inventory: inventoryPanels[0]?.id ?? '',
                                      action: 'inspect',
                                    }
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
      input(t('controls.slotLabel'), slot.label, (value) => {
        slot.label = value
      }),
      translation(
        t('form.labelTranslation'),
        slot.labelKey ?? '',
        translationChoices(view, t('form.literalLabel')),
        (value) => {
          if (value) slot.labelKey = value
          else delete slot.labelKey
        },
      ),
    )
    const action = slot.action

    if (action.type === 'dialogue-action') {
      detail.append(
        select(
          t('controls.dialogueNearbyPanel'),
          action.nearby,
          nearbyPanels.map((panel) => panel.id),
          (value) => {
            action.nearby = value
          },
        ),
        select(
          t('controls.dialogueCommand'),
          action.command.type,
          ['start', 'choose', 'end', 'previous-page', 'next-page'],
          (value) =>
            change(() => {
              action.command = dialogueCommandSchema.parse(
                value === 'choose' ? { type: value, position: 1 } : { type: value },
              )
            }),
        ),
      )

      if (action.command.type === 'choose')
        detail.append(
          input(
            t('controls.replyPosition'),
            String(action.command.position),
            (value) => {
              if (action.command.type === 'choose') action.command.position = Number(value)
            },
            'number',
          ),
        )
    }

    if (action.type === 'quest-action') {
      detail.append(
        select(
          t('controls.questTargetMode'),
          action.journal ? 'journal' : 'quest',
          ['quest', 'journal'],
          (value) =>
            change(() => {
              action.quest =
                value === 'quest' ? (Object.keys(view.quests ?? {})[0] ?? '') : undefined
              action.journal =
                value === 'journal'
                  ? (view.scenes
                      .find((scene) => scene.id === sceneId)
                      ?.components.find((component) => component.type === 'quest-log')?.id ?? '')
                  : undefined
            }),
        ),
        select(
          t('controls.questOperation'),
          action.operation,
          questOperationSchema.options,
          (value) => {
            action.operation = value
          },
        ),
      )

      if (action.quest !== undefined)
        detail.append(
          select(t('controls.fixedQuest'), action.quest, questChoices(view), (value) => {
            action.quest = value
          }),
        )
      else
        detail.append(
          select(
            t('controls.questJournal'),
            action.journal ?? '',
            view.scenes
              .find((scene) => scene.id === sceneId)
              ?.components.filter((component) => component.type === 'quest-log')
              .map((component) => component.id) ?? [],
            (value) => {
              action.journal = value
            },
          ),
        )
    }

    if (action.type === 'item-use') {
      detail.append(
        select(
          t('controls.itemUseInventory'),
          action.inventory,
          inventoryPanels.map((panel) => panel.id),
          (value) => {
            action.inventory = value
          },
        ),
        select(
          t('controls.itemUseCombatView'),
          action.combat ?? '',
          ['', ...combats.map((entry) => entry.id)],
          (value) => {
            action.combat = value || undefined
          },
        ),
      )
    }

    if (action.type === 'combat-action') {
      detail.append(
        select(
          t('form.combatView'),
          action.combat,
          combats.map((component) => component.id),
          (value) =>
            change(() => {
              action.combat = value
            }),
        ),
        select(
          t('controls.combatCommand'),
          action.command.type,
          [
            'queue-move',
            'previous-target',
            'next-target',
            'undo',
            'clear',
            'end-turn',
            'escape',
            'continue',
            'take-loot',
            'take-all-loot',
            'retry-rewards',
          ],
          (value) =>
            change(() => {
              if (value === 'queue-item') return
              action.command = value === 'queue-move' ? { type: value, move: '' } : { type: value }
            }),
        ),
      )

      if (action.command.type === 'queue-move') {
        const command = action.command
        const component = combats.find((component) => component.id === action.combat)
        detail.append(
          select(
            t('controls.combatMove'),
            command.move,
            component
              ? [
                  ...(view.combat?.[component.encounter]?.player.moves ?? []),
                  ...(view.combat?.[component.encounter]?.player.equipmentMoves ?? []),
                ]
              : [],
            (value) => {
              command.move = value
            },
          ),
        )
      }
    } else if (action.type === 'shop-action') {
      detail.append(
        select(
          t('tree.shop'),
          action.shop,
          shops.map((shop) => shop.id),
          (value) => {
            action.shop = value
          },
        ),
        select(t('controls.tradeOperation'), action.operation, ['buy', 'sell'], (value) => {
          action.operation = value
        }),
      )
    } else if (action.type === 'equipment-action') {
      detail.append(
        select(
          t('controls.equipmentView'),
          action.equipment,
          equipmentViews.map((view) => view.id),
          (value) => {
            action.equipment = value
          },
        ),
        select(
          t('controls.equipmentOperation'),
          action.operation,
          ['equip', 'unequip'],
          (value) => {
            action.operation = value
          },
        ),
      )
    } else if (action.type === 'nearby-action') {
      detail.append(
        select(
          t('controls.nearbyPanel'),
          action.nearby,
          nearbyPanels.map(({ id }) => id),
          (value) => {
            action.nearby = value
          },
        ),
        input(t('controls.targetActionId'), action.action, (value) => {
          action.action = value.trim()
        }),
      )
    } else if (action.type === 'interact-map') {
      detail.append(...mapInteractFields(controls, view, sceneId ?? '', action, render))
    } else if (action.type === 'move-map') {
      detail.append(
        select(
          t('controls.targetMapView'),
          action.mapView,
          mapViews.map(({ id }) => id),
          (value) => {
            action.mapView = value
          },
        ),
        select(
          t('form.direction'),
          action.direction,
          ['north', 'east', 'south', 'west'],
          (value) => {
            if (value === 'north' || value === 'east' || value === 'south' || value === 'west')
              action.direction = value
          },
        ),
      )

      if (!mapViews.length) detail.append(t('controls.mapViewFirst'))
    } else if (action.type === 'inventory-action') {
      detail.append(
        select(
          t('controls.inventoryPanel'),
          action.inventory,
          inventoryPanels.map(({ id }) => id),
          (value) => {
            action.inventory = value
          },
        ),
        input(t('form.itemActionId'), action.action, (value) => {
          action.action = value.trim()
        }),
      )
      const help = create('p')
      help.textContent = t('controls.itemActionHelp')
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
        input(t('controls.requestedActionId'), action.action, (value) => {
          action.action = value.trim()
        }),
        select(
          t('form.enableWhenTrue'),
          binding ? JSON.stringify(binding) : '',
          [['', t('form.always')], ...options],
          (value) => {
            if (value) action.enabledWhen = gameBindingSchema.parse(JSON.parse(value))
            else delete action.enabledWhen
          },
        ),
      )
    } else if (action.type === 'new-game' || action.type === 'enter-scene')
      detail.append(
        select(
          t('form.targetScene'),
          action.scene,
          sceneChoices(view, action.type === 'new-game' ? 'game' : undefined),
          (value) => {
            action.scene = value

            if (action.type === 'enter-scene') {
              delete action.mapView
              delete action.position
              render()
            }
          },
        ),
        ...(action.type === 'enter-scene'
          ? sceneEntranceFields(controls, view, action, render)
          : []),
      )

    detail.append(
      select(
        t('controls.inputContext'),
        slot.inputBinding?.context ?? '',
        [['', t('controls.clickOnly')], ...Object.keys(view.input?.contexts ?? {})],
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
          t('controls.virtualInput'),
          binding.input,
          [...new Set(Object.values(view.input?.contexts[binding.context] ?? {}))],
          (value) =>
            change(() => {
              binding.input = value
            }),
        ),
      )
      const keys = create('p')
      keys.textContent = t('controls.shortcuts', {
        keys: shortcut(view, binding) || t('controls.noKeys'),
      })
      detail.append(keys)
    }
  }

  const placement = group(
    t('controls.barPlacement'),
    input(t('component.id'), draft.id, (value) => {
      draft.id = value.trim()
    }),
    ...placementFields(t).map(([key, label]) =>
      input(
        label,
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
  summary.textContent = t('controls.barPlacement')
  placementDetails.append(summary, placement)

  return [grid, detail, placementDetails]
}
