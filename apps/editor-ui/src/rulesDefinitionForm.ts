import {
  ruleValueType,
  type GameRulesDefinition,
  type RuleCondition,
  type RuleEffect,
  type RuleText,
  type RuleValue,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  parseStatePath,
  type RuleFormControls,
  ruleValueControls,
  statePath,
  translationChoices,
} from './ruleFormControls.js'
import {
  combatOutcomeLabels,
  comparisonLabels,
  conditionTypeLabels,
  effectTypeLabels,
  labelled,
  questChoices,
  questStatusLabels,
  sceneChoices,
} from './choiceLabels.js'

type ConditionType = RuleCondition['type']

type EffectType = RuleEffect['type']

export function rulesDefinitionForm(
  controls: RuleFormControls,
  view: ProjectView,
  rules: GameRulesDefinition,
  selected: string,
  selectAction: (id: string) => void,
  change: (edit: () => void) => void,
  rerender: () => void,
  otherFields: GameRulesDefinition['state'],
): HTMLElement[] {
  const { button, create, group, input, select } = controls
  const keys = translationChoices(view, false)
  const scenes = view.scenes.filter(({ type }) => type === 'game')
  const sceneIds = scenes.map(({ id }) => id)
  const owners = Object.keys(view.inventory?.owners ?? {})
  const items = Object.keys(view.inventory?.items ?? {})
  const availableFields = [...rules.state, ...otherFields]
  const fields = availableFields.map(({ path }) => statePath(path))
  const firstPath = () => availableFields[0]?.path.slice() ?? ['']
  const firstValue = () => (availableFields[0] ? defaultValue(availableFields[0].value) : '')

  const text = (title: string, value: RuleText, update: (value: RuleText) => void) =>
    ruleValueControls(
      controls,
      title,
      value,
      keys,
      (next) => {
        if (typeof next === 'string' || typeof next === 'object') update(next)
      },
      rerender,
      ['text', 'translation'],
    )

  function defaultValue(value: RuleValue): string | number | boolean {
    return typeof value === 'object' ? '' : value
  }

  function condition(type: ConditionType): RuleCondition {
    switch (type) {
      case 'scene-is':
        return { type, scene: sceneIds[0] ?? '' }
      case 'state-is':
        return { type, path: firstPath(), value: firstValue() }
      case 'state-compare':
        return { type, path: firstPath(), operator: 'gte', value: 1 }
      case 'quest-state':
        return { type, quest: Object.keys(view.quests ?? {})[0] ?? '', status: 'completed' }
      case 'combat-outcome':
        return { type, encounter: Object.keys(view.combat ?? {})[0] ?? '', outcome: 'victory' }
      case 'item-owned-by':
      case 'item-carried-by':
        return { type, item: items[0] ?? '', owner: owners[0] ?? '' }
      case 'payload-is-item':
        return { type, item: items[0] ?? '' }
      case 'payload-is-target':
        return {
          type,
          target:
            view.scenes.flatMap((scene) =>
              scene.components.flatMap((component) =>
                component.type === 'nearby' ? Object.keys(component.entries) : [],
              ),
            )[0] ?? '',
        }
    }
  }

  function effect(type: EffectType): RuleEffect {
    switch (type) {
      case 'set-state':
        return { type, path: firstPath(), value: firstValue() }
      case 'move-item':
        return { type, item: items[0] ?? '', owner: owners[0] ?? '' }
      case 'enter-scene':
        return { type, scene: sceneIds[0] ?? '' }
      case 'start-quest':
      case 'complete-quest':
        return { type, quest: Object.keys(view.quests ?? {})[0] ?? '' }
      case 'append-log':
        return { type, text: '' }
    }
  }

  function stateField(
    entry: Extract<RuleCondition | RuleEffect, { type: 'state-is' | 'set-state' }>,
  ) {
    const field = availableFields.find(({ path }) => statePath(path) === statePath(entry.path))
    const type = field && ruleValueType(field.value)

    const types =
      type === 'string'
        ? entry.type === 'set-state'
          ? ['text', 'translation']
          : ['text']
        : type
          ? [type]
          : undefined

    return [
      select('State field', statePath(entry.path), fields, (next) => {
        entry.path = parseStatePath(next)
        entry.value = defaultValue(
          availableFields.find(({ path }) => statePath(path) === next)?.value ?? '',
        )
        rerender()
      }),
      ...ruleValueControls(
        controls,
        'Value',
        entry.value,
        keys,
        (next) => {
          if (entry.type === 'set-state') entry.value = next
          else entry.value = defaultValue(next)
        },
        rerender,
        types,
      ),
    ]
  }

  const state = group(
    'Initial state',
    ...rules.state.map((field, index) =>
      group(
        `Field ${index + 1}`,
        input('Binding path (dot-separated)', statePath(field.path), (next) => {
          field.path = parseStatePath(next)
        }),
        ...ruleValueControls(
          controls,
          'Initial value',
          field.value,
          keys,
          (next) => {
            field.value = next
          },
          rerender,
        ),
        button('Remove field', () =>
          change(() => {
            rules.state.splice(index, 1)
          }),
        ),
      ),
    ),
    button('Add field', () =>
      change(() => {
        rules.state.push({ path: [''], value: '' })
      }),
    ),
  )

  const clock = rules.clock
  const log = rules.log

  const display = group(
    'Clock and activity log',
    clock
      ? group(
          'Clock',
          input('Binding path', statePath(clock.path), (next) => {
            clock.path = parseStatePath(next)
          }),
          input(
            'Start time',
            `${String(Math.floor(clock.startMinute / 60)).padStart(2, '0')}:${String(clock.startMinute % 60).padStart(2, '0')}`,
            (next) => {
              const [hours, minutes] = next.split(':').map(Number)
              clock.startMinute = hours! * 60 + minutes!
            },
            'time',
          ),
          button('Remove clock', () =>
            change(() => {
              delete rules.clock
            }),
          ),
        )
      : button('Add clock', () =>
          change(() => {
            rules.clock = { path: ['clock'], startMinute: 540 }
          }),
        ),
    log
      ? group(
          'Activity log',
          input('Binding path', statePath(log.path), (next) => {
            log.path = parseStatePath(next)
          }),
          input(
            'Maximum entries',
            String(log.capacity),
            (next) => {
              log.capacity = Number(next)
            },
            'number',
          ),
          ...log.initial.map((value, index) =>
            group(
              `Initial entry ${index + 1}`,
              ...text('Message', value, (next) => {
                log.initial[index] = next
              }),
              button('Remove entry', () =>
                change(() => {
                  log.initial.splice(index, 1)
                }),
              ),
            ),
          ),
          button('Add initial entry', () =>
            change(() => {
              log.initial.push('')
            }),
          ),
          button('Remove activity log', () =>
            change(() => {
              delete rules.log
            }),
          ),
        )
      : button('Add activity log', () =>
          change(() => {
            rules.log = { path: ['log'], capacity: 8, initial: [] }
          }),
        ),
  )

  const actions = group('Actions')
  const actionIds = Object.keys(rules.actions)

  if (actionIds.length) actions.append(select('Action', selected, actionIds, selectAction, false))
  const newId = create('input')
  newId.setAttribute('aria-label', 'New action ID')
  newId.placeholder = 'New action ID'

  const addAction = button('Add action', () => {
    const id = newId.value.trim()

    if (!/^[a-zA-Z0-9_-]+$/.test(id) || Object.hasOwn(rules.actions, id)) {
      newId.setCustomValidity(
        'Enter a unique action ID using letters, digits, dashes, or underscores',
      )
      newId.reportValidity()

      return
    }

    change(() => {
      Object.defineProperty(rules.actions, id, {
        value: [{ when: [], effects: [] }],
        writable: true,
        enumerable: true,
        configurable: true,
      })
      selectAction(id)
    })
  })

  newId.addEventListener('input', () => newId.setCustomValidity(''))
  actions.append(newId, addAction)

  const branches = Object.hasOwn(rules.actions, selected) ? rules.actions[selected] : undefined

  if (branches) {
    branches.forEach((branch, index) => {
      const row = group(
        `Branch ${index + 1}`,
        button(
          'Move up',
          () =>
            change(() => {
              branches.splice(index - 1, 0, branches.splice(index, 1)[0]!)
            }),
          index === 0,
        ),
        button(
          'Move down',
          () =>
            change(() => {
              branches.splice(index + 1, 0, branches.splice(index, 1)[0]!)
            }),
          index === branches.length - 1,
        ),
        button(
          'Remove branch',
          () =>
            change(() => {
              branches.splice(index, 1)
            }),
          branches.length === 1,
        ),
      )

      const conditions = group('When all match')
      branch.when.forEach((entry, position) => {
        const field = group(
          `Condition ${position + 1}`,
          select(
            'Condition',
            entry.type,
            labelled(
              [
                'scene-is',
                'state-is',
                'state-compare',
                'quest-state',
                'combat-outcome',
                'item-owned-by',
                'item-carried-by',
                'payload-is-item',
                'payload-is-target',
              ] as const,
              conditionTypeLabels,
            ),
            (next) =>
              change(() => {
                branch.when[position] = condition(next)
              }),
          ),
        )

        if (entry.type === 'scene-is')
          field.append(
            select('Scene', entry.scene, sceneChoices(view, 'game'), (next) => {
              entry.scene = next
            }),
          )

        if (entry.type === 'state-is') field.append(...stateField(entry))

        if (entry.type === 'state-compare')
          field.append(
            select('State field', statePath(entry.path), fields, (value) => {
              entry.path = parseStatePath(value)
            }),
            select(
              'Comparison',
              entry.operator,
              labelled(['eq', 'gte', 'lte', 'gt', 'lt'] as const, comparisonLabels),
              (value) => {
                entry.operator = value
              },
            ),
            input(
              'Required amount',
              String(entry.value),
              (value) => {
                entry.value = Number(value)
              },
              'number',
            ),
          )

        if (entry.type === 'quest-state')
          field.append(
            select('Quest', entry.quest, questChoices(view), (value) => {
              entry.quest = value
            }),
            select(
              'Quest status',
              entry.status,
              labelled(['not-started', 'active', 'ready', 'completed'] as const, questStatusLabels),
              (value) => {
                entry.status = value
              },
            ),
            input('Optional stage ID', entry.stage ?? '', (value) => {
              entry.stage = value || undefined
            }),
          )

        if (entry.type === 'combat-outcome')
          field.append(
            select('Encounter', entry.encounter, Object.keys(view.combat ?? {}), (value) => {
              entry.encounter = value
            }),
            select(
              'Outcome',
              entry.outcome,
              labelled(['victory', 'defeat', 'escaped'] as const, combatOutcomeLabels),
              (value) => {
                entry.outcome = value
              },
            ),
          )

        if (entry.type === 'payload-is-target')
          field.append(
            select(
              'Target',
              entry.target,
              [
                ...new Set(
                  view.scenes.flatMap((scene) =>
                    scene.components.flatMap((component) =>
                      component.type === 'nearby' ? Object.keys(component.entries) : [],
                    ),
                  ),
                ),
              ],
              (next) => {
                entry.target = next
              },
            ),
          )

        if ('item' in entry)
          field.append(
            select('Item', entry.item, items, (next) => {
              entry.item = next
            }),
          )

        if ('owner' in entry)
          field.append(
            select('Owner', entry.owner, owners, (next) => {
              entry.owner = next
            }),
          )
        field.append(
          button('Remove condition', () =>
            change(() => {
              branch.when.splice(position, 1)
            }),
          ),
        )
        conditions.append(field)
      })
      conditions.append(
        button('Add condition', () =>
          change(() => {
            branch.when.push(condition('scene-is'))
          }),
        ),
      )

      const effects = group('Effects')
      branch.effects.forEach((entry, position) => {
        const field = group(
          `Effect ${position + 1}`,
          select(
            'Effect',
            entry.type,
            labelled(
              [
                'set-state',
                'move-item',
                'enter-scene',
                'append-log',
                'start-quest',
                'complete-quest',
              ] as const,
              effectTypeLabels,
            ),
            (next) =>
              change(() => {
                branch.effects[position] = effect(next)
              }),
          ),
        )

        if (entry.type === 'set-state') field.append(...stateField(entry))

        if (entry.type === 'start-quest' || entry.type === 'complete-quest')
          field.append(
            select('Quest', entry.quest, questChoices(view), (value) => {
              entry.quest = value
            }),
          )

        if (entry.type === 'move-item')
          field.append(
            select('Item', entry.item, items, (next) => {
              entry.item = next
            }),
            select('Destination owner', entry.owner, owners, (next) => {
              entry.owner = next
            }),
          )

        if (entry.type === 'enter-scene') {
          const mapViews =
            scenes
              .find(({ id }) => id === entry.scene)
              ?.components.filter(
                (component) => component.type === 'map-view' && component.playerSpawn,
              )
              .map(({ id }) => id) ?? []

          field.append(
            select('Destination scene', entry.scene, sceneChoices(view, 'game'), (next) => {
              entry.scene = next
              delete entry.mapView
              rerender()
            }),
            select(
              'Charge time from map view',
              entry.mapView ?? '',
              [['', 'None'], ...mapViews],
              (next) => {
                if (next) entry.mapView = next
                else delete entry.mapView
              },
            ),
          )
        }

        if (entry.type === 'append-log')
          field.append(
            ...text('Message', entry.text, (next) => {
              entry.text = next
            }),
          )
        field.append(
          button('Remove effect', () =>
            change(() => {
              branch.effects.splice(position, 1)
            }),
          ),
        )
        effects.append(field)
      })
      effects.append(
        button('Add effect', () =>
          change(() => {
            branch.effects.push(effect('set-state'))
          }),
        ),
      )
      row.append(conditions, effects)
      actions.append(row)
    })
    actions.append(
      button('Add branch', () =>
        change(() => {
          branches.push({ when: [], effects: [] })
        }),
      ),
      button('Remove action', () =>
        change(() => {
          delete rules.actions[selected]
          selectAction(Object.keys(rules.actions)[0] ?? '')
        }),
      ),
    )
  }

  return [actions, state, display]
}
