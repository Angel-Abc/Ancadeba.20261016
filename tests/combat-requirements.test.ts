import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatLibrarySchema,
  combatMoveSchema,
  combatSourceSchema,
  resolveCombatSource,
  savedCombatSchema,
  combatSimulationScenarioSchema,
  type CombatDefinition,
  type CombatMoveDefinition,
  type CombatCondition,
} from '@ancadeba/schemas'
import {
  CombatSimulation,
  combatMoveRequirements,
  combatMoveRequirementIssue,
  combatRequirementsText,
  resolveCombatRound,
  runCombatScenario,
  type CombatDebugFrame,
  type CombatConditionContext,
} from '@ancadeba/game-runtime'
import { mergeCombatEntries } from '../packages/editor-core/src/combatEntryEditing.js'

const energy: CombatCondition = { type: 'resource', resource: 'energy', operator: 'gte', value: 20 }

const focused: CombatCondition = {
  type: 'status',
  actor: 'self',
  status: 'focus',
  measure: 'stacks',
  operator: 'gte',
  value: 2,
}

const statuses = { player: [{ id: 'focus', source: 'player', remaining: 3, stacks: 2 }] }

function fixture(): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'requirements',
    label: 'Requirements',
    seed: 1024,
    player: {
      id: 'player',
      label: 'Diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 4,
      moves: ['burst', 'guard', 'focus', 'drain', 'cleanse', 'shift'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Eel',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 90,
        ap: 2,
        moves: ['burst', 'guard'],
        rotation: ['guard'],
      },
    ],
    moves: {
      burst: {
        type: 'ability',
        label: 'Burst',
        target: 'enemy',
        apCost: 1,
        resourceCosts: { energy: 10 },
        requirements: [energy, focused],
        effects: [{ id: 'hit', type: 'damage', damage: { min: 10, max: 10 } }],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 1 },
      focus: {
        type: 'ability',
        label: 'Focus',
        target: 'self',
        apCost: 1,
        effects: [{ id: 'focus', type: 'apply-status', status: 'focus', stacks: 2 }],
      },
      drain: {
        type: 'ability',
        label: 'Drain',
        target: 'self',
        apCost: 1,
        effects: [{ id: 'drain', type: 'change-resource', resource: 'energy', amount: -40 }],
      },
      cleanse: {
        type: 'ability',
        label: 'Cleanse',
        target: 'self',
        apCost: 1,
        effects: [{ id: 'cleanse', type: 'remove-status', status: 'focus', stacks: 1 }],
      },
      shift: { type: 'guard', label: 'Shift', apCost: 1, guard: 1 },
    },
    statuses: {
      focus: {
        type: 'modifier',
        label: 'Focus',
        duration: 3,
        modifiers: { defense: 1 },
        stacking: { maximum: 3 },
      },
    },
    mechanics: {
      resources: { energy: { label: 'Stamina', actor: 'player', initial: 40, maximum: 100 } },
      phases: { opening: { label: 'Opening' }, final: { label: 'Final seal' } },
      initialPhase: 'opening',
      triggers: {},
    },
  })
}

const context = (overrides: Partial<CombatConditionContext> = {}): CombatConditionContext => ({
  health: { player: 80, enemy: 90 },
  maximumHealth: { player: 80, enemy: 90 },
  resources: { energy: 40 },
  statuses,
  phase: 'opening',
  self: 'player',
  target: 'enemy',
  ...overrides,
})

function simulation(
  definition = fixture(),
  setup: Partial<ConstructorParameters<typeof CombatSimulation>[1]> = {},
) {
  return new CombatSimulation(definition, {
    health: { player: 80, enemy: 90 },
    maximumHealth: { player: 80, enemy: 90 },
    statuses,
    ...setup,
  })
}

function resolve(
  definition: CombatDefinition,
  moves: string[],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
) {
  const frames: CombatDebugFrame[] = []

  const result = resolveCombatRound(
    definition,
    {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      statuses,
      guard: {},
      seed: 1024,
      escape: false,
      enemies: { enemy: { moves: [], cursor: 0 } },
      plan: moves.map((move) => ({
        move,
        target:
          definition.moves[move]?.type === 'guard' ||
          (definition.moves[move]?.type === 'ability' && definition.moves[move].target === 'self')
            ? 'player'
            : 'enemy',
      })),
      ...options,
    },
    (frame) => {
      frames.push(frame)
    },
  )

  return { result, frames }
}

describe('shared combat action requirements', () => {
  it('supports requirements on attacks, Guard and abilities and bounds expression lists', () => {
    for (const type of ['attack', 'guard', 'ability'])
      expect(
        combatMoveSchema.parse({
          type,
          label: type,
          apCost: 1,
          guard: 1,
          damage: { min: 1, max: 1 },
          target: 'self',
          effects: [{ id: 'heal', type: 'heal', amount: 1 }],
          requirements: [energy],
        }).requirements,
      ).toEqual([energy])
    expect(
      combatMoveSchema.safeParse({
        ...fixture().moves.guard,
        requirements: Array.from({ length: 21 }, () => energy),
      }).success,
    ).toBe(false)
    expect(combatMoveSchema.parse(fixture().moves.guard).requirements).toBeUndefined()
  })

  it('rejects unknown references and event-only expressions in resolved moves and libraries', () => {
    const conditions: CombatCondition[] = [
      { ...energy, resource: 'missing' },
      { ...focused, status: 'missing' },
      { ...focused, actor: 'missing' },
      { type: 'phase', phase: 'missing' },
      { type: 'event-value', field: 'amount', operator: 'gte', value: 1 },
      { type: 'health', actor: 'event.target', operator: 'gte', value: 1 },
    ]

    for (const condition of conditions) {
      const definition = fixture()
      definition.moves.guard!.requirements = [condition]
      expect(combatDefinitionSchema.safeParse(definition).success).toBe(false)
    }

    expect(
      combatLibrarySchema.safeParse({
        'schema-version': '1.0.0',
        id: 'common',
        moves: {
          guard: {
            ...fixture().moves.guard,
            requirements: [{ type: 'event-flag', field: 'immune', value: true }],
          },
        },
      }).success,
    ).toBe(false)
  })

  it('evaluates nested groups, percentages and target aliases with actual values', () => {
    const definition = fixture()

    const move: CombatMoveDefinition = {
      ...definition.moves.burst!,
      requirements: [
        {
          type: 'and',
          conditions: [
            { ...energy, value: 40, unit: 'percent' },
            { type: 'or', conditions: [focused, { type: 'phase', phase: 'final' }] },
            { type: 'not', condition: { ...focused, actor: 'target' } },
          ],
        },
      ],
    }

    expect(combatMoveRequirements(definition, move!, context())[0]!.matched).toBe(true)

    const issue = combatMoveRequirementIssue(
      definition,
      move!,
      context({ resources: { energy: 10 }, statuses: {} }),
    )!

    expect(issue).toContain('Stamina ≥ 40% (current 10% (10/100))')
    expect(issue).toContain('AND')
    expect(issue).toContain('OR')
    expect(issue).toContain('NOT')
    expect(issue).toContain('Focus')
    expect(issue).toContain('current 0')
  })

  it('fails closed for unresolved values, including NOT, and uses effective maximum health', () => {
    const definition = fixture()
    definition.moves.guard!.requirements = [{ type: 'not', condition: energy }]
    expect(
      combatMoveRequirementIssue(definition, definition.moves.guard!, context({ resources: {} })),
    ).toContain('unknown')
    definition.moves.guard!.requirements = [
      { type: 'health', actor: 'self', operator: 'gte', value: 60, unit: 'percent' },
    ]
    expect(
      combatMoveRequirementIssue(
        definition,
        definition.moves.guard!,
        context({ maximumHealth: { player: 160, enemy: 90 } }),
      ),
    ).toContain('50% (80/160)')
    expect(combatMoveRequirements(definition, definition.moves.guard!, context())[0]!.matched).toBe(
      true,
    )
  })

  it('reserves prior costs for planning requirements and releases them on Undo and Clear', () => {
    const sim = simulation()

    for (let i = 0; i < 3; i++) sim.queue('burst', 'enemy')
    expect(sim.queueIssue('burst', 'enemy')).toContain('current 10')
    expect(sim.snapshot().mechanics!.resources.energy).toBe(40)
    sim.undo()
    expect(sim.queueIssue('burst', 'enemy')).toBeUndefined()
    sim.clear()
    expect(sim.snapshot().plan).toEqual([])
    expect(sim.queueIssue('burst', 'enemy')).toBeUndefined()
  })

  it('does not predict queued buffs or gains to unlock actions', () => {
    const sim = simulation(fixture(), { statuses: {} })
    sim.queue('focus')
    expect(sim.queueIssue('burst', 'enemy')).toContain('Focus')
    sim.resolve()
    expect(sim.queueIssue('burst', 'enemy')).toBeUndefined()
  })

  it('rechecks after earlier actions and skips without costs, RNG or cooldowns', () => {
    const definition = fixture()
    definition.moves.burst!.cooldown = 2
    const { result, frames } = resolve(definition, ['cleanse', 'burst', 'guard'])
    expect(result.health.enemy).toBe(90)
    expect(result.seed).toBe(1024)
    expect(result.mechanics!.resources.energy).toBe(40)
    expect(result.cooldowns.player?.burst).toBeUndefined()
    expect(result.guard.player).toBe(1)
    expect(result.entries.find((entry) => entry.type === 'requirementsUnavailable')).toMatchObject({
      actor: 'player',
      move: 'burst',
      requirements: [focused],
    })
    expect(frames.find((frame) => frame.requirements)).toMatchObject({
      spentAp: 1,
      requirements: [{ matched: true }, { matched: false, actual: 1 }],
    })
  })

  it('checks turn-start and before-action changes before paying, and never runs hooks for initially blocked actions', () => {
    const definition = fixture()
    definition.mechanics!.triggers.block = {
      event: 'before-action',
      actor: 'player',
      move: 'burst',
      once: false,
      conditions: [],
      effects: [{ type: 'set-resource', resource: 'energy', amount: 0 }],
    }
    expect(
      resolve(definition, ['burst']).result.entries.some(
        (entry) => entry.type === 'requirementsUnavailable',
      ),
    ).toBe(true)
    definition.mechanics!.triggers.block!.event = 'turn-start'
    delete definition.mechanics!.triggers.block!.move
    const result = resolve(definition, ['burst']).result
    expect(result.seed).toBe(1024)
    expect(result.health.enemy).toBe(90)
    delete definition.mechanics!.triggers.block
    definition.mechanics!.triggers.unreachable = {
      event: 'before-action',
      actor: 'player',
      move: 'burst',
      once: false,
      conditions: [],
      effects: [{ type: 'set-phase', phase: 'final' }],
    }
    expect(resolve(definition, ['burst'], { statuses: {} }).result.mechanics!.phase).toBe('opening')
  })

  it('rechecks phase gates after earlier actions change the active boss phase', () => {
    const definition = fixture()
    definition.moves.burst!.requirements = [{ type: 'phase', phase: 'final' }]
    definition.mechanics!.triggers.revert = {
      event: 'after-action',
      actor: 'player',
      move: 'shift',
      once: false,
      conditions: [],
      effects: [{ type: 'set-phase', phase: 'opening' }],
    }
    expect(simulation(definition).queueIssue('burst', 'enemy')).toContain('Final seal')

    const { result } = resolve(definition, ['shift', 'burst'], {
      mechanics: { resources: { energy: 40 }, phase: 'final', initialized: true, fired: [] },
    })

    expect(result.mechanics!.phase).toBe('opening')
    expect(result.mechanics!.resources.energy).toBe(40)
    expect(result.health.enemy).toBe(90)
    expect(
      result.entries.find((entry) => entry.type === 'requirementsUnavailable')!.requirements,
    ).toEqual([{ type: 'phase', phase: 'final' }])
  })

  it('does not consume a queued item or its costs when the shared ability requirement fails', () => {
    const definition = fixture()
    definition.moves.burst!.cooldown = 2

    const { result } = resolve(definition, [], {
      statuses: {},
      plan: [
        { move: 'burst', target: 'enemy', item: 'scroll', itemType: 'scroll', consume: true },
        { move: 'guard', target: 'player' },
      ],
    })

    expect(result.usedItems).toEqual([])
    expect(result.mechanics!.resources.energy).toBe(40)
    expect(result.cooldowns.player?.burst).toBeUndefined()
    expect(result.guard.player).toBe(1)
  })

  it('uses the queued target rather than a later target selection', () => {
    const definition = fixture()
    definition.moves.burst!.requirements = [{ ...focused, actor: 'target' }]
    expect(simulation(definition).queueIssue('burst', 'enemy')).toContain('Eel')

    const sim = simulation(definition, {
      statuses: { enemy: [{ id: 'focus', source: 'enemy', remaining: 3, stacks: 2 }] },
    })

    expect(sim.queueIssue('burst', 'enemy')).toBeUndefined()
    sim.queue('burst', 'enemy')
    expect(sim.resolve().health.enemy).toBe(82)
  })

  it('explains requirements in conditional and rotation AI and continues to another usable move', () => {
    const definition = fixture()
    const enemy = definition.enemies[0]!
    enemy.rotation = ['burst', 'guard']
    enemy.ai = {
      rules: [{ id: 'try-burst', move: 'burst', conditions: [], maxUses: 1 }],
      fallback: 'rotation',
    }
    const sim = simulation(definition)
    const preview = sim.preview()[0]!
    expect(preview.choice!.move).toBe('guard')
    expect(preview.candidates[0]).toMatchObject({
      blockers: ['requirements'],
      requirements: [{ matched: true }, { matched: false, actual: 0 }],
    })
    expect(sim.resolve().health.player).toBe(80)
    enemy.ai = undefined
    expect(simulation(definition).preview()[0]!.candidates[0]!.blockers).toContain('requirements')
  })

  it('imports requirement status dependencies from shared moves and validates encounter resources/phases', () => {
    const definition = fixture()

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'shared',
      moves: { burst: definition.moves.burst },
      statuses: definition.statuses,
    })

    const source = combatSourceSchema.parse({
      ...definition,
      statuses: undefined,
      moves: Object.fromEntries(Object.entries(definition.moves).filter(([id]) => id !== 'burst')),
    })

    delete source.moves.burst
    delete source.moves.focus
    delete source.moves.cleanse
    source.player.moves = ['burst', 'guard']
    source.sharedMoves = [{ library: 'shared', id: 'burst' }]
    const resolved = resolveCombatSource(source, new Map([['shared', library]]))
    expect(resolved.issues).toEqual([])
    expect(resolved.definition!.statuses!.focus).toBeDefined()
    source.mechanics!.resources = {}
    expect(
      resolveCombatSource(source, new Map([['shared', library]])).issues.some((issue) =>
        issue.message.includes('energy'),
      ),
    ).toBe(true)
  })

  it('preserves condition extensions and removes cleared requirements when editing moves', () => {
    const definition = fixture()

    const old = {
      moves: {
        burst: { ...definition.moves.burst, requirements: [{ ...energy, extension: 'keep' }] },
      },
    }

    definition.moves.burst!.requirements = [{ ...energy, value: 30 }]
    expect(mergeCombatEntries(old, definition).moves.burst!.requirements).toEqual([
      { ...energy, value: 30, extension: 'keep' },
    ])
    definition.moves.burst!.requirements = undefined
    expect(mergeCombatEntries(old, definition).moves.burst!.requirements).toBeUndefined()
  })

  it('honors scenario fail/skip for planning and resolution requirement failures', () => {
    const definition = fixture()
    const base = simulation(definition).report().setup

    const scenario = combatSimulationScenarioSchema.parse({
      setup: { statuses },
      steps: [
        { id: 'lose-focus', plan: [{ move: 'cleanse' }, { move: 'burst', target: 'enemy' }] },
      ],
      expect: [{ type: 'health', actor: 'enemy', operator: 'eq', value: 90 }],
    })

    expect(runCombatScenario(definition, base, scenario).error).toContain('requirementsUnavailable')
    scenario.steps[0]!.unavailable = 'skip'
    expect(runCombatScenario(definition, base, scenario)).toMatchObject({
      status: 'passed',
      skipped: [{ move: 'burst', reason: expect.stringContaining('requirementsUnavailable') }],
    })
    scenario.setup.statuses = {}
    expect(runCombatScenario(definition, base, scenario).status).toBe('passed')
  })

  it('persists failed requirements in logs and supports localized availability messages', () => {
    const definition = fixture()
    const { result } = resolve(definition, ['cleanse', 'burst'])

    const saved = savedCombatSchema.parse({
      round: 2,
      seed: result.seed,
      started: true,
      guard: result.guard,
      plan: [],
      enemies: {},
      statuses: result.statuses,
      cooldowns: result.cooldowns,
      escape: false,
      log: result.entries,
      mechanics: result.mechanics,
    })

    expect(
      saved.log.find((entry) => entry.type === 'requirementsUnavailable')!.requirements,
    ).toEqual([focused])
    definition.messages.requirementsUnavailable = '{move}: vereist {requirements}'
    definition.messages.requirementCurrent = '{requirement} (nu {actual})'
    expect(
      combatMoveRequirementIssue(
        definition,
        definition.moves.burst!,
        context({ resources: { energy: 10 } }),
      ),
    ).toContain('Burst: vereist Stamina ≥ 20 (nu 10)')
    expect(combatRequirementsText(definition, [focused], { self: 'enemy' })).toContain('Eel')
  })
})
