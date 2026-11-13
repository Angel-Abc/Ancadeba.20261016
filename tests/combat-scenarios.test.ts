import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import {
  combatSimulationScenarioSchema,
  combatSourceSchema,
  cloneCombatRules,
} from '@ancadeba/schemas'
import {
  runCombatScenario,
  checkCombatScenario,
  combatSimulationSetup,
  CombatSimulation,
  GameLoader,
} from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'
import {
  applyCommand,
  inspectProject,
  object,
  validateProject,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'

async function project(): Promise<ProjectSnapshot> {
  const root = new URL('../sample-games/combat-mechanics/', import.meta.url)

  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replaceAll('\\', '/'))

  return {
    revision: 'scenarios',
    documents: Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [file, JSON.parse(await readFile(new URL(file, root), 'utf8'))]),
      ),
    ),
  }
}

async function fixture(id = 'boss') {
  const source = await project()
  const view = inspectProject(source)
  expect(view.diagnostics).toEqual([])
  const definition = view.combat![id]!

  const base = combatSimulationSetup(
    definition,
    (binding) =>
      view.rules!.state.find((field) => JSON.stringify(field.path) === JSON.stringify(binding.path))
        ?.value,
  )

  return {
    source,
    view,
    definition,
    base,
    scenarios: view.combatSources![id]!.simulationScenarios!,
  }
}

describe('saved simulation scenario schema', () => {
  it('requires checks, unique step IDs, valid seeds and bounded work', () => {
    const valid = {
      steps: [{ id: 'one', plan: [] }],
      expect: [{ type: 'outcome', value: 'planning' }],
    }

    expect(combatSimulationScenarioSchema.parse(valid)).toMatchObject({
      setup: { seed: 1, round: 1 },
      steps: [{ repeat: 1, unavailable: 'fail' }],
    })
    expect(combatSimulationScenarioSchema.safeParse({ ...valid, expect: [] }).success).toBe(false)
    expect(
      combatSimulationScenarioSchema.safeParse({
        ...valid,
        steps: [{ id: 'same' }, { id: 'same' }],
      }).success,
    ).toBe(false)
    expect(combatSimulationScenarioSchema.safeParse({ ...valid, setup: { seed: 0 } }).success).toBe(
      false,
    )
    expect(
      combatSimulationScenarioSchema.safeParse({
        ...valid,
        steps: Array.from({ length: 11 }, (_, index) => ({ id: `round-${index}`, repeat: 100 })),
      }).success,
    ).toBe(false)
    expect(
      combatSimulationScenarioSchema.safeParse({ ...valid, steps: [{ id: '__proto__' }] }).success,
    ).toBe(false)
  })
})

describe('scenario replay and expectations', () => {
  it('applies the unavailable-action policy to moves blocked during resolution as well as planning', async () => {
    const { definition, base } = await fixture('water')

    const scenario = combatSimulationScenarioSchema.parse({
      setup: { seed: 1024, resources: { exhaustion: 55 } },
      steps: [{ id: 'fatigue', plan: [{ move: 'guard' }, { move: 'guard' }, { move: 'guard' }] }],
      expect: [{ type: 'outcome', value: 'planning' }],
    })

    expect(runCombatScenario(definition, base, scenario, 2)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('during resolution: apUnavailable'),
    })
    scenario.steps[0]!.unavailable = 'skip'
    expect(runCombatScenario(definition, base, scenario, 2)).toMatchObject({
      status: 'passed',
      skipped: [{ step: 'fatigue', iteration: 1, move: 'guard', reason: 'apUnavailable' }],
    })
    const stunned = cloneCombatRules(definition)
    stunned.statuses!.stun = { type: 'stun', label: 'Stunned', description: '', duration: 1 }
    stunned.mechanics!.triggers.stun = {
      event: 'turn-start',
      actor: 'player',
      once: false,
      conditions: [],
      effects: [{ type: 'apply-status', actor: 'player', status: 'stun' }],
    }
    scenario.setup.resources.exhaustion = 0
    const stopped = runCombatScenario(stunned, base, scenario)
    expect(stopped.status).toBe('passed')
    expect(stopped.skipped).toHaveLength(3)
    expect(stopped.skipped.every((skip) => skip.reason === 'stunned')).toBe(true)
  })

  it.each(['water', 'boss', 'shared-water', 'rough-water', 'underwater-boss'])(
    'passes the saved %s scenarios using current resolved content',
    async (id) => {
      const { source, definition, base, scenarios } = await fixture(id)
      const before = JSON.stringify(source)
      expect(Object.keys(scenarios).length).toBeGreaterThan(0)

      for (const scenario of Object.values(scenarios)) {
        const result = runCombatScenario(definition, base, scenario, 2)
        expect(result.error).toBeUndefined()
        expect(result.status).toBe('passed')
        expect(result.checks.length).toBeGreaterThan(0)
        expect(result.simulation?.report().truncated).toBe(true)
        expect(runCombatScenario(definition, base, scenario).simulation?.snapshot()).toEqual(
          result.simulation?.snapshot(),
        )
        expect(Object.hasOwn(result.simulation!.definition, 'simulationScenarios')).toBe(false)
      }

      expect(JSON.stringify(source)).toBe(before)
    },
  )

  it('reports a regression after encounter changes without replacing expected results', async () => {
    const { definition, base, scenarios } = await fixture()
    const scenario = scenarios['three-seals']!
    const before = cloneCombatRules(scenario)
    const changed = cloneCombatRules(definition)
    const channel = changed.moves.channel!

    if (channel.type !== 'ability' || channel.effects[0]?.type !== 'change-resource')
      throw new Error('Expected channel')
    channel.effects[0].amount = 20
    const result = runCombatScenario(changed, base, scenario)
    expect(result.status).toBe('failed')
    expect(result.checks).toContainEqual({
      stage: 'final',
      expectation: { type: 'outcome', value: 'victory' },
      actual: 'planning',
      passed: false,
    })
    expect(
      result.checks.some(
        (check) => check.expectation.type === 'resource' && check.actual === 2 && !check.passed,
      ),
    ).toBe(true)
    expect(scenario).toEqual(before)
    const checkpoint = cloneCombatRules(scenarios['phase-response']!)
    checkpoint.steps[0]!.expect = [
      { type: 'resource', resource: 'breaks', operator: 'eq', value: 9 },
    ]
    const failed = runCombatScenario(definition, base, checkpoint)
    expect(failed.status).toBe('failed')
    expect(failed.checks.find((check) => check.stage === 'transition')?.passed).toBe(false)
    expect(
      failed.checks.filter((check) => check.stage === 'final').every((check) => check.passed),
    ).toBe(true)
  })

  it('distinguishes invalid references and unavailable actions from failed checks', async () => {
    const { definition, base, scenarios, source } = await fixture('water')
    const scenario = cloneCombatRules(scenarios['recover-fatigue']!)
    scenario.setup.resources.stamina = 0
    scenario.steps[0]!.plan = [{ move: 'jab', target: 'eel' }]
    expect(runCombatScenario(definition, base, scenario)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Insufficient resource'),
    })
    scenario.steps[0]!.unavailable = 'skip'
    scenario.expect = [
      { type: 'outcome', value: 'planning' },
      { type: 'rounds', operator: 'eq', value: 1 },
    ]
    expect(runCombatScenario(definition, base, scenario)).toMatchObject({
      status: 'passed',
      skipped: [{ step: 'recover', iteration: 1, move: 'jab' }],
    })

    for (const invalid of [
      { type: 'health', actor: 'missing', operator: 'eq', value: 0 },
      { type: 'resource', resource: 'missing', operator: 'eq', value: 0 },
      { type: 'status', actor: 'player', status: 'missing', operator: 'eq', value: 0 },
      { type: 'phase', value: 'missing' },
      { type: 'trigger', trigger: 'missing', fired: true },
    ]) {
      const broken = combatSimulationScenarioSchema.parse({ ...scenario, expect: [invalid] })
      expect(runCombatScenario(definition, base, broken).status).toBe('error')
    }

    scenario.steps[0]!.plan = [{ move: 'removed', target: 'eel' }]
    expect(runCombatScenario(definition, base, scenario).status).toBe('error')
    const documents = cloneCombatRules(source.documents)
    object(documents['combat/water.json']).simulationScenarios = { broken: scenario }
    expect(validateProject(documents)).toEqual([])
  })

  it('verifies numeric comparisons, absent statuses, strength and once-only triggers from state', async () => {
    const { definition, base } = await fixture('water')

    const simulation = new CombatSimulation(definition, {
      ...base,
      statuses: { player: [{ id: 'rhythm', source: 'player', remaining: 3, stacks: 2 }] },
    })

    for (const [operator, value, expected] of [
      ['eq', 2, true],
      ['gte', 2, true],
      ['lte', 2, true],
      ['gt', 1, true],
      ['lt', 3, true],
      ['gt', 2, false],
    ] as const)
      expect(
        checkCombatScenario(
          simulation,
          { type: 'status', actor: 'player', status: 'rhythm', measure: 'stacks', operator, value },
          'initial',
        ).passed,
      ).toBe(expected)
    expect(
      checkCombatScenario(
        simulation,
        {
          type: 'status',
          actor: 'player',
          status: 'rhythm',
          measure: 'intensity',
          operator: 'eq',
          value: 1,
        },
        'initial',
      ).passed,
    ).toBe(true)
    expect(
      checkCombatScenario(
        simulation,
        {
          type: 'status',
          actor: 'player',
          status: 'rhythm',
          measure: 'remaining',
          operator: 'eq',
          value: 3,
        },
        'initial',
      ).passed,
    ).toBe(true)
    expect(
      checkCombatScenario(
        simulation,
        {
          type: 'status',
          actor: 'eel',
          status: 'rhythm',
          measure: 'stacks',
          operator: 'eq',
          value: 0,
        },
        'initial',
      ).passed,
    ).toBe(true)
    expect(
      checkCombatScenario(
        simulation,
        { type: 'guard', actor: 'player', operator: 'eq', value: 0 },
        'initial',
      ).passed,
    ).toBe(true)
  })

  it('does not silently pass unexecuted later steps, and reports rejected trigger cascades', async () => {
    const { definition, base, scenarios } = await fixture()
    const extra = cloneCombatRules(scenarios['three-seals']!)
    extra.steps.push({
      id: 'unreachable',
      plan: [],
      repeat: 1,
      escape: false,
      unavailable: 'fail',
      expect: [{ type: 'outcome', value: 'victory' }],
    })
    expect(runCombatScenario(definition, base, extra)).toMatchObject({
      status: 'error',
      error: 'unreachable: Encounter finished before this step',
    })
    const changed = cloneCombatRules(definition)
    changed.mechanics!.triggers.cycle = {
      event: 'resource-changed',
      resource: 'seal',
      once: false,
      conditions: [],
      effects: [
        { type: 'set-resource', resource: 'seal', amount: 0 },
        { type: 'set-resource', resource: 'seal', amount: 1 },
      ],
    }
    const result = runCombatScenario(changed, base, scenarios['phase-response']!)
    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('operation limit'),
    })
    expect(result.simulation?.completedRounds).toBe(0)
    expect(result.simulation?.snapshot().health).toEqual(base.health)
  })
})

describe('scenario authoring commands', () => {
  it('keeps gameplay save compatibility stable when only scenarios change', async () => {
    const { source } = await fixture()
    const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

    const load = (documents: ProjectSnapshot['documents']) =>
      new GameLoader(
        new JsonResourceLoader(
          {
            readText: async (path) => JSON.stringify(documents[path]),
            readBytes: async () => new Uint8Array(),
          },
          logger,
        ),
      ).load()

    const before = await load(source.documents)
    const changed = cloneCombatRules(source.documents)
    object(changed['combat/boss.json']).simulationScenarios = {}
    const after = await load(changed)
    expect(after.saveCompatibility).toBe(before.saveCompatibility)
    const moves = object(object(changed['combat/boss.json']).moves)
    object(moves.guard).guard = 999
    expect((await load(changed)).saveCompatibility).not.toBe(before.saveCompatibility)
  })

  it('saves only scenarios, preserves extensions, resets union fields, and rejects accidental flattening or collisions', async () => {
    const { source, view, scenarios } = await fixture()
    const raw = object(source.documents['combat/boss.json'])
    raw.extension = 'encounter'
    const original = object(object(raw.simulationScenarios)['three-seals'])
    original.extension = 'scenario'
    object(original.setup).extension = 'setup'
    const oldExpect = original.expect

    if (!Array.isArray(oldExpect)) throw new Error('Expected array')
    oldExpect[0] = {
      type: 'health',
      actor: 'player',
      operator: 'eq',
      value: 80,
      extension: 'check',
    }
    const before = JSON.stringify(source)

    const command = {
      type: 'combat.upsertSimulationScenario' as const,
      encounterId: 'boss',
      scenarioId: 'three-seals',
      scenario: scenarios['three-seals']!,
    }

    const saved = applyCommand(source, command)
    expect(saved.changedFiles).toEqual(['combat/boss.json'])
    expect(JSON.stringify(source)).toBe(before)
    const next = object(saved.project.documents['combat/boss.json'])
    expect(next.extension).toBe('encounter')
    const scenario = object(object(next.simulationScenarios)['three-seals'])
    expect(scenario.extension).toBe('scenario')
    expect(object(scenario.setup).extension).toBe('setup')
    const serialized = JSON.parse(JSON.stringify(scenario))
    expect(serialized.expect[0]).toEqual({ type: 'outcome', value: 'victory', extension: 'check' })
    expect(() => applyCommand(source, { ...command, createOnly: true })).toThrow('already exists')
    expect(() => applyCommand(source, { ...command, scenarioId: 'THREE-SEALS' })).toThrow(
      'already exists',
    )
    expect(() =>
      applyCommand(source, { type: 'game.upsertCombat', encounter: view.combat!.boss! }),
    ).toThrow('Include simulationScenarios explicitly')

    const removed = applyCommand(saved.project, {
      type: 'combat.removeSimulationScenario',
      encounterId: 'boss',
      scenarioId: 'three-seals',
    })

    expect(
      inspectProject(removed.project).combatSources!.boss!.simulationScenarios,
    ).not.toHaveProperty('three-seals')
    expect(() =>
      applyCommand(removed.project, {
        type: 'combat.removeSimulationScenario',
        encounterId: 'boss',
        scenarioId: 'three-seals',
      }),
    ).toThrow('does not exist')
    const parsed = combatSourceSchema.parse(raw)
    const full = applyCommand(source, { type: 'game.upsertCombat', encounter: parsed })
    expect(
      object(object(full.project.documents['combat/boss.json']).simulationScenarios)[
        'phase-response'
      ],
    ).toBeDefined()
  })
})
