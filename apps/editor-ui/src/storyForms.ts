import type { ProjectView } from '@ancadeba/editor-core'
import {
  dialogueNodeSchema,
  dialogueChoiceSchema,
  questObjectiveSchema,
  type DialogueDefinition,
  type QuestDefinition,
  type WorldCondition,
  type StoryEffect,
  type RuleText,
  type TextBindingsDefinition,
} from '@ancadeba/schemas'
import {
  yesNoChoices,
  type RuleFormControls,
  translationChoices,
  ruleValueControls,
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

type Presentation = Pick<QuestDefinition, 'label' | 'labelKey' | 'description' | 'descriptionKey'>

export function storyPresentation(
  controls: RuleFormControls,
  view: ProjectView,
  draft: Presentation,
): HTMLElement[] {
  const keys = translationChoices(view, 'Use literal text')

  return [
    controls.input('Name', draft.label, (value) => {
      draft.label = value
    }),
    controls.translation('Name translation', draft.labelKey ?? '', keys, (value) => {
      draft.labelKey = value || undefined
    }),
    controls.input('Description', draft.description, (value) => {
      draft.description = value
    }),
    controls.translation('Description translation', draft.descriptionKey ?? '', keys, (value) => {
      draft.descriptionKey = value || undefined
    }),
  ]
}

export function storyConditions(
  controls: RuleFormControls,
  view: ProjectView,
  label: string,
  conditions: WorldCondition[],
  render: () => void,
): HTMLElement {
  const root = controls.group(label)

  for (const [index, condition] of conditions.entries()) {
    const row = controls.group(`Condition ${index + 1}`)
    row.append(
      controls.select(
        'Condition type',
        condition.type,
        labelled(
          [
            'scene-is',
            'state-is',
            'state-compare',
            'item-carried-by',
            'item-owned-by',
            'quest-state',
            'combat-outcome',
          ] as const,
          conditionTypeLabels,
        ),
        (type) => {
          conditions[index] =
            type === 'scene-is'
              ? { type, scene: view.scenes[0]?.id ?? '' }
              : type === 'quest-state'
                ? { type, quest: Object.keys(view.quests ?? {})[0] ?? '', status: 'completed' }
                : type === 'combat-outcome'
                  ? { type, encounter: Object.keys(view.combat ?? {})[0] ?? '', outcome: 'victory' }
                  : type === 'state-is'
                    ? { type, path: view.rules?.state[0]?.path ?? ['flag'], value: false }
                    : type === 'state-compare'
                      ? { type, path: ['gold'], operator: 'gte', value: 1 }
                      : {
                          type: type === 'item-carried-by' ? 'item-carried-by' : 'item-owned-by',
                          item: Object.keys(view.inventory?.items ?? {})[0] ?? '',
                          owner: Object.keys(view.inventory?.owners ?? {})[0] ?? '',
                        }
          render()
        },
      ),
    )

    if (condition.type === 'scene-is')
      row.append(
        controls.select('Scene', condition.scene, sceneChoices(view), (value) => {
          condition.scene = value
        }),
      )

    if (condition.type === 'state-is' || condition.type === 'state-compare') {
      row.append(
        controls.select(
          'State field',
          JSON.stringify(condition.path),
          (view.rules?.state ?? []).map(
            (field) => [JSON.stringify(field.path), field.path.join('.')] as const,
          ),
          (value) => {
            condition.path = JSON.parse(value)
            render()
          },
        ),
      )

      if (condition.type === 'state-is') {
        const field = view.rules?.state.find(
          (field) => JSON.stringify(field.path) === JSON.stringify(condition.path),
        )

        row.append(
          controls.input('Expected value', String(condition.value), (value) => {
            condition.value =
              typeof field?.value === 'boolean'
                ? value === 'true'
                : typeof field?.value === 'number'
                  ? Number(value)
                  : value
          }),
        )
      } else
        row.append(
          controls.select(
            'Comparison',
            condition.operator,
            labelled(['eq', 'gte', 'lte', 'gt', 'lt'] as const, comparisonLabels),
            (value) => {
              condition.operator = value
            },
          ),
          controls.input(
            'Required amount',
            String(condition.value),
            (value) => {
              condition.value = Number(value)
            },
            'number',
          ),
        )
    }

    if (condition.type === 'item-carried-by' || condition.type === 'item-owned-by')
      row.append(
        controls.input('Item instance ID', condition.item, (value) => {
          condition.item = value
        }),
        controls.select(
          'Item owner',
          condition.owner,
          Object.keys(view.inventory?.owners ?? {}),
          (value) => {
            condition.owner = value
          },
        ),
      )

    if (condition.type === 'quest-state')
      row.append(
        controls.select('Quest', condition.quest, questChoices(view), (value) => {
          condition.quest = value
        }),
        controls.select(
          'Quest status',
          condition.status,
          labelled(['not-started', 'active', 'ready', 'completed'] as const, questStatusLabels),
          (value) => {
            condition.status = value
          },
        ),
        controls.input('Optional stage ID', condition.stage ?? '', (value) => {
          condition.stage = value || undefined
        }),
      )

    if (condition.type === 'combat-outcome')
      row.append(
        controls.select(
          'Encounter',
          condition.encounter,
          Object.keys(view.combat ?? {}),
          (value) => {
            condition.encounter = value
          },
        ),
        controls.select(
          'Outcome',
          condition.outcome,
          labelled(['victory', 'defeat', 'escaped'] as const, combatOutcomeLabels),
          (value) => {
            condition.outcome = value
          },
        ),
      )
    row.append(
      controls.button('Remove condition', () => {
        conditions.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    root.append(row)
  }

  root.append(
    controls.button('Add condition', () => {
      conditions.push({
        type: 'state-is',
        path: view.rules?.state[0]?.path ?? ['flag'],
        value: false,
      })
      controls.markEdited()
      render()
    }),
  )

  return root
}

function textField(
  controls: RuleFormControls,
  view: ProjectView,
  title: string,
  value: RuleText,
  update: (value: RuleText) => void,
  render: () => void,
): HTMLElement {
  return controls.group(
    title,
    ...ruleValueControls(
      controls,
      title,
      value,
      translationChoices(view),
      (value) => {
        if (typeof value === 'string' || typeof value === 'object') update(value)
      },
      render,
      ['text', 'translation'],
    ),
  )
}

function effectsForm(
  controls: RuleFormControls,
  view: ProjectView,
  effects: StoryEffect[],
  render: () => void,
): HTMLElement {
  const root = controls.group('Choice effects (committed together)')
  effects.forEach((effect, index) => {
    const row = controls.group(`Effect ${index + 1}`)
    row.append(
      controls.select(
        'Effect type',
        effect.type,
        labelled(
          ['set-state', 'append-log', 'start-quest', 'complete-quest'] as const,
          effectTypeLabels,
        ),
        (type) => {
          effects[index] =
            type === 'set-state'
              ? { type, path: view.rules?.state[0]?.path ?? ['flag'], value: false }
              : type === 'append-log'
                ? { type, text: '' }
                : {
                    type: type === 'start-quest' ? 'start-quest' : 'complete-quest',
                    quest: Object.keys(view.quests ?? {})[0] ?? '',
                  }
          render()
        },
      ),
    )

    if (effect.type === 'start-quest' || effect.type === 'complete-quest')
      row.append(
        controls.select('Effect quest', effect.quest, questChoices(view), (value) => {
          effect.quest = value
        }),
      )
    else if (effect.type === 'append-log')
      row.append(
        textField(
          controls,
          view,
          'Log entry',
          effect.text,
          (value) => {
            effect.text = value
          },
          render,
        ),
      )
    else
      row.append(
        controls.select(
          'Effect state field',
          JSON.stringify(effect.path),
          (view.rules?.state ?? []).map(
            (field) => [JSON.stringify(field.path), field.path.join('.')] as const,
          ),
          (value) => {
            effect.path = JSON.parse(value)
          },
        ),
        ...ruleValueControls(
          controls,
          'New value',
          effect.value,
          translationChoices(view),
          (value) => {
            effect.value = value
          },
          render,
        ),
      )
    row.append(
      controls.button('Remove effect', () => {
        effects.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    root.append(row)
  })
  root.append(
    controls.button('Add effect', () => {
      effects.push({ type: 'start-quest', quest: Object.keys(view.quests ?? {})[0] ?? '' })
      controls.markEdited()
      render()
    }),
  )

  return root
}

function lineBindings(
  controls: RuleFormControls,
  view: ProjectView,
  bindings: TextBindingsDefinition,
  render: () => void,
): HTMLElement {
  const root = controls.group('Captured text bindings')

  for (const [alias, binding] of Object.entries(bindings))
    root.append(
      controls.group(
        alias,
        controls.select(
          'Binding source',
          binding.source,
          ['game.state', 'game.progression', 'game.leveling', 'game.combatStats', 'game.quests'],
          (value) => {
            binding.source = value
          },
        ),
        controls.input('Binding path', binding.path.join('.'), (value) => {
          binding.path = value.split('.')
        }),
        controls.input('Missing value fallback', binding.fallback ?? '', (value) => {
          binding.fallback = value || undefined
        }),
        controls.button('Remove text binding', () => {
          delete bindings[alias]
          controls.markEdited()
          render()
        }),
      ),
    )
  let alias = ''
  root.append(
    controls.input('New binding alias', '', (value) => {
      alias = value
    }),
    controls.button('Add text binding', () => {
      if (!alias || Object.hasOwn(bindings, alias)) return
      bindings[alias] = { source: 'game.state', path: view.rules?.state[0]?.path ?? ['flag'] }
      controls.markEdited()
      render()
    }),
  )

  return root
}

/** Open or closed state per node or choice, kept across redraws of the same draft. */
type DialogueNode = DialogueDefinition['nodes'][string]

type Foldable = DialogueNode | DialogueNode['choices'][number]

const folds = new WeakMap<Foldable, boolean>()

function fold(
  controls: RuleFormControls,
  key: Foldable,
  summary: string,
  openByDefault: boolean,
  ...children: HTMLElement[]
): HTMLElement {
  const details = controls.create('details')
  const title = controls.create('summary')
  title.textContent = summary
  details.open = folds.get(key) ?? openByDefault
  details.append(title, ...children)
  details.addEventListener('toggle', () => folds.set(key, details.open))

  return details
}

const count = (amount: number, single: string, plural: string) =>
  `${amount} ${amount === 1 ? single : plural}`

export function dialogueForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: DialogueDefinition,
  render: () => void,
): HTMLElement[] {
  const root = controls.group('Dialogue nodes')

  for (const [id, node] of Object.entries(draft.nodes)) {
    const section = controls.group(`Node ${id}`)
    section.append(
      controls.select('Terminal node', String(node.terminal), yesNoChoices, (value) => {
        node.terminal = value === 'true'
      }),
      controls.button('Remove node', () => {
        delete draft.nodes[id]
        controls.markEdited()
        render()
      }),
    )
    node.lines.forEach((line, index) =>
      section.append(
        controls.group(
          `Line ${index + 1}`,
          textField(
            controls,
            view,
            'Speaker',
            line.speaker ?? '',
            (value) => {
              line.speaker = value
            },
            render,
          ),
          textField(
            controls,
            view,
            'Dialogue text',
            line.text,
            (value) => {
              line.text = value
            },
            render,
          ),
          line.bindings
            ? lineBindings(controls, view, line.bindings, render)
            : controls.button('Add line text bindings', () => {
                line.bindings = {}
                controls.markEdited()
                render()
              }),
          controls.button('Remove line', () => {
            node.lines.splice(index, 1)
            controls.markEdited()
            render()
          }),
        ),
      ),
    )
    section.append(
      controls.button('Add line', () => {
        node.lines.push({ text: '' })
        controls.markEdited()
        render()
      }),
    )
    node.choices.forEach((choice, index) => {
      const box = controls.group(`Choice ${index + 1}`)
      box.append(
        controls.input('Choice ID', choice.id, (value) => {
          choice.id = value
        }),
        ...storyPresentation(controls, view, choice),
        controls.select(
          'Choice destination',
          choice.end ? '__end' : (choice.next ?? ''),
          [['__end', 'End conversation'], ...Object.keys(draft.nodes)],
          (value) => {
            choice.end = value === '__end'
            choice.next = choice.end ? undefined : value
          },
        ),
        controls.select(
          'Scene after ending',
          choice.scene ?? '',
          [['', 'Stay in the current scene'], ...sceneChoices(view, 'game')],
          (value) => {
            choice.scene = value || undefined
          },
        ),
        // Conditions and effects fold away so a node's choices can be scanned.
        fold(
          controls,
          choice,
          `Conditions and effects · ${count(
            choice.visibleWhen.length + choice.when.length,
            'condition',
            'conditions',
          )}, ${count(choice.effects.length, 'effect', 'effects')}`,
          false,
          textField(
            controls,
            view,
            'Unavailable explanation',
            choice.unavailableText ?? '',
            (value) => {
              choice.unavailableText = value
            },
            render,
          ),
          storyConditions(controls, view, 'Visible when (all)', choice.visibleWhen, render),
          storyConditions(controls, view, 'Enabled when (all)', choice.when, render),
          effectsForm(controls, view, choice.effects, render),
        ),
        controls.button(
          'Move choice earlier',
          () => {
            if (index) {
              node.choices.splice(index, 1)
              node.choices.splice(index - 1, 0, choice)
              controls.markEdited()
              render()
            }
          },
          index === 0,
        ),
        controls.button('Remove choice', () => {
          node.choices.splice(index, 1)
          controls.markEdited()
          render()
        }),
      )
      section.append(box)
    })
    section.append(
      controls.button('Add choice', () => {
        let number = node.choices.length + 1

        while (node.choices.some((choice) => choice.id === `choice-${number}`)) number++
        node.choices.push(
          dialogueChoiceSchema.parse({ id: `choice-${number}`, label: 'Reply', end: true }),
        )
        controls.markEdited()
        render()
      }),
    )
    const start = id === draft.entry ? ' · start' : ''
    root.append(
      fold(
        controls,
        node,
        `Node ${id}${start} · ${count(node.lines.length, 'line', 'lines')}, ${count(
          node.choices.length,
          'choice',
          'choices',
        )}`,
        id === draft.entry,
        section,
      ),
    )
  }

  let id = ''
  root.append(
    controls.input('New node ID', '', (value) => {
      id = value
    }),
    controls.button('Add node', () => {
      if (!id || Object.hasOwn(draft.nodes, id)) return
      draft.nodes[id] = dialogueNodeSchema.parse({})
      controls.markEdited()
      render()
    }),
  )

  return [
    ...storyPresentation(controls, view, draft),
    controls.select('Entry node', draft.entry, Object.keys(draft.nodes), (value) => {
      draft.entry = value
    }),
    controls.input(
      'Transcript capacity',
      String(draft.transcriptCapacity),
      (value) => {
        draft.transcriptCapacity = Number(value)
      },
      'number',
    ),
    root,
  ]
}

export function questForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: QuestDefinition,
  render: () => void,
): HTMLElement[] {
  const stages = controls.group('Ordered stages')
  draft.stages.forEach((stage, index) => {
    const box = controls.group(`Stage ${index + 1}`)
    box.append(
      controls.input('Stage ID', stage.id, (value) => {
        stage.id = value
      }),
      ...storyPresentation(controls, view, stage),
    )
    stage.objectives.forEach((objective, objectiveIndex) => {
      const row = controls.group(`Objective ${objectiveIndex + 1}`)
      row.append(
        controls.input('Objective ID', objective.id, (value) => {
          objective.id = value
        }),
        ...storyPresentation(controls, view, objective),
        storyConditions(controls, view, 'Objective conditions (all)', objective.when, render),
        controls.select(
          'Numeric progress field',
          objective.progress ? JSON.stringify(objective.progress.binding) : '',
          [
            ['', 'No progress counter'],
            ...(view.rules?.state ?? [])
              .filter((field) => typeof field.value === 'number')
              .map(
                (field) =>
                  [
                    JSON.stringify({ source: 'game.state', path: field.path }),
                    field.path.join('.'),
                  ] as const,
              ),
          ],
          (value) => {
            objective.progress = value
              ? { binding: JSON.parse(value), target: objective.progress?.target ?? 1 }
              : undefined
            render()
          },
        ),
      )

      if (objective.progress) {
        const progress = objective.progress
        row.append(
          controls.input(
            'Progress target',
            String(progress.target),
            (value) => {
              progress.target = Number(value)
            },
            'number',
          ),
        )
      }

      row.append(
        controls.button('Remove objective', () => {
          stage.objectives.splice(objectiveIndex, 1)
          controls.markEdited()
          render()
        }),
      )
      box.append(row)
    })
    box.append(
      controls.button('Add objective', () => {
        stage.objectives.push(
          questObjectiveSchema.parse({
            id: `objective-${draft.stages.flatMap((entry) => entry.objectives).length + 1}`,
            label: 'Objective',
            when: [{ type: 'state-is', path: view.rules?.state[0]?.path ?? ['flag'], value: true }],
          }),
        )
        controls.markEdited()
        render()
      }),
      controls.button(
        'Move stage earlier',
        () => {
          if (index) {
            draft.stages.splice(index, 1)
            draft.stages.splice(index - 1, 0, stage)
            controls.markEdited()
            render()
          }
        },
        index === 0,
      ),
      controls.button('Remove stage', () => {
        draft.stages.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    stages.append(box)
  })
  stages.append(
    controls.button('Add stage', () => {
      draft.stages.push({
        id: `stage-${draft.stages.length + 1}`,
        label: 'Stage',
        description: '',
        objectives: [],
      })
      controls.markEdited()
      render()
    }),
  )
  const handIns = controls.group('Exact item hand-ins')
  draft.handIns.forEach((entry, index) => {
    const row = controls.group(`Hand-in ${index + 1}`)
    row.append(
      controls.input('Hand-in item instance', entry.item, (value) => {
        entry.item = value
      }),
      controls.select(
        'Required owner',
        entry.owner,
        Object.keys(view.inventory?.owners ?? {}),
        (value) => {
          entry.owner = value
        },
      ),
      controls.select('Hand-in operation', entry.operation, ['consume', 'transfer'], (value) => {
        entry.operation = value
        entry.recipient =
          value === 'transfer'
            ? Object.keys(view.inventory?.owners ?? {}).find((owner) => owner !== entry.owner)
            : undefined
        render()
      }),
    )

    if (entry.operation === 'transfer')
      row.append(
        controls.select(
          'Recipient owner',
          entry.recipient ?? '',
          Object.keys(view.inventory?.owners ?? {}),
          (value) => {
            entry.recipient = value
          },
        ),
      )
    row.append(
      controls.button('Remove hand-in', () => {
        draft.handIns.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    handIns.append(row)
  })
  handIns.append(
    controls.button('Add hand-in', () => {
      draft.handIns.push({
        item: Object.keys(view.inventory?.items ?? {})[0] ?? '',
        owner: Object.keys(view.inventory?.owners ?? {})[0] ?? '',
        operation: 'consume',
      })
      controls.markEdited()
      render()
    }),
  )
  const rewards = controls.group('Guaranteed rewards')
  rewards.append(
    controls.select(
      'Reward item recipient',
      draft.rewards.recipient ?? '',
      ['', ...Object.keys(view.inventory?.owners ?? {})],
      (value) => {
        draft.rewards.recipient = value || undefined
      },
    ),
  )
  draft.rewards.numeric.forEach((entry, index) =>
    rewards.append(
      controls.group(
        `Numeric reward ${index + 1}`,
        controls.input('Reward ID', entry.id, (value) => {
          entry.id = value
        }),
        controls.input('Reward label', entry.label, (value) => {
          entry.label = value
        }),
        controls.translation(
          'Reward label translation',
          entry.labelKey ?? '',
          translationChoices(view),
          (value) => {
            entry.labelKey = value || undefined
          },
        ),
        controls.select(
          'Reward field',
          JSON.stringify(entry.field.path),
          (view.rules?.state ?? [])
            .filter((field) => typeof field.value === 'number')
            .map((field) => [JSON.stringify(field.path), field.path.join('.')] as const),
          (value) => {
            entry.field.path = JSON.parse(value)
          },
        ),
        controls.input(
          'Reward amount',
          String(entry.amount),
          (value) => {
            entry.amount = Number(value)
          },
          'number',
        ),
        controls.button('Remove numeric reward', () => {
          draft.rewards.numeric.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    ),
  )
  rewards.append(
    controls.button('Add numeric reward', () => {
      draft.rewards.numeric.push({
        id: `reward-${draft.rewards.numeric.length + 1}`,
        label: 'Reward',
        field: {
          source: 'game.state',
          path: view.rules?.state.find((field) => typeof field.value === 'number')?.path ?? [
            'gold',
          ],
        },
        amount: 1,
      })
      controls.markEdited()
      render()
    }),
  )
  draft.rewards.items.forEach((entry, index) => {
    const row = controls.group(`Item reward ${index + 1}`)
    row.append(
      controls.input('Item reward ID', entry.id, (value) => {
        entry.id = value
      }),
      controls.select(
        'Reward item type',
        entry.itemType,
        Object.keys(view.inventory?.itemTypes ?? {}),
        (value) => {
          entry.itemType = value
        },
      ),
    )

    for (const [channel, color] of Object.entries(entry.colors))
      row.append(
        controls.input(`Dye ${channel}`, color, (value) => {
          entry.colors[channel] = value
        }),
        controls.button(`Remove dye ${channel}`, () => {
          delete entry.colors[channel]
          controls.markEdited()
          render()
        }),
      )
    let channel = ''
    row.append(
      controls.input('New dye channel', '', (value) => {
        channel = value
      }),
      controls.button('Add dye', () => {
        if (channel) {
          entry.colors[channel] = '#4488ff'
          controls.markEdited()
          render()
        }
      }),
      controls.button('Remove item reward', () => {
        draft.rewards.items.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    rewards.append(row)
  })
  rewards.append(
    controls.button('Add item reward', () => {
      draft.rewards.items.push({
        id: `item-${draft.rewards.items.length + 1}`,
        itemType: Object.keys(view.inventory?.itemTypes ?? {})[0] ?? '',
        colors: {},
      })
      controls.markEdited()
      render()
    }),
  )

  return [
    ...storyPresentation(controls, view, draft),
    storyConditions(controls, view, 'Can start when', draft.when, render),
    storyConditions(controls, view, 'Can turn in when', draft.turnInWhen, render),
    stages,
    handIns,
    rewards,
  ]
}
