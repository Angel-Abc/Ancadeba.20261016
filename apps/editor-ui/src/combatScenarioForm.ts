import {
  combatSimulationScenarioSchema,
  combatScenarioStepSchema,
  combatScenarioSetupSchema,
  combatReferenceSchema,
  cloneCombatRules,
  type CombatDefinition,
  type CombatSource,
  type CombatSimulationScenario,
  type CombatScenarioExpectation,
} from '@ancadeba/schemas'
import {
  combatMoveTarget,
  type CombatSimulation,
  type CombatScenarioResult,
} from '@ancadeba/game-runtime'
import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { ruleFormControls, type RuleFormControls } from './ruleFormControls.js'

export interface CombatScenarioDraftState {
  encounter: string
  selected: string
  draft?: CombatSimulationScenario | undefined
  dirty: boolean
  creating: boolean
  submitted?: string | undefined
  deleting?: string | undefined
  newId: string
  error: string
  results: Record<string, CombatScenarioResult>
  resultElement?: HTMLElement | undefined
  savedSignature?: string | undefined
}

export function combatScenarioForm(
  controls: RuleFormControls,
  view: ProjectView,
  source: CombatSource,
  definition: CombatDefinition,
  state: CombatScenarioDraftState,
  host: {
    simulation: CombatSimulation | undefined
    starting: () => unknown
    run: (scenario: CombatSimulationScenario) => CombatScenarioResult
    load: (scenario: CombatSimulationScenario) => void
    inspect: (simulation: CombatSimulation) => void
    save: (command: EditorCommand) => void
  },
  render: () => void,
) {
  const { create, t } = controls
  const text = (key: string) => t(`combat.scenarios.${key}`)
  const saved = view.combatSources?.[source.id]?.simulationScenarios ?? {}
  const savedSignature = JSON.stringify(saved)

  if (state.savedSignature !== savedSignature) {
    state.results = {}
    state.savedSignature = savedSignature
  }

  if (state.encounter !== source.id) {
    Object.assign(state, {
      encounter: source.id,
      selected: '',
      draft: undefined,
      dirty: false,
      creating: false,
      results: {},
      error: '',
      submitted: undefined,
      deleting: undefined,
    })
  }

  if (
    state.submitted &&
    saved[state.submitted] &&
    JSON.stringify(saved[state.submitted]) === JSON.stringify(state.draft)
  ) {
    state.dirty = false
    state.creating = false
    state.submitted = undefined
  }

  if (state.deleting && !saved[state.deleting]) {
    state.selected = ''
    state.draft = undefined
    state.dirty = false
    state.deleting = undefined
  }

  if (!state.dirty && state.selected && saved[state.selected])
    state.draft = cloneCombatRules(saved[state.selected])
  const results = create('div')
  state.resultElement = results

  const changed = () => {
    state.dirty = true
    state.results = {}
    results.textContent = text('rerun')
  }

  const local = ruleFormControls(create('div').ownerDocument, changed, t)
  const { input, select, group, button } = local

  const act =
    (operation: () => void, edit = false) =>
    () => {
      try {
        operation()

        if (edit) changed()
        state.error = ''
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
      }

      render()
    }

  const pre = (value: unknown) => {
    const node = create('pre')
    node.textContent = JSON.stringify(value, null, 2)

    return node
  }

  const numeric = (label: string, value: number, update: (value: number) => void) =>
    input(label, String(value), (value) => update(Number(value)), 'number')

  const unique = (base: string) => {
    let id = base || 'scenario'
    let index = 1

    while (Object.keys(saved).some((key) => key.toLowerCase() === id.toLowerCase()))
      id = `${base || 'scenario'}-${index++}`

    return id
  }

  const fresh = () => {
    const report = host.simulation?.report()
    const steps: CombatSimulationScenario['steps'] = []

    for (const input of report?.inputs ?? []) {
      const previous = steps.at(-1)

      if (
        previous &&
        previous.repeat < 100 &&
        previous.escape === input.escape &&
        JSON.stringify(previous.plan) === JSON.stringify(input.plan)
      )
        previous.repeat++
      else
        steps.push(
          combatScenarioStepSchema.parse({
            id: `round-${steps.length + 1}`,
            plan: input.plan,
            escape: input.escape,
          }),
        )
    }

    if (report?.state.plan.length || !steps.length)
      steps.push(
        combatScenarioStepSchema.parse({
          id: `round-${steps.length + 1}`,
          plan: report?.state.plan ?? [],
        }),
      )

    return combatSimulationScenarioSchema.parse({
      label: state.newId || 'Scenario',
      setup: report
        ? { ...report.setup, seed: report.setup.seed ?? definition.seed }
        : combatScenarioSetupSchema.parse(host.starting()),
      steps,
      expect: [{ type: 'outcome', value: report?.state.outcome ?? 'planning' }],
    })
  }

  const expectationForm = (items: CombatScenarioExpectation[], prefix: string): HTMLElement[] => [
    ...items.map((entry, index) =>
      group(
        `${prefix} ${text('expected')} ${index + 1}`,
        select(
          text('expectedType'),
          entry.type,
          ['outcome', 'phase', 'health', 'guard', 'resource', 'status', 'rounds', 'trigger'],
          (type) => {
            const actor = definition.player.id
            items[index] =
              type === 'outcome'
                ? { type, value: 'planning' }
                : type === 'phase'
                  ? { type, value: Object.keys(definition.mechanics?.phases ?? {})[0] ?? 'phase' }
                  : type === 'trigger'
                    ? {
                        type,
                        trigger:
                          Object.keys(definition.mechanics?.triggers ?? {}).find(
                            (id) => definition.mechanics!.triggers[id]!.once,
                          ) ?? 'trigger',
                        fired: true,
                      }
                    : type === 'health' || type === 'guard'
                      ? { type, actor, operator: 'eq', value: 0 }
                      : type === 'resource'
                        ? {
                            type,
                            resource:
                              Object.keys(definition.mechanics?.resources ?? {})[0] ?? 'resource',
                            operator: 'eq',
                            value: 0,
                          }
                        : type === 'status'
                          ? {
                              type,
                              actor,
                              status: Object.keys(definition.statuses ?? {})[0] ?? 'status',
                              measure: 'stacks',
                              operator: 'eq',
                              value: 0,
                            }
                          : { type: 'rounds', operator: 'eq', value: 1 }
            changed()
            render()
          },
        ),
        ...('actor' in entry
          ? [
              select(
                text('expectedActor'),
                entry.actor,
                [definition.player, ...definition.enemies].map((actor) => actor.id),
                (value) => {
                  entry.actor = value
                },
              ),
            ]
          : []),
        ...(entry.type === 'resource'
          ? [
              input(text('expectedResource'), entry.resource, (value) => {
                entry.resource = value.trim()
              }),
            ]
          : []),
        ...(entry.type === 'status'
          ? [
              input(text('expectedStatus'), entry.status, (value) => {
                entry.status = value.trim()
              }),
              select(
                text('expectedMeasure'),
                entry.measure,
                ['stacks', 'intensity', 'remaining'],
                (value) => {
                  entry.measure = value
                },
              ),
            ]
          : []),
        ...(entry.type === 'outcome'
          ? [
              select(
                text('expectedOutcome'),
                entry.value,
                ['planning', 'victory', 'defeat', 'escaped'],
                (value) => {
                  entry.value = value
                },
              ),
            ]
          : []),
        ...(entry.type === 'phase'
          ? [
              input(text('expectedPhase'), entry.value, (value) => {
                entry.value = value.trim()
              }),
            ]
          : []),
        ...(entry.type === 'trigger'
          ? [
              input(text('expectedTrigger'), entry.trigger, (value) => {
                entry.trigger = value.trim()
              }),
              select(text('expectedFired'), String(entry.fired), ['true', 'false'], (value) => {
                entry.fired = value === 'true'
              }),
            ]
          : []),
        ...('operator' in entry
          ? [
              select(
                text('operator'),
                entry.operator,
                ['eq', 'gte', 'lte', 'gt', 'lt'],
                (value) => {
                  entry.operator = value
                },
              ),
              numeric(text('value'), entry.value, (value) => {
                entry.value = value
              }),
            ]
          : []),
        button(
          text('removeExpected'),
          act(() => {
            items.splice(index, 1)
          }, true),
        ),
      ),
    ),
    button(
      text('addExpected'),
      act(() => {
        items.push({ type: 'outcome', value: 'planning' })
      }, true),
    ),
  ]

  const picker = controls.select(
    text('select'),
    state.selected,
    [['', text('choose')], ...Object.keys(saved)],
    (id) => {
      if (state.dirty) {
        state.error = text('saveFirst')
        picker.querySelector('select')!.value = state.selected
      } else {
        state.selected = id
        state.draft = id ? cloneCombatRules(saved[id]) : undefined
        state.creating = false
        state.results = {}
        state.error = ''
      }

      render()
    },
    false,
  )

  const help = create('p')
  help.textContent = text('help')
  const alert = create('p')
  alert.setAttribute('role', 'alert')
  alert.textContent = state.error

  const fields: HTMLElement[] = [
    picker,
    help,
    alert,
    controls.input(text('newId'), state.newId, (value) => {
      state.newId = value.trim()
    }),
    button(
      text('capture'),
      act(() => {
        if (state.dirty) throw new Error(text('saveFirst'))
        const id = combatReferenceSchema.shape.id.parse(unique(state.newId))
        const draft = fresh()
        state.selected = id
        state.draft = draft
        state.creating = true
      }, true),
    ),
    button(
      text('runAll'),
      act(() => {
        state.results = Object.fromEntries(
          Object.entries(saved).map(([id, scenario]) => [id, host.run(scenario)]),
        )
      }),
      !Object.keys(saved).length,
    ),
  ]

  const draft = state.draft

  if (draft)
    fields.push(
      input(text('name'), draft.label, (value) => {
        draft.label = value
      }),
      input(text('description'), draft.description, (value) => {
        draft.description = value
      }),
      pre(draft.setup),
      button(
        text('useStarting'),
        act(() => {
          draft.setup = combatScenarioSetupSchema.parse(host.starting())
        }, true),
      ),
      button(
        text('loadStarting'),
        act(() => host.load(draft)),
      ),
      ...draft.steps.map((step, index) =>
        group(
          `${text('step')} ${index + 1}`,
          input(text('stepId'), step.id, (value) => {
            step.id = value.trim()
          }),
          numeric(text('repeat'), step.repeat, (value) => {
            step.repeat = value
          }),
          select(
            text('unavailable'),
            step.unavailable,
            [
              ['fail', text('fail')],
              ['skip', text('skip')],
            ],
            (value) => {
              step.unavailable = value
            },
          ),
          select(text('escape'), String(step.escape), ['false', 'true'], (value) => {
            step.escape = value === 'true'
          }),
          ...step.plan.map((action, position) =>
            group(
              `${text('action')} ${position + 1}`,
              select(
                text('move'),
                action.move,
                [...definition.player.moves, ...(definition.player.equipmentMoves ?? [])],
                (value) => {
                  action.move = value
                  action.target =
                    combatMoveTarget(definition.moves[value]!) === 'self'
                      ? undefined
                      : definition.enemies[0]?.id
                  changed()
                  render()
                },
              ),
              select(
                text('target'),
                action.target ?? '',
                ['', ...definition.enemies.map((actor) => actor.id)],
                (value) => {
                  action.target = value || undefined
                },
              ),
              button(
                text('actionUp'),
                act(() => {
                  if (position)
                    [step.plan[position - 1], step.plan[position]] = [
                      step.plan[position]!,
                      step.plan[position - 1]!,
                    ]
                }, true),
                !position,
              ),
              button(
                text('removeAction'),
                act(() => {
                  step.plan.splice(position, 1)
                }, true),
              ),
            ),
          ),
          button(
            text('addAction'),
            act(() => {
              const move = definition.player.moves[0]!
              step.plan.push({
                move,
                ...(combatMoveTarget(definition.moves[move]!) === 'enemy'
                  ? { target: definition.enemies[0]!.id }
                  : {}),
              })
            }, true),
          ),
          ...expectationForm(step.expect, step.id),
          button(
            text('stepUp'),
            act(() => {
              if (index)
                [draft.steps[index - 1], draft.steps[index]] = [
                  draft.steps[index]!,
                  draft.steps[index - 1]!,
                ]
            }, true),
            !index,
          ),
          button(
            text('removeStep'),
            act(() => {
              draft.steps.splice(index, 1)
            }, true),
          ),
        ),
      ),
      button(
        text('addStep'),
        act(() => {
          let index = draft.steps.length + 1

          while (draft.steps.some((step) => step.id === `step-${index}`)) index++
          draft.steps.push(combatScenarioStepSchema.parse({ id: `step-${index}` }))
        }, true),
      ),
      group(text('final'), ...expectationForm(draft.expect, text('final'))),
      button(
        text('captureExpected'),
        act(() => {
          const state = host.simulation?.snapshot()

          if (!state) throw new Error(text('runFirst'))
          draft.expect = [
            { type: 'outcome', value: state.outcome ?? 'planning' },
            { type: 'rounds', operator: 'eq', value: host.simulation!.completedRounds },
            ...Object.entries(state.health).map(([actor, value]) => ({
              type: 'health' as const,
              actor,
              operator: 'eq' as const,
              value,
            })),
            ...Object.entries(state.mechanics?.resources ?? {}).map(([resource, value]) => ({
              type: 'resource' as const,
              resource,
              operator: 'eq' as const,
              value,
            })),
            ...(state.mechanics?.phase
              ? [{ type: 'phase' as const, value: state.mechanics.phase }]
              : []),
          ]
        }, true),
      ),
      button(
        text('run'),
        act(() => {
          const result = host.run(draft)
          state.results = { [state.selected]: result }

          if (result.simulation) host.inspect(result.simulation)
        }),
      ),
      button(
        text('save'),
        act(() => {
          const parsed = combatSimulationScenarioSchema.parse(draft)
          state.draft = parsed
          state.submitted = state.selected
          host.save({
            type: 'combat.upsertSimulationScenario',
            encounterId: source.id,
            scenarioId: state.selected,
            scenario: parsed,
            createOnly: state.creating,
          })
        }),
        !view.combatSources?.[source.id],
      ),
      button(
        text('duplicate'),
        act(() => {
          state.selected = unique(`${state.selected}-copy`)
          state.draft = cloneCombatRules(draft)
          state.creating = true
        }, true),
      ),
      button(
        text('discard'),
        act(() => {
          state.draft = saved[state.selected] ? cloneCombatRules(saved[state.selected]) : undefined
          state.dirty = false
          state.creating = false
          state.error = ''
        }),
      ),
      button(
        text('delete'),
        act(() => {
          state.deleting = state.selected
          host.save({
            type: 'combat.removeSimulationScenario',
            encounterId: source.id,
            scenarioId: state.selected,
          })
        }),
        state.creating,
      ),
    )

  for (const [id, result] of Object.entries(state.results)) {
    const status = create('p')
    status.textContent = `${id}: ${text(result.status)}`
    results.append(status)

    if (result.error) {
      const message = create('p')
      message.textContent = result.error
      results.append(message)
    }

    results.append(pre({ checks: result.checks, skipped: result.skipped }))

    if (result.simulation)
      results.append(
        button(
          t('combat.scenarios.inspectResult', { id }),
          act(() => host.inspect(result.simulation!)),
        ),
      )
  }

  return group(text('heading'), ...fields, results)
}
