import { combatRequirementsText } from './combatRequirements.js'
import {
  combatSimulationScenarioSchema,
  cloneCombatRules,
  type CombatDefinition,
  type CombatSimulationScenario,
  type CombatScenarioExpectation,
} from '@ancadeba/schemas'
import { CombatSimulation, type CombatSimulationSetup } from './combatSimulation.js'

export interface CombatScenarioCheck {
  readonly stage: string
  readonly expectation: CombatScenarioExpectation
  readonly actual: string | number | boolean | undefined
  readonly passed: boolean
}

export interface CombatScenarioResult {
  readonly status: 'passed' | 'failed' | 'error'
  readonly checks: readonly CombatScenarioCheck[]
  readonly skipped: readonly CombatScenarioSkip[]
  readonly error?: string | undefined
  readonly simulation?: CombatSimulation | undefined
}

export interface CombatScenarioSkip {
  readonly step: string
  readonly iteration: number
  readonly move?: string | undefined
  readonly reason: string
}

function compare(
  actual: number,
  expectation: { operator: 'eq' | 'gte' | 'lte' | 'gt' | 'lt'; value: number },
) {
  switch (expectation.operator) {
    case 'eq':
      return actual === expectation.value
    case 'gte':
      return actual >= expectation.value
    case 'lte':
      return actual <= expectation.value
    case 'gt':
      return actual > expectation.value
    case 'lt':
      return actual < expectation.value
  }
}

/** Expectations read authoritative final state, never the bounded debug trace. */
export function checkCombatScenario(
  simulation: CombatSimulation,
  expectation: CombatScenarioExpectation,
  stage: string,
): CombatScenarioCheck {
  const state = simulation.snapshot()
  const definition = simulation.definition
  let actual: CombatScenarioCheck['actual']

  if (
    'actor' in expectation &&
    ![definition.player, ...definition.enemies].some((actor) => actor.id === expectation.actor)
  )
    throw new Error(`Unknown expected actor: ${expectation.actor}`)

  switch (expectation.type) {
    case 'outcome':
      actual = state.outcome ?? 'planning'
      break
    case 'phase':
      if (!definition.mechanics?.phases[expectation.value])
        throw new Error(`Unknown expected phase: ${expectation.value}`)
      actual = state.mechanics?.phase
      break
    case 'health':
      actual = state.health[expectation.actor]
      break
    case 'guard':
      actual = state.guard[expectation.actor] ?? 0
      break
    case 'resource':
      if (!definition.mechanics?.resources[expectation.resource])
        throw new Error(`Unknown expected resource: ${expectation.resource}`)
      actual = state.mechanics?.resources[expectation.resource]
      break
    case 'status': {
      if (!definition.statuses?.[expectation.status])
        throw new Error(`Unknown expected status: ${expectation.status}`)

      const active = state.statuses[expectation.actor]?.find(
        (status) => status.id === expectation.status,
      )

      actual = active ? (active[expectation.measure] ?? 1) : 0
      break
    }

    case 'rounds':
      actual = simulation.completedRounds
      break
    case 'trigger':
      if (!definition.mechanics?.triggers[expectation.trigger]?.once)
        throw new Error(`Expected trigger must be once-only: ${expectation.trigger}`)
      actual = state.mechanics?.fired.includes(expectation.trigger) ?? false
      break
  }

  const passed =
    'operator' in expectation
      ? typeof actual === 'number' && compare(actual, expectation)
      : expectation.type === 'trigger'
        ? actual === expectation.fired
        : actual === expectation.value

  return cloneCombatRules({ stage, expectation, actual, passed })
}

/** Fresh run against the supplied current definition; checks never rewrite their expectations. */
export function runCombatScenario(
  definition: CombatDefinition,
  base: CombatSimulationSetup,
  input: CombatSimulationScenario,
  traceLimit = 500,
): CombatScenarioResult {
  const checks: CombatScenarioCheck[] = []
  const skipped: CombatScenarioSkip[] = []
  let simulation: CombatSimulation | undefined
  let stage = 'setup'

  try {
    const scenario = combatSimulationScenarioSchema.parse(input)
    const ids = new Set([definition.player, ...definition.enemies].map((actor) => actor.id))

    for (const map of [scenario.setup.health, scenario.setup.statuses, scenario.setup.cooldowns])
      for (const actor of Object.keys(map))
        if (!ids.has(actor)) throw new Error(`Unknown starting actor: ${actor}`)

    for (const step of scenario.steps)
      for (const move of step.plan) {
        if (
          ![...definition.player.moves, ...(definition.player.equipmentMoves ?? [])].includes(
            move.move,
          ) ||
          !definition.moves[move.move]
        )
          throw new Error(`Unknown player move in ${step.id}: ${move.move}`)

        if (move.target && !ids.has(move.target))
          throw new Error(`Unknown target in ${step.id}: ${move.target}`)
      }

    const { phase, ...setup } = scenario.setup
    simulation = new CombatSimulation(
      definition,
      {
        ...base,
        ...setup,
        ...(phase !== undefined ? { phase } : {}),
        health: { ...base.health, ...setup.health },
        resources: { ...base.resources, ...setup.resources },
      },
      traceLimit,
    )

    // Validate all expected references up front, including checkpoints after a terminal result.
    for (const expectation of [
      ...scenario.expect,
      ...scenario.steps.flatMap((step) => step.expect),
    ])
      checkCombatScenario(simulation, expectation, 'validate')

    for (const [index, step] of scenario.steps.entries()) {
      stage = step.id

      if (index && simulation.snapshot().outcome)
        throw new Error('Encounter finished before this step')

      for (
        let iteration = 1;
        iteration <= step.repeat && !simulation.snapshot().outcome;
        iteration++
      ) {
        for (const move of step.plan) {
          const issue = simulation.queueIssue(move.move, move.target)

          if (issue) {
            if (step.unavailable === 'fail')
              throw new Error(`Iteration ${iteration}, ${move.move}: ${issue}`)
            skipped.push({ step: step.id, iteration, move: move.move, reason: issue })
          } else simulation.queue(move.move, move.target)
        }

        const queued = simulation.snapshot().plan
        const resolved = simulation.resolve(step.escape)

        if (step.plan.length && !step.escape)
          for (const entry of resolved.entries)
            if (
              entry.actor === definition.player.id &&
              [
                'apUnavailable',
                'resourceUnavailable',
                'skipped',
                'stunned',
                'moveRestricted',
                'requirementsUnavailable',
              ].includes(entry.type)
            ) {
              const reason =
                entry.type === 'requirementsUnavailable'
                  ? `${entry.type}: ${combatRequirementsText(definition, entry.requirements ?? [], { self: entry.actor, target: entry.target })}`
                  : `${entry.type}${entry.resource ? `: ${entry.resource}` : entry.target ? `: ${entry.target}` : ''}`

              if (step.unavailable === 'fail')
                throw new Error(`Iteration ${iteration}, during resolution: ${reason}`)

              if (entry.type === 'stunned')
                skipped.push(
                  ...queued.map((action) => ({
                    step: step.id,
                    iteration,
                    move: action.move,
                    reason,
                  })),
                )
              else skipped.push({ step: step.id, iteration, move: entry.move, reason })
            }
      }

      for (const expectation of step.expect)
        checks.push(checkCombatScenario(simulation, expectation, step.id))
    }

    stage = 'final'

    for (const expectation of scenario.expect)
      checks.push(checkCombatScenario(simulation, expectation, 'final'))

    return {
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      skipped,
      simulation,
    }
  } catch (error) {
    return {
      status: 'error',
      checks,
      skipped,
      error: `${stage}: ${error instanceof Error ? error.message : String(error)}`,
      simulation,
    }
  }
}
