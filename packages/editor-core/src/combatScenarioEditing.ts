import {
  combatFile,
  type CombatSimulationScenario,
  type CombatSource,
  type GameDefinition,
} from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'
import { mergeCombatRuleFields } from './combatRuleEntryEditing.js'

function expectations(previous: unknown, next: CombatSimulationScenario['expect']) {
  return next.map((entry, index) =>
    mergeCombatRuleFields(Array.isArray(previous) ? previous[index] : undefined, entry, [
      'actor',
      'status',
      'measure',
      'trigger',
      'fired',
      'resource',
      'operator',
      'value',
    ]),
  )
}

export function mergeCombatScenarios(
  previous: unknown,
  scenarios: CombatSource['simulationScenarios'],
) {
  if (!scenarios) return undefined

  return Object.fromEntries(
    Object.entries(scenarios).map(([id, scenario]) => {
      const old = object(object(previous)[id])
      const setup = object(old.setup)
      const steps = (Array.isArray(old.steps) ? old.steps : []).map(object)

      return [
        id,
        {
          ...old,
          ...scenario,
          setup: {
            ...setup,
            ...scenario.setup,
            phase: scenario.setup.phase,
            health: { ...scenario.setup.health },
            resources: { ...scenario.setup.resources },
            cooldowns: { ...scenario.setup.cooldowns },
            statuses: Object.fromEntries(
              Object.entries(scenario.setup.statuses).map(([actor, entries]) => [
                actor,
                entries.map((status) => {
                  const oldStatuses = object(setup.statuses)[actor]

                  const previous = (Array.isArray(oldStatuses) ? oldStatuses : [])
                    .map(object)
                    .find((entry) => entry.id === status.id)

                  return {
                    ...previous,
                    ...status,
                    stacks: status.stacks,
                    intensity: status.intensity,
                  }
                }),
              ]),
            ),
          },
          steps: scenario.steps.map((step) => {
            const previous = steps.find((entry) => entry.id === step.id)
            const plan = previous?.plan

            return {
              ...previous,
              ...step,
              expect: expectations(previous?.expect, step.expect),
              plan: step.plan.map((move, index) => ({
                ...object(Array.isArray(plan) ? plan[index] : undefined),
                ...move,
                target: move.target,
              })),
            }
          }),
          expect: expectations(old.expect, scenario.expect),
        },
      ]
    }),
  )
}

export function editCombatScenario(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<
    EditorCommand,
    { type: 'combat.upsertSimulationScenario' | 'combat.removeSimulationScenario' }
  >,
) {
  if (!game.combat?.includes(command.encounterId))
    throw new EditorError(404, 'combat_not_found', 'Save the encounter before saving scenarios')
  const file = combatFile(command.encounterId)
  const previous = object(documents[file])
  const scenarios = { ...object(previous.simulationScenarios) }

  if (command.type === 'combat.removeSimulationScenario') {
    if (!Object.hasOwn(scenarios, command.scenarioId))
      throw new EditorError(404, 'scenario_not_found', 'Scenario does not exist')
    delete scenarios[command.scenarioId]
  } else {
    const exists = Object.keys(scenarios).find(
      (id) => id.toLowerCase() === command.scenarioId.toLowerCase(),
    )

    if ((command.createOnly && exists) || (exists && exists !== command.scenarioId))
      throw new EditorError(409, 'scenario_exists', 'A scenario with this ID already exists')
    scenarios[command.scenarioId] = mergeCombatScenarios(scenarios, {
      [command.scenarioId]: command.scenario,
    })![command.scenarioId]
  }

  documents[file] = { ...previous, simulationScenarios: scenarios }

  return [file]
}
