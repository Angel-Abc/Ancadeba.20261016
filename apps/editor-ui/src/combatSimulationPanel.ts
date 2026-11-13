import {
  CombatSimulation,
  combatSimulationSetup,
  type ActiveCombatStatus,
  type CombatSimulationSetup,
  type EnemyDecisionTrace,
  type CombatCooldowns,
  runCombatScenario,
} from '@ancadeba/game-runtime'
import {
  resolveCombatSource,
  combatSourceSchema,
  cloneCombatRules,
  type CombatSource,
  type CombatDefinition,
  type CombatSimulationLoadout,
} from '@ancadeba/schemas'
import type { ProjectView, EditorCommand } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import { startingGameBindings } from './textBindingChoices.js'
import { ruleFormControls } from './ruleFormControls.js'
import { combatScenarioForm, type CombatScenarioDraftState } from './combatScenarioForm.js'
import { registerEditorDraft } from './editorDraftState.js'
import { z } from 'zod'
import { combatSimulationScenarioSchema } from '@ancadeba/schemas'

interface StartingConditions {
  loadout?: CombatSimulationLoadout | undefined
  seed: number
  round: number
  health: Record<string, number>
  resources: Record<string, number>
  phase: string
  statuses: Record<string, ActiveCombatStatus[]>
  cooldowns: CombatCooldowns
}

/** Simulation is isolated; only explicit scenario saves issue authoring commands. */
export function bindCombatSimulationPanel(
  root: HTMLElement,
  t: Translate,
  save: (command: EditorCommand) => void,
) {
  root.className = 'combat-simulation'
  const document = root.ownerDocument
  const controls = ruleFormControls(document, () => {}, t)
  const { group, input, select, button, create } = controls
  const text = (key: string) => t(`combat.simulation.${key}`)
  let view: ProjectView | undefined
  let source: CombatSource | undefined
  let signature = ''
  let definition: CombatDefinition | undefined
  let base: CombatSimulationSetup | undefined
  let config: StartingConditions | undefined
  let simulation: CombatSimulation | undefined
  let selectedMove = ''
  let selectedItem = ''
  let selectedTarget = ''
  let statusActor = ''
  let statusId = ''
  let stacks = 1
  let intensity = 1
  let duration = 1
  let rounds = 4
  let inspectIndex = -1
  let inspectKind = 'enemy-decision'
  let error = ''
  let sourceAtStart: CombatSource | undefined

  const scenarioState: CombatScenarioDraftState = {
    encounter: '',
    selected: '',
    dirty: false,
    creating: false,
    newId: 'scenario',
    error: '',
    results: {},
  }

  const invalidateResults = () => {
    scenarioState.results = {}

    if (scenarioState.resultElement)
      scenarioState.resultElement.textContent = t('combat.scenarios.rerun')
  }

  const fingerprint = () => {
    const combat = { ...source, simulationScenarios: undefined }

    return JSON.stringify([
      combat,
      view?.combatLibraries,
      view?.rules,
      view?.inventory,
      view?.leveling,
    ])
  }

  const prepare = () => {
    if (!source || !view) throw new Error(text('choose'))
    const parsed = combatSourceSchema.parse(source)

    const resolved = resolveCombatSource(
      parsed,
      new Map(Object.entries(view.combatLibraries ?? {})),
      undefined,
      view.inventory,
    )

    if (!resolved.definition)
      throw new Error(
        resolved.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
      )
    definition = resolved.definition
    const bindings = startingGameBindings(view)

    const read = (binding: Parameters<typeof bindings.read>[0]) => {
      const value = bindings.read(binding)

      return value.status === 'resolved' ? value.value : undefined
    }

    const profile = definition.player.leveling
      ? view.leveling?.[definition.player.leveling]
      : undefined

    const level = profile ? read(profile.level) : undefined
    base = combatSimulationSetup(
      definition,
      read,
      view.inventory,
      typeof level === 'number' ? level : undefined,
    )
    config ??= {
      seed: definition.seed,
      round: 1,
      health: { ...base.health },
      resources: Object.fromEntries(
        Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => [
          id,
          resource.initial,
        ]),
      ),
      phase: definition.mechanics?.initialPhase ?? '',
      statuses: {},
      cooldowns: {},
    }
  }

  const act =
    (operation: () => void, restart = false) =>
    () => {
      try {
        if (signature !== fingerprint()) {
          simulation = undefined
          config = undefined
          signature = fingerprint()

          if (!restart) throw new Error(text('changed'))
        }

        operation()
        error = ''
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }

      render()
    }

  const numeric = (label: string, value: number, update: (value: number) => void) =>
    input(label, String(value), (value) => update(Number(value)), 'number')

  const pre = (value: unknown) => {
    const node = create('pre')
    node.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2)

    return node
  }

  const decisionView = (decision: EnemyDecisionTrace) => {
    const rows = create('ul')
    const summary = create('p')
    summary.textContent = `${decision.actor} · ${text(`stop.${decision.stop}`)} · AP ${decision.remainingAp}/${decision.ap} · ${decision.phase ?? ''}`

    for (const candidate of decision.candidates) {
      const row = create('li')
      const title = create('strong')
      title.textContent = `${candidate.rule ?? text('rotation')} → ${candidate.move}: ${candidate.selected ? text('selected') : candidate.blockers.map((reason) => text(`reason.${reason}`)).join(', ')}`
      const values = create('p')
      values.textContent = `AP ${candidate.cost}/${decision.remainingAp} · ${text('cooldown')}: ${candidate.cooldown}${candidate.maximumUses !== undefined ? ` · ${text('uses')}: ${candidate.uses}/${candidate.maximumUses}` : ''}${candidate.resource ? ` · ${candidate.resource}: ${candidate.available}/${candidate.required}` : ''}`
      row.append(title, values)

      if (candidate.restriction) {
        const restriction = create('p')
        restriction.textContent = t('combat.restrictions.aiReason', {
          category: candidate.restriction.category,
          status: definition?.statuses?.[candidate.restriction.status ?? '']?.label ?? '',
        })
        row.append(restriction)
      }

      const appendCheck = (
        check: EnemyDecisionTrace['candidates'][number]['conditions'][number],
        parent: HTMLElement,
      ) => {
        const condition = check.condition
        const line = create('li')

        const label =
          condition.type === 'status'
            ? `${condition.actor}.${condition.status}.${condition.measure}`
            : condition.type === 'health'
              ? `${condition.actor}.health`
              : condition.type === 'resource'
                ? condition.resource
                : condition.type === 'phase'
                  ? text('phase')
                  : condition.type === 'event-value'
                    ? t(`combat.events.field.${condition.field}`)
                    : condition.type === 'event-flag'
                      ? t(`combat.events.flag.${condition.field}`)
                      : condition.type.toUpperCase()

        const percent = 'unit' in condition && condition.unit === 'percent'

        const observed =
          check.actual === undefined
            ? check.children
              ? ''
              : text('unresolved')
            : `${check.actual}${percent ? `% (${check.current}/${check.maximum})` : ''}`

        line.textContent = `${check.matched ? '✓' : '✗'} ${label}: ${observed} ${'operator' in condition ? `${condition.operator} ${condition.value}${percent ? '%' : ''}` : condition.type === 'phase' ? `= ${condition.phase}` : condition.type === 'event-flag' ? `= ${condition.value}` : ''}`

        if (check.children?.length) {
          const children = create('ul')

          for (const child of check.children) appendCheck(child, children)
          line.append(children)
        }

        parent.append(line)
      }

      const checks = create('ul')

      for (const check of candidate.conditions) appendCheck(check, checks)

      if (candidate.requirements?.length) {
        const heading = create('li')
        heading.textContent = t('combat.requirements.heading')
        checks.append(heading)

        for (const check of candidate.requirements) appendCheck(check, checks)
      }

      row.append(checks)

      rows.append(row)
    }

    const help = create('p')
    help.textContent = text('priorityHelp')

    return group(text('decision'), summary, rows, help)
  }

  function render() {
    root.replaceChildren()

    if (!source || !view) return

    try {
      prepare()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      definition = undefined
      base = undefined
    }

    const heading = create('h3')
    heading.textContent = text('heading')
    const help = create('p')
    help.textContent = text('help')
    const alert = create('p')
    alert.setAttribute('role', 'alert')
    alert.textContent = error
    root.append(heading, help, alert)

    if (!definition || !base || !config) return
    const currentDefinition = definition
    const setup = config
    const actors = [definition.player, ...definition.enemies]

    if (!actors.some((actor) => actor.id === statusActor)) statusActor = definition.player.id
    const statuses = Object.keys(definition.statuses ?? {})

    if (!statuses.includes(statusId)) statusId = statuses[0] ?? ''
    root.append(
      group(
        text('starting'),
        numeric(text('seed'), setup.seed, (value) => {
          setup.seed = value
        }),
        numeric(text('startingRound'), setup.round, (value) => {
          setup.round = value
        }),
        ...actors.flatMap((actor) => {
          const inventory = base?.equipmentContext?.inventory
          const owner = actor.equipmentOwner

          if (!inventory || !owner) return []

          return Object.keys(inventory.owners[owner]?.equipmentSlots ?? {}).map((slot) =>
            select(
              t('equipment.combat.simSlot', { actor: actor.id, slot }),
              setup.loadout?.[actor.id]?.[slot] === undefined
                ? '@inherit'
                : (setup.loadout[actor.id]![slot] ?? ''),
              [
                ['@inherit', t('equipment.combat.inheritLoadout')],
                ['', t('equipment.combat.emptySlot')],
                ...Object.entries(inventory.items)
                  .filter(
                    ([, item]) =>
                      item.placement.type !== 'inside' &&
                      item.placement.owner === owner &&
                      inventory.itemTypes[item.itemType]?.equipmentSlots.includes(slot),
                  )
                  .map(
                    ([id, item]) => [id, inventory.itemTypes[item.itemType]?.label || id] as const,
                  ),
              ],
              (value) => {
                const loadout = (setup.loadout ??= {})
                const slots = (loadout[actor.id] ??= {})

                if (value === '@inherit') delete slots[slot]
                else slots[slot] = value || null
              },
            ),
          )
        }),
        ...actors.map((actor) =>
          numeric(
            t('combat.simulation.health', {
              actor: actor.id,
              maximum: base!.maximumHealth[actor.id]!,
            }),
            setup.health[actor.id]!,
            (value) => {
              setup.health[actor.id] = value
            },
          ),
        ),
        ...Object.keys(setup.resources).map((id) =>
          numeric(t('combat.simulation.resource', { id }), setup.resources[id]!, (value) => {
            setup.resources[id] = value
          }),
        ),
        ...(Object.keys(definition.mechanics?.phases ?? {}).length
          ? [
              select(
                text('startingPhase'),
                setup.phase,
                Object.keys(definition.mechanics!.phases),
                (value) => {
                  setup.phase = value
                },
              ),
            ]
          : []),
        ...(statuses.length
          ? [
              group(
                text('startingStatuses'),
                select(
                  text('statusActor'),
                  statusActor,
                  actors.map((actor) => actor.id),
                  (value) => {
                    statusActor = value
                  },
                ),
                select(text('status'), statusId, statuses, (value) => {
                  statusId = value
                  stacks = 1
                  intensity = currentDefinition.statuses![value]?.intensity?.initial ?? 1
                  duration = currentDefinition.statuses![value]?.duration ?? 1
                  render()
                }),
                numeric(text('stacks'), stacks, (value) => {
                  stacks = value
                }),
                numeric(text('intensity'), intensity, (value) => {
                  intensity = value
                }),
                numeric(text('duration'), duration, (value) => {
                  duration = value
                }),
                button(
                  text('addStatus'),
                  act(() => {
                    const active = {
                      id: statusId,
                      source: statusActor,
                      remaining: duration,
                      stacks,
                      intensity,
                    }

                    setup.statuses[statusActor] = [
                      ...(setup.statuses[statusActor] ?? []).filter(
                        (entry) => entry.id !== statusId,
                      ),
                      active,
                    ]
                  }),
                ),
                ...Object.entries(setup.statuses).flatMap(([actor, entries]) =>
                  entries.map((entry) =>
                    group(
                      `${actor}: ${entry.id}`,
                      pre(entry),
                      button(
                        t('combat.simulation.removeStatus', { actor, status: entry.id }),
                        act(() => {
                          setup.statuses[actor] = setup.statuses[actor]!.filter(
                            (active) => active.id !== entry.id,
                          )
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            ]
          : []),
        button(
          text('start'),
          act(() => {
            prepare()
            const starting = config!
            simulation = new CombatSimulation(definition!, {
              ...base!,
              seed: starting.seed,
              round: starting.round,
              health: starting.health,
              resources: starting.resources,
              ...(starting.phase ? { phase: starting.phase } : {}),
              statuses: starting.statuses,
              cooldowns: starting.cooldowns,
              loadout: starting.loadout,
            })
            sourceAtStart = cloneCombatRules(source!)
            inspectIndex = -1
          }, true),
        ),
      ),
    )

    root.append(
      combatScenarioForm(
        controls,
        view,
        source,
        definition,
        scenarioState,
        {
          get simulation() {
            return signature === fingerprint() ? simulation : undefined
          },
          starting: () => ({ ...config!, phase: config!.phase || undefined }),
          run: (scenario) => {
            if (signature !== fingerprint()) {
              invalidateResults()
              config = undefined
              simulation = undefined
              signature = fingerprint()
            }

            prepare()

            return runCombatScenario(definition!, base!, scenario)
          },
          save,
          load: (scenario) => {
            prepare()
            signature = fingerprint()
            const current = definition!
            config = {
              loadout: cloneCombatRules(scenario.setup.loadout),
              seed: scenario.setup.seed,
              round: scenario.setup.round,
              health: { ...base!.health, ...scenario.setup.health },
              resources: {
                ...Object.fromEntries(
                  Object.entries(current.mechanics?.resources ?? {}).map(([id, resource]) => [
                    id,
                    resource.initial,
                  ]),
                ),
                ...scenario.setup.resources,
              },
              phase: scenario.setup.phase ?? current.mechanics?.initialPhase ?? '',
              statuses: cloneCombatRules(scenario.setup.statuses),
              cooldowns: cloneCombatRules(scenario.setup.cooldowns),
            }
            const { phase, ...starting } = scenario.setup
            simulation = new CombatSimulation(current, {
              ...base!,
              ...starting,
              ...(phase ? { phase } : {}),
              health: config.health,
            })
            sourceAtStart = cloneCombatRules(source!)
            inspectIndex = -1
          },
          inspect: (sandbox) => {
            simulation = sandbox
            sourceAtStart = cloneCombatRules(source!)
            inspectIndex = -1
          },
        },
        render,
      ),
    )

    if (!simulation) return
    const sandbox = simulation
    const state = sandbox.snapshot()

    const playerMoves =
      sandbox.report().setup.availableMoves ?? base.availableMoves ?? definition.player.moves

    if (!playerMoves.includes(selectedMove)) selectedMove = playerMoves[0] ?? ''
    const living = definition.enemies.filter((actor) => state.health[actor.id]! > 0)

    if (!living.some((actor) => actor.id === selectedTarget)) selectedTarget = living[0]?.id ?? ''
    const summary = create('p')
    summary.setAttribute('data-combat-simulation-state', '')
    summary.textContent = `${text('round')} ${state.round} · ${state.outcome ?? text('planning')} · ${state.mechanics?.phase ?? ''} · ${Object.entries(
      state.health,
    )
      .map(([actor, hp]) => `${actor}: ${hp}`)
      .join(' · ')} · ${Object.entries(state.mechanics?.resources ?? {})
      .map(([id, amount]) => `${id}: ${amount}`)
      .join(' · ')}`
    const queueIssue = selectedMove ? sandbox.queueIssue(selectedMove, selectedTarget) : undefined

    const queueButton = button(
      text('queue'),
      act(() => sandbox.queue(selectedMove, selectedTarget)),
      Boolean(state.outcome) || !selectedMove || Boolean(queueIssue),
    )

    const catalog = sandbox.itemCatalog()

    const itemIds = Object.entries(catalog?.inventory.items ?? {})
      .filter(([, item]) => currentDefinition.itemUse?.itemTypes.includes(item.itemType))
      .map(([id]) => id)

    if (!itemIds.includes(selectedItem)) selectedItem = itemIds[0] ?? ''
    const itemType = catalog?.inventory.items[selectedItem]?.itemType
    const itemMove = itemType ? catalog?.inventory.itemTypes[itemType]?.use?.ability.id : undefined

    const itemIssue = itemMove
      ? sandbox.queueIssue(itemMove, selectedTarget, selectedItem)
      : undefined

    const queueItem = button(
      text('queueItem'),
      act(() => {
        if (itemMove) sandbox.queue(itemMove, selectedTarget, selectedItem)
      }),
      !itemMove || Boolean(itemIssue) || Boolean(state.outcome),
    )

    queueItem.title = itemIssue ?? ''
    queueButton.title = queueIssue ?? ''
    root.append(
      summary,
      group(
        text('plan'),
        select(
          text('move'),
          selectedMove,
          playerMoves.map(
            (id) => [id, `${currentDefinition.moves[id]!.label || id} (${id})`] as const,
          ),
          (value) => {
            selectedMove = value
            render()
          },
        ),
        select(
          text('target'),
          selectedTarget,
          living.map((actor) => [actor.id, actor.label || actor.id] as const),
          (value) => {
            selectedTarget = value
            render()
          },
        ),
        queueButton,
        ...(itemIds.length
          ? [
              select(text('item'), selectedItem, itemIds, (value) => {
                selectedItem = value
                render()
              }),
              queueItem,
              ...(itemIssue ? [pre(itemIssue)] : []),
            ]
          : []),
        ...(queueIssue ? [pre(queueIssue)] : []),
        pre(state.plan),
        button(
          text('undo'),
          act(() => sandbox.undo()),
          !state.plan.length,
        ),
        button(
          text('clear'),
          act(() => sandbox.clear()),
          !state.plan.length,
        ),
        button(
          text('resolve'),
          act(() => {
            sandbox.resolve()
            inspectIndex = -1
          }),
          Boolean(state.outcome),
        ),
        numeric(text('repeatRounds'), rounds, (value) => {
          rounds = value
        }),
        button(
          text('run'),
          act(() => {
            sandbox.run(rounds)
            inspectIndex = -1
          }),
          Boolean(state.outcome),
        ),
        ...(definition.allowEscape
          ? [
              button(
                text('escape'),
                act(() => {
                  sandbox.resolve(true)
                  inspectIndex = -1
                }),
                Boolean(state.outcome),
              ),
            ]
          : []),
      ),
    )
    const frames = sandbox.trace()

    const choices = frames.flatMap((frame, index) =>
      inspectKind === 'all' || frame.kind === inspectKind
        ? [
            [
              String(index),
              `${frame.round} · ${frame.kind} · ${frame.actor ?? ''} ${frame.action?.move ?? frame.mechanicsEvent?.trigger ?? ''}${frame.mechanicsEvent?.interception ? ` · ${frame.mechanicsEvent.interception.type}` : ''}${frame.mechanicsEvent?.activated ? ` · ${t('combat.triggerLimits.activated')}` : frame.mechanicsEvent?.activation?.blockers.length ? ` · ${frame.mechanicsEvent.activation.blockers.map((blocker) => t(`combat.triggerLimits.blocker.${blocker}`)).join(', ')}` : ''}`,
            ] as const,
          ]
        : [],
    )

    if (!choices.some(([index]) => Number(index) === inspectIndex))
      inspectIndex = Number(
        (inspectKind === 'enemy-decision'
          ? [...choices].reverse().find(([index]) => frames[Number(index)]?.decision?.choice)
          : undefined)?.[0] ??
          choices.at(-1)?.[0] ??
          -1,
      )
    root.append(
      group(
        text('timeline'),
        select(
          text('filter'),
          inspectKind,
          [
            ['enemy-decision', text('decisions')],
            ['action', text('actions')],
            ['mechanics', text('mechanics')],
            ['all', text('all')],
          ],
          (value) => {
            inspectKind = value
            inspectIndex = -1
            render()
          },
        ),
        select(text('inspect'), String(inspectIndex), choices, (value) => {
          inspectIndex = Number(value)
          render()
        }),
      ),
    )
    const frame = frames[inspectIndex]

    if (frame)
      root.append(
        ...(frame.decision ? [decisionView(frame.decision)] : []),
        group(text('state'), pre(frame)),
      )
    const preview = create('details')
    const previewTitle = create('summary')
    previewTitle.textContent = text('preview')
    preview.append(previewTitle, ...sandbox.preview().slice(0, 50).map(decisionView))
    root.append(preview)
    const report = sandbox.report()

    if (report.truncated) root.append(pre(text('truncated')))
    const details = create('details')
    const title = create('summary')
    title.textContent = text('report')
    const json = create('textarea')
    json.readOnly = true
    json.setAttribute('aria-label', text('report'))
    json.value = JSON.stringify({ ...report, source: sourceAtStart }, null, 2)
    details.append(title, ...(report.truncated ? [pre(text('truncated'))] : []), json)
    root.append(details)
  }

  registerEditorDraft(
    root,
    'combat-scenario',
    z.object({
      encounter: z.string(),
      selected: z.string(),
      draft: combatSimulationScenarioSchema.optional(),
      creating: z.boolean(),
      newId: z.string(),
    }),
    () =>
      scenarioState.dirty
        ? {
            encounter: scenarioState.encounter,
            selected: scenarioState.selected,
            draft: scenarioState.draft,
            creating: scenarioState.creating,
            newId: scenarioState.newId,
          }
        : undefined,
    (saved) => {
      Object.assign(scenarioState, saved, { dirty: true, results: {}, error: '' })
      render()
    },
  )

  return {
    hasDrafts: () => scenarioState.dirty,
    invalidateResults,
    render(nextView: ProjectView | undefined, nextSource: CombatSource | undefined) {
      view = nextView
      source = nextSource
      const next = fingerprint()

      if (next !== signature) {
        invalidateResults()

        if (simulation) error = text('changed')
        simulation = undefined
        config = undefined
        signature = next
      }

      render()
    },
  }
}
