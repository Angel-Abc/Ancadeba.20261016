import type { Translate } from '@ancadeba/utilities'
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
  const { t } = controls
  const keys = translationChoices(view, t('metadata.literalText'))

  return [
    controls.input(t('form.name'), draft.label, (value) => {
      draft.label = value
    }),
    controls.translation(t('form.nameTranslation'), draft.labelKey ?? '', keys, (value) => {
      draft.labelKey = value || undefined
    }),
    controls.input(t('metadata.description'), draft.description, (value) => {
      draft.description = value
    }),
    controls.translation(
      t('form.descriptionTranslation'),
      draft.descriptionKey ?? '',
      keys,
      (value) => {
        draft.descriptionKey = value || undefined
      },
    ),
  ]
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
            'combat-outcome',
          ] as const,
          conditionTypeLabels,
          t,
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

        row.append(
          controls.input(t('story.expectedValue'), String(condition.value), (value) => {
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

    if (effect.type === 'start-quest' || effect.type === 'complete-quest')
      row.append(
        controls.select(t('story.effectQuest'), effect.quest, questChoices(view), (value) => {
          effect.quest = value
        }),
      )
    else if (effect.type === 'append-log')
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
  controls: RuleFormControls,
  view: ProjectView,
  draft: DialogueDefinition,
  render: () => void,
): HTMLElement[] {
  const { t } = controls
  const root = controls.group(t('story.nodes'))

  for (const [id, node] of Object.entries(draft.nodes)) {
    const section = controls.group(t('story.node', { id }))
    section.append(
      controls.select(t('story.terminal'), String(node.terminal), yesNoChoices(t), (value) => {
        node.terminal = value === 'true'
      }),
      controls.button(t('story.removeNode'), () => {
        delete draft.nodes[id]
        controls.markEdited()
        render()
      }),
    )
    node.lines.forEach((line, index) =>
      section.append(
        controls.group(
          t('story.line', { number: index + 1 }),
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
          line.bindings
            ? lineBindings(controls, view, line.bindings, render)
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
        ),
      ),
    )
    section.append(
      controls.button(t('story.addLine'), () => {
        node.lines.push({ text: '' })
        controls.markEdited()
        render()
      }),
    )
    node.choices.forEach((choice, index) => {
      const box = controls.group(t('story.choice', { number: index + 1 }))
      box.append(
        controls.input(t('story.choiceId'), choice.id, (value) => {
          choice.id = value
        }),
        ...storyPresentation(controls, view, choice),
        controls.select(
          t('story.choiceDestination'),
          choice.end ? '__end' : (choice.next ?? ''),
          [['__end', t('story.endConversation')], ...Object.keys(draft.nodes)],
          (value) => {
            choice.end = value === '__end'
            choice.next = choice.end ? undefined : value
          },
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
            conditions: count(t, choice.visibleWhen.length + choice.when.length, 'condition'),
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
          storyConditions(controls, view, t('story.visibleWhen'), choice.visibleWhen, render),
          storyConditions(controls, view, t('story.enabledWhen'), choice.when, render),
          effectsForm(controls, view, choice.effects, render),
        ),
        controls.button(
          t('story.moveChoiceEarlier'),
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
        controls.button(t('story.removeChoice'), () => {
          node.choices.splice(index, 1)
          controls.markEdited()
          render()
        }),
      )
      section.append(box)
    })
    section.append(
      controls.button(t('story.addChoice'), () => {
        let number = node.choices.length + 1

        while (node.choices.some((choice) => choice.id === `choice-${number}`)) number++
        node.choices.push(
          dialogueChoiceSchema.parse({ id: `choice-${number}`, label: 'Reply', end: true }),
        )
        controls.markEdited()
        render()
      }),
    )
    const start = id === draft.entry ? t('story.start') : ''
    root.append(
      controls.fold(
        `dialogue:${draft.id}/node:${id}`,
        t('story.nodeSummary', {
          id,
          start,
          lines: count(t, node.lines.length, 'line'),
          choices: count(t, node.choices.length, 'choice'),
        }),
        id === draft.entry,
        section,
      ),
    )
  }

  let id = ''
  root.append(
    controls.input(t('story.newNodeId'), '', (value) => {
      id = value
    }),
    controls.button(t('story.addNode'), () => {
      if (!id || Object.hasOwn(draft.nodes, id)) return
      draft.nodes[id] = dialogueNodeSchema.parse({})
      controls.markEdited()
      render()
    }),
  )

  return [
    ...storyPresentation(controls, view, draft),
    controls.select(t('story.entryNode'), draft.entry, Object.keys(draft.nodes), (value) => {
      draft.entry = value
    }),
    controls.input(
      t('story.transcriptCapacity'),
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
  const { t } = controls
  const stages = controls.group(t('story.stages'))
  draft.stages.forEach((stage, index) => {
    const box = controls.group(t('story.stage', { number: index + 1 }))
    box.append(
      controls.input(t('story.stageId'), stage.id, (value) => {
        stage.id = value
      }),
      ...storyPresentation(controls, view, stage),
    )
    stage.objectives.forEach((objective, objectiveIndex) => {
      const row = controls.group(t('story.objective', { number: objectiveIndex + 1 }))
      row.append(
        controls.input(t('story.objectiveId'), objective.id, (value) => {
          objective.id = value
        }),
        ...storyPresentation(controls, view, objective),
        storyConditions(controls, view, t('story.objectiveConditions'), objective.when, render),
        controls.select(
          t('story.progressField'),
          objective.progress ? JSON.stringify(objective.progress.binding) : '',
          [
            ['', t('story.noProgress')],
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
            t('story.progressTarget'),
            String(progress.target),
            (value) => {
              progress.target = Number(value)
            },
            'number',
          ),
        )
      }

      row.append(
        controls.button(t('story.removeObjective'), () => {
          stage.objectives.splice(objectiveIndex, 1)
          controls.markEdited()
          render()
        }),
      )
      box.append(row)
    })
    box.append(
      controls.button(t('story.addObjective'), () => {
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
        t('story.moveStageEarlier'),
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
      controls.button(t('story.removeStage'), () => {
        draft.stages.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    stages.append(box)
  })
  stages.append(
    controls.button(t('story.addStage'), () => {
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
  const handIns = controls.group(t('story.handIns'))
  draft.handIns.forEach((entry, index) => {
    const row = controls.group(t('story.handIn', { number: index + 1 }))
    row.append(
      controls.input(t('story.handInItem'), entry.item, (value) => {
        entry.item = value
      }),
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
        controls.input(t('story.rewardId'), entry.id, (value) => {
          entry.id = value
        }),
        controls.input(t('story.rewardLabel'), entry.label, (value) => {
          entry.label = value
        }),
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
        controls.input(
          t('story.rewardAmount'),
          String(entry.amount),
          (value) => {
            entry.amount = Number(value)
          },
          'number',
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
    ...storyPresentation(controls, view, draft),
    storyConditions(controls, view, t('story.canStart'), draft.when, render),
    storyConditions(controls, view, t('story.canTurnIn'), draft.turnInWhen, render),
    stages,
    handIns,
    rewards,
  ]
}
