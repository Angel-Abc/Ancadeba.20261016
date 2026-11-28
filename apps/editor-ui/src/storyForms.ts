import type { Translate } from '@ancadeba/utilities'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  dialogueNodeSchema,
  dialogueChoiceSchema,
  questOutcomeSchema,
  questObjectiveSchema,
  ruleStateType,
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
  questOutcomeChoices,
  questStatusLabels,
  sceneChoices,
} from './choiceLabels.js'

import { entryEditor, fieldPath, type EntrySelections } from './specialistEntries.js'

type StoryControls = RuleFormControls & { arrange: (parent: HTMLElement) => void }

type Presentation = Pick<QuestDefinition, 'label' | 'labelKey' | 'description' | 'descriptionKey'>

function presentationName(view: ProjectView, data: Presentation & { id: string }) {
  return (data.labelKey && view.translations?.[data.labelKey]) || data.label || data.id
}

function storyPresentation(
  controls: StoryControls,
  view: ProjectView,
  draft: Presentation,
  path: (string | number)[],
  name = controls.t('form.name'),
): HTMLElement[] {
  const keys = translationChoices(view, controls.t('metadata.literalText'))

  return (['label', 'description'] as const).map((property) => {
    const key = property === 'label' ? 'labelKey' : 'descriptionKey'
    const title = property === 'label' ? name : controls.t('metadata.description')
    const box = fieldPath(controls.create('div'), ...path, property)
    box.append(
      controls.input(title, draft[property], (value) => {
        draft[property] = value
      }),
      controls.translation(
        controls.t(property === 'label' ? 'form.nameTranslation' : 'form.descriptionTranslation'),
        draft[key] ?? '',
        keys,
        (value) => {
          draft[key] = value || undefined
        },
      ),
    )
    controls.arrange(box)

    return box
  })
}

function unusedId(prefix: string, used: { id: string }[]) {
  let number = used.length + 1

  while (used.some((entry) => entry.id === prefix + number)) number++

  return prefix + number
}

function wording(view: ProjectView, value: RuleText) {
  return typeof value === 'string' ? value : view.translations?.[value.textKey] || value.textKey
}

export function storyConditions(
  controls: RuleFormControls,
  view: ProjectView,
  label: string,
  conditions: WorldCondition[],
  render: () => void,
): HTMLElement {
  const { t } = controls
  const root = controls.group(label)

  for (const [index, condition] of conditions.entries()) {
    const row = controls.group(t('form.conditionNumber', { number: index + 1 }))
    row.append(
      controls.select(
        t('story.conditionType'),
        condition.type,
        labelled(
          [
            'scene-is',
            'state-is',
            'state-compare',
            'item-carried-by',
            'item-owned-by',
            'quest-state',
            'quest-outcome',
            'combat-outcome',
          ] as const,
          conditionTypeLabels,
          t,
        ),
        (type) => {
          conditions[index] =
            type === 'scene-is'
              ? { type, scene: view.scenes[0]?.id ?? '' }
              : type === 'quest-outcome'
                ? { type, quest: Object.keys(view.quests ?? {})[0] ?? '', outcome: '' }
                : type === 'quest-state'
                  ? { type, quest: Object.keys(view.quests ?? {})[0] ?? '', status: 'completed' }
                  : type === 'combat-outcome'
                    ? {
                        type,
                        encounter: Object.keys(view.combat ?? {})[0] ?? '',
                        outcome: 'victory',
                      }
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
        controls.select(t('scene.label'), condition.scene, sceneChoices(view), (value) => {
          condition.scene = value
        }),
      )

    if (condition.type === 'state-is' || condition.type === 'state-compare') {
      row.append(
        controls.select(
          t('form.stateField'),
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

        const type = field && ruleStateType(field)

        row.append(
          controls.input(t('story.expectedValue'), String(condition.value), (value) => {
            condition.value =
              type === 'boolean' ? value === 'true' : type === 'number' ? Number(value) : value
          }),
        )
      } else
        row.append(
          controls.select(
            t('form.comparison'),
            condition.operator,
            labelled(['eq', 'gte', 'lte', 'gt', 'lt'] as const, comparisonLabels, t),
            (value) => {
              condition.operator = value
            },
          ),
          controls.input(
            t('form.requiredAmount'),
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
        controls.input(t('story.itemInstanceId'), condition.item, (value) => {
          condition.item = value
        }),
        controls.select(
          t('story.itemOwner'),
          condition.owner,
          Object.keys(view.inventory?.owners ?? {}),
          (value) => {
            condition.owner = value
          },
        ),
      )

    if (condition.type === 'quest-outcome')
      row.append(
        controls.select(t('form.quest'), condition.quest, questChoices(view), (quest) => {
          condition.quest = quest
          condition.outcome = ''
          render()
        }),
        controls.select(
          t('story.outcome'),
          condition.outcome,
          questOutcomeChoices(view, condition.quest),
          (id) => {
            condition.outcome = id
          },
        ),
      )

    if (condition.type === 'quest-state')
      row.append(
        controls.select(t('form.quest'), condition.quest, questChoices(view), (value) => {
          condition.quest = value
        }),
        controls.select(
          t('form.questStatus'),
          condition.status,
          labelled(['not-started', 'active', 'ready', 'completed'] as const, questStatusLabels, t),
          (value) => {
            condition.status = value
          },
        ),
        controls.input(t('form.optionalStageId'), condition.stage ?? '', (value) => {
          condition.stage = value || undefined
        }),
      )

    if (condition.type === 'combat-outcome')
      row.append(
        controls.select(
          t('form.encounter'),
          condition.encounter,
          Object.keys(view.combat ?? {}),
          (value) => {
            condition.encounter = value
          },
        ),
        controls.select(
          t('form.outcome'),
          condition.outcome,
          labelled(['victory', 'defeat', 'escaped'] as const, combatOutcomeLabels, t),
          (value) => {
            condition.outcome = value
          },
        ),
      )
    row.append(
      controls.button(t('form.removeCondition'), () => {
        conditions.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    root.append(row)
  }

  root.append(
    controls.button(t('form.addCondition'), () => {
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
  controls: StoryControls,
  view: ProjectView,
  title: string,
  value: RuleText,
  update: (value: RuleText) => void,
  render: () => void,
): HTMLElement {
  const [mode, field] = ruleValueControls(
    controls,
    title,
    value,
    translationChoices(view),
    (next) => {
      if (typeof next === 'string' || typeof next === 'object') update(next)
    },
    render,
    ['text', 'translation'],
  )

  const box = controls.create('div')
  box.append(field!)
  controls.arrange(box)
  // Keep the choice of literal or catalog wording secondary to the wording itself.
  const settings = box.querySelector('details')

  if (settings) settings.append(mode!)
  else box.append(controls.fold('mode/' + title, controls.t('form.valueType'), false, mode!))

  return box
}

function effectsForm(
  controls: StoryControls,
  view: ProjectView,
  effects: StoryEffect[],
  render: () => void,
): HTMLElement {
  const { t } = controls
  const root = controls.group(t('story.choiceEffects'))
  effects.forEach((effect, index) => {
    const row = controls.group(t('form.effectNumber', { number: index + 1 }))
    row.append(
      controls.select(
        t('form.effectType'),
        effect.type,
        labelled(
          ['set-state', 'append-log', 'start-quest', 'complete-quest'] as const,
          effectTypeLabels,
          t,
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

    if (effect.type === 'start-quest' || effect.type === 'complete-quest') {
      row.append(
        controls.select(t('story.effectQuest'), effect.quest, questChoices(view), (value) => {
          effect.quest = value

          if (effect.type === 'complete-quest') delete effect.outcome
          render()
        }),
      )

      if (effect.type === 'complete-quest' && view.quests?.[effect.quest]?.outcomes.length)
        row.append(
          controls.select(
            t('story.outcome'),
            effect.outcome ?? '',
            questOutcomeChoices(view, effect.quest),
            (id) => {
              effect.outcome = id || undefined
            },
          ),
        )
    } else if (effect.type === 'append-log')
      row.append(
        textField(
          controls,
          view,
          t('story.logEntry'),
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
          t('story.effectStateField'),
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
          t('story.newValue'),
          effect.value,
          translationChoices(view),
          (value) => {
            effect.value = value
          },
          render,
        ),
      )
    row.append(
      controls.button(t('form.removeEffect'), () => {
        effects.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    root.append(row)
  })
  root.append(
    controls.button(t('form.addEffect'), () => {
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
  const { t } = controls
  const root = controls.group(t('story.capturedBindings'))

  for (const [alias, binding] of Object.entries(bindings))
    root.append(
      controls.group(
        alias,
        controls.select(
          t('bindings.sourceLabel'),
          binding.source,
          ['game.state', 'game.progression', 'game.leveling', 'game.combatStats', 'game.quests'],
          (value) => {
            binding.source = value
          },
        ),
        controls.input(t('form.bindingPath'), binding.path.join('.'), (value) => {
          binding.path = value.split('.')
        }),
        controls.input(t('story.fallback'), binding.fallback ?? '', (value) => {
          binding.fallback = value || undefined
        }),
        controls.button(t('story.removeBinding'), () => {
          delete bindings[alias]
          controls.markEdited()
          render()
        }),
      ),
    )
  let alias = ''
  root.append(
    controls.input(t('story.newAlias'), '', (value) => {
      alias = value
    }),
    controls.button(t('form.addTextBinding'), () => {
      if (!alias || Object.hasOwn(bindings, alias)) return
      bindings[alias] = { source: 'game.state', path: view.rules?.state[0]?.path ?? ['flag'] }
      controls.markEdited()
      render()
    }),
  )

  return root
}

/** Singular and plural have their own messages, so counts read naturally in every language. */
const count = (t: Translate, amount: number, kind: 'line' | 'choice' | 'condition' | 'effect') =>
  amount === 1 ? t(`story.count.${kind}`) : t(`story.count.${kind}s`, { count: amount })

export function dialogueForm(
  controls: StoryControls,
  view: ProjectView,
  draft: DialogueDefinition,
  render: () => void,
  selected: EntrySelections,
  identity: HTMLElement,
): HTMLElement[] {
  const { t } = controls
  const ids = Object.keys(draft.nodes)
  const root = controls.create('div')
  root.append(
    entryEditor(
      controls,
      selected,
      'nodes',
      t('story.nodes'),
      ids,
      (id) => {
        const line = draft.nodes[id]?.lines[0]

        return line ? id + ' · ' + wording(view, line.text) : id
      },
      (id) => {
        const node = draft.nodes[id]!
        const section = controls.create('div')
        const linesKey = 'lines/' + id
        const choicesKey = 'choices/' + id

        const lineFields = (line: (typeof node.lines)[number], index: number) => {
          const path = ['nodes', id, 'lines', index]
          const box = fieldPath(controls.create('div'), ...path)
          box.append(
            fieldPath(
              textField(
                controls,
                view,
                t('story.speaker'),
                line.speaker ?? '',
                (value) => {
                  line.speaker = value
                },
                render,
              ),
              ...path,
              'speaker',
            ),
            fieldPath(
              textField(
                controls,
                view,
                t('story.dialogueText'),
                line.text,
                (value) => {
                  line.text = value
                },
                render,
              ),
              ...path,
              'text',
            ),
            line.bindings
              ? controls.section(
                  'bindings/' + id + '/' + index,
                  lineBindings(controls, view, line.bindings, render),
                )
              : controls.button(t('story.addLineBindings'), () => {
                  line.bindings = {}
                  controls.markEdited()
                  render()
                }),
            controls.button(t('story.removeLine'), () => {
              node.lines.splice(index, 1)
              controls.markEdited()
              render()
            }),
          )

          return box
        }

        section.append(
          node.lines.length === 1
            ? lineFields(node.lines[0]!, 0)
            : entryEditor(
                controls,
                selected,
                linesKey,
                t('specialist.lines'),
                node.lines,
                (line, i) => wording(view, line.text) || t('story.line', { number: i + 1 }),
                lineFields,
                { path: ['nodes', id, 'lines'] },
              ),
          controls.button(t('story.addLine'), () => {
            selected[linesKey] = node.lines.length
            node.lines.push({ text: '' })
            controls.markEdited()
            render()
          }),
          entryEditor(
            controls,
            selected,
            choicesKey,
            t('specialist.choices'),
            node.choices,
            (choice) => presentationName(view, choice),
            (choice, index) => {
              const choicePath = ['nodes', id, 'choices', index]
              const box = controls.group(t('story.choice', { number: index + 1 }))
              box.append(
                ...storyPresentation(
                  controls,
                  view,
                  choice,
                  choicePath,
                  t('specialist.choiceName'),
                ),
                fieldPath(
                  controls.input(t('story.choiceId'), choice.id, (value) => {
                    choice.id = value
                  }),
                  ...choicePath,
                  'id',
                ),
                fieldPath(
                  controls.select(
                    t('story.choiceDestination'),
                    choice.end ? '__end' : (choice.next ?? ''),
                    [['__end', t('story.endConversation')], ...Object.keys(draft.nodes)],
                    (value) => {
                      choice.end = value === '__end'
                      choice.next = choice.end ? undefined : value
                    },
                  ),
                  ...choicePath,
                  'next',
                ),
                controls.select(
                  t('story.sceneAfter'),
                  choice.scene ?? '',
                  [['', t('story.stayInScene')], ...sceneChoices(view, 'game')],
                  (value) => {
                    choice.scene = value || undefined
                  },
                ),
                // Conditions and effects fold away so a node's choices can be scanned.
                controls.fold(
                  `dialogue:${draft.id}/node:${id}/choice:${index}`,
                  t('story.conditionsAndEffects', {
                    conditions: count(
                      t,
                      choice.visibleWhen.length + choice.when.length,
                      'condition',
                    ),
                    effects: count(t, choice.effects.length, 'effect'),
                  }),
                  false,
                  textField(
                    controls,
                    view,
                    t('story.unavailable'),
                    choice.unavailableText ?? '',
                    (value) => {
                      choice.unavailableText = value
                    },
                    render,
                  ),
                  storyConditions(
                    controls,
                    view,
                    t('story.visibleWhen'),
                    choice.visibleWhen,
                    render,
                  ),
                  storyConditions(controls, view, t('story.enabledWhen'), choice.when, render),
                  effectsForm(controls, view, choice.effects, render),
                ),
                controls.button(
                  t('story.moveChoiceEarlier'),
                  () => {
                    if (index) {
                      node.choices.splice(index, 1)
                      node.choices.splice(index - 1, 0, choice)
                      selected[choicesKey] = index - 1
                      controls.markEdited()
                      render()
                    }
                  },
                  index === 0,
                ),
                controls.button(t('story.removeChoice'), () => {
                  node.choices.splice(index, 1)
                  controls.markEdited()
                  render()
                }),
              )

              return fieldPath(box, ...choicePath)
            },
            { path: ['nodes', id, 'choices'] },
          ),
          controls.button(t('story.addChoice'), () => {
            let number = node.choices.length + 1

            while (node.choices.some((choice) => choice.id === 'choice-' + number)) number++
            selected[choicesKey] = node.choices.length
            node.choices.push(
              dialogueChoiceSchema.parse({ id: 'choice-' + number, label: 'Reply', end: true }),
            )
            controls.markEdited()
            render()
          }),
          controls.select(t('story.terminal'), String(node.terminal), yesNoChoices(t), (value) => {
            node.terminal = value === 'true'
          }),
          controls.button(t('story.removeNode'), () => {
            delete draft.nodes[id]
            controls.markEdited()
            render()
          }),
        )

        return fieldPath(section, 'nodes', id)
      },
      { initial: ids.indexOf(draft.entry), path: ['nodes'], ids },
    ),
  )
  let newId = ''
  root.append(
    controls.fold(
      'new-node',
      t('specialist.newNode'),
      false,
      controls.input(t('story.newNodeId'), '', (value) => {
        newId = value
      }),
      controls.button(t('story.addNode'), () => {
        if (!newId || Object.hasOwn(draft.nodes, newId)) return
        Object.defineProperty(draft.nodes, newId, {
          value: dialogueNodeSchema.parse({}),
          writable: true,
          enumerable: true,
          configurable: true,
        })
        selected.nodes = Object.keys(draft.nodes).indexOf(newId)
        controls.markEdited()
        render()
      }),
    ),
  )

  return [
    root,
    controls.fold(
      'metadata',
      t('specialist.metadata'),
      false,
      identity,
      ...storyPresentation(controls, view, draft, []),
      fieldPath(
        controls.select(t('story.entryNode'), draft.entry, ids, (value) => {
          draft.entry = value
        }),
        'entry',
      ),
      fieldPath(
        controls.input(
          t('story.transcriptCapacity'),
          String(draft.transcriptCapacity),
          (value) => {
            draft.transcriptCapacity = Number(value)
          },
          'number',
        ),
        'transcriptCapacity',
      ),
    ),
  ]
}

export function questForm(
  controls: StoryControls,
  view: ProjectView,
  draft: QuestDefinition,
  render: () => void,
  selected: EntrySelections,
  identity: HTMLElement,
): HTMLElement[] {
  const { t } = controls
  const stages = controls.create('div')
  stages.append(
    entryEditor(
      controls,
      selected,
      'stages',
      t('story.stages'),
      draft.stages,
      (stage) => presentationName(view, stage),
      (stage, index) => {
        const stagePath = ['stages', index]
        const box = controls.group(t('story.stage', { number: index + 1 }))
        box.append(
          ...storyPresentation(controls, view, stage, stagePath, t('specialist.stageName')),
          fieldPath(
            controls.input(t('story.stageId'), stage.id, (value) => {
              selected['objectives/' + value] = selected['objectives/' + stage.id] ?? 0
              stage.id = value
            }),
            ...stagePath,
            'id',
          ),
        )
        const objectivesKey = 'objectives/' + stage.id
        box.append(
          entryEditor(
            controls,
            selected,
            objectivesKey,
            t('specialist.objectives'),
            stage.objectives,
            (objective) => presentationName(view, objective),
            (objective, objectiveIndex) => {
              const objectivePath = [...stagePath, 'objectives', objectiveIndex]
              const row = controls.group(t('story.objective', { number: objectiveIndex + 1 }))
              row.append(
                ...storyPresentation(
                  controls,
                  view,
                  objective,
                  objectivePath,
                  t('specialist.objectiveName'),
                ),
                fieldPath(
                  controls.input(t('story.objectiveId'), objective.id, (value) => {
                    objective.id = value
                  }),
                  ...objectivePath,
                  'id',
                ),
                fieldPath(
                  storyConditions(
                    controls,
                    view,
                    t('story.objectiveConditions'),
                    objective.when,
                    render,
                  ),
                  ...objectivePath,
                  'when',
                ),
                controls.select(
                  t('story.progressField'),
                  objective.progress ? JSON.stringify(objective.progress.binding) : '',
                  [
                    ['', t('story.noProgress')],
                    ...(view.rules?.state ?? [])
                      .filter((field) => ruleStateType(field) === 'number')
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
                  fieldPath(
                    controls.input(
                      t('story.progressTarget'),
                      String(progress.target),
                      (value) => {
                        progress.target = Number(value)
                      },
                      'number',
                    ),
                    ...objectivePath,
                    'progress',
                    'target',
                  ),
                )
              }

              row.append(
                controls.button(
                  t('specialist.moveObjective'),
                  () => {
                    stage.objectives.splice(
                      objectiveIndex - 1,
                      0,
                      ...stage.objectives.splice(objectiveIndex, 1),
                    )
                    selected[objectivesKey] = objectiveIndex - 1
                    controls.markEdited()
                    render()
                  },
                  objectiveIndex === 0,
                ),
                controls.button(t('story.removeObjective'), () => {
                  stage.objectives.splice(objectiveIndex, 1)
                  controls.markEdited()
                  render()
                }),
              )

              return fieldPath(row, ...objectivePath)
            },
            { path: [...stagePath, 'objectives'] },
          ),
        )
        box.append(
          controls.button(t('story.addObjective'), () => {
            selected[objectivesKey] = stage.objectives.length
            stage.objectives.push(
              questObjectiveSchema.parse({
                id: unusedId(
                  'objective-',
                  draft.stages.flatMap((stage) => stage.objectives),
                ),
                label: 'Objective',
                when: [
                  { type: 'state-is', path: view.rules?.state[0]?.path ?? ['flag'], value: true },
                ],
              }),
            )
            controls.markEdited()
            render()
          }),
          controls.button(
            t('story.moveStageEarlier'),
            () => {
              if (index) {
                draft.stages.splice(index, 1)
                draft.stages.splice(index - 1, 0, stage)
                selected.stages = index - 1
                controls.markEdited()
                render()
              }
            },
            index === 0,
          ),
          controls.button(t('story.removeStage'), () => {
            draft.stages.splice(index, 1)
            controls.markEdited()
            render()
          }),
        )

        return fieldPath(box, ...stagePath)
      },
      { path: ['stages'] },
    ),
  )
  stages.append(
    controls.button(t('story.addStage'), () => {
      selected.stages = draft.stages.length
      draft.stages.push({
        id: unusedId('stage-', draft.stages),
        label: 'Stage',
        description: '',
        objectives: [],
      })
      controls.markEdited()
      render()
    }),
  )
  const outcomes = controls.group(t('story.outcomes'))
  outcomes.append(
    entryEditor(
      controls,
      selected,
      'outcomes',
      t('story.outcome'),
      draft.outcomes,
      (outcome) => presentationName(view, outcome),
      (outcome, index) => {
        const path = ['outcomes', index]
        const box = controls.group(t('story.outcome'))
        box.append(
          controls.input(t('story.outcomeId'), outcome.id, (id) => {
            outcome.id = id
          }),
          ...storyPresentation(controls, view, outcome, path),
          storyConditions(controls, view, t('story.outcomeConditions'), outcome.when, render),
          textField(
            controls,
            view,
            t('story.outcomeUnavailable'),
            outcome.unavailableText ?? '',
            (value) => {
              outcome.unavailableText = value || undefined
            },
            render,
          ),
          ...settlementFields(controls, view, outcome, render, path),
          controls.button(t('story.removeOutcome'), () => {
            draft.outcomes.splice(index, 1)
            controls.markEdited()
            render()
          }),
        )

        return fieldPath(box, ...path)
      },
      { path: ['outcomes'] },
    ),
    controls.button(t('story.addOutcome'), () => {
      selected.outcomes = draft.outcomes.length
      draft.outcomes.push(
        questOutcomeSchema.parse({
          id: unusedId('outcome-', draft.outcomes),
          label: t('story.outcome'),
        }),
      )
      controls.markEdited()
      render()
    }),
  )

  return [
    stages,
    controls.fold(
      'metadata',
      t('specialist.metadata'),
      false,
      identity,
      ...storyPresentation(controls, view, draft, []),
    ),
    controls.section(
      'when',
      fieldPath(storyConditions(controls, view, t('story.canStart'), draft.when, render), 'when'),
    ),
    controls.section(
      'turnIn',
      fieldPath(
        storyConditions(controls, view, t('story.canTurnIn'), draft.turnInWhen, render),
        'turnInWhen',
      ),
    ),
    ...settlementFields(controls, view, draft, render, []),
    controls.section('outcomes', outcomes),
  ]
}

function settlementFields(
  controls: StoryControls,
  view: ProjectView,
  draft: Pick<QuestDefinition, 'handIns' | 'rewards'>,
  render: () => void,
  path: (string | number)[],
) {
  const { t } = controls
  const handIns = controls.group(t('story.handIns'))
  draft.handIns.forEach((entry, index) => {
    const row = controls.group(t('story.handIn', { number: index + 1 }))
    row.append(
      fieldPath(
        controls.input(t('story.handInItem'), entry.item, (value) => {
          entry.item = value
        }),
        ...path,
        'handIns',
        index,
        'item',
      ),
      controls.select(
        t('story.requiredOwner'),
        entry.owner,
        Object.keys(view.inventory?.owners ?? {}),
        (value) => {
          entry.owner = value
        },
      ),
      controls.select(
        t('story.handInOperation'),
        entry.operation,
        ['consume', 'transfer'],
        (value) => {
          entry.operation = value
          entry.recipient =
            value === 'transfer'
              ? Object.keys(view.inventory?.owners ?? {}).find((owner) => owner !== entry.owner)
              : undefined
          render()
        },
      ),
    )

    if (entry.operation === 'transfer')
      row.append(
        controls.select(
          t('story.recipientOwner'),
          entry.recipient ?? '',
          Object.keys(view.inventory?.owners ?? {}),
          (value) => {
            entry.recipient = value
          },
        ),
      )
    row.append(
      controls.button(t('story.removeHandIn'), () => {
        draft.handIns.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    handIns.append(row)
  })
  handIns.append(
    controls.button(t('story.addHandIn'), () => {
      draft.handIns.push({
        item: Object.keys(view.inventory?.items ?? {})[0] ?? '',
        owner: Object.keys(view.inventory?.owners ?? {})[0] ?? '',
        operation: 'consume',
      })
      controls.markEdited()
      render()
    }),
  )
  const rewards = controls.group(t('story.rewards'))
  rewards.append(
    controls.select(
      t('story.rewardRecipient'),
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
        t('form.numericReward', { number: index + 1 }),
        fieldPath(
          controls.input(t('story.rewardId'), entry.id, (value) => {
            entry.id = value
          }),
          ...path,
          'rewards',
          'numeric',
          index,
          'id',
        ),
        fieldPath(
          controls.input(t('story.rewardLabel'), entry.label, (value) => {
            entry.label = value
          }),
          ...path,
          'rewards',
          'numeric',
          index,
          'label',
        ),
        controls.translation(
          t('story.rewardLabelTranslation'),
          entry.labelKey ?? '',
          translationChoices(view),
          (value) => {
            entry.labelKey = value || undefined
          },
        ),
        controls.select(
          t('story.rewardField'),
          JSON.stringify(entry.field.path),
          (view.rules?.state ?? [])
            .filter((field) => typeof field.value === 'number')
            .map((field) => [JSON.stringify(field.path), field.path.join('.')] as const),
          (value) => {
            entry.field.path = JSON.parse(value)
          },
        ),
        fieldPath(
          controls.input(
            t('story.rewardAmount'),
            String(entry.amount),
            (value) => {
              entry.amount = Number(value)
            },
            'number',
          ),
          ...path,
          'rewards',
          'numeric',
          index,
          'amount',
        ),
        controls.button(t('story.removeNumericReward'), () => {
          draft.rewards.numeric.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    ),
  )
  rewards.append(
    controls.button(t('form.addNumericReward'), () => {
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
    const row = controls.group(t('story.itemReward', { number: index + 1 }))
    row.append(
      controls.input(t('story.itemRewardId'), entry.id, (value) => {
        entry.id = value
      }),
      controls.select(
        t('story.rewardItemType'),
        entry.itemType,
        Object.keys(view.inventory?.itemTypes ?? {}),
        (value) => {
          entry.itemType = value
        },
      ),
    )

    for (const [channel, color] of Object.entries(entry.colors))
      row.append(
        controls.input(t('story.dye', { channel }), color, (value) => {
          entry.colors[channel] = value
        }),
        controls.button(t('story.removeDye', { channel }), () => {
          delete entry.colors[channel]
          controls.markEdited()
          render()
        }),
      )
    let channel = ''
    row.append(
      controls.input(t('story.newDyeChannel'), '', (value) => {
        channel = value
      }),
      controls.button(t('story.addDye'), () => {
        if (channel) {
          entry.colors[channel] = '#4488ff'
          controls.markEdited()
          render()
        }
      }),
      controls.button(t('story.removeItemReward'), () => {
        draft.rewards.items.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    rewards.append(row)
  })
  rewards.append(
    controls.button(t('story.addItemReward'), () => {
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
    controls.section([...path, 'handIns'].join('/'), fieldPath(handIns, ...path, 'handIns')),
    controls.section([...path, 'rewards'].join('/'), fieldPath(rewards, ...path, 'rewards')),
  ]
}
