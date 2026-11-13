import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatSimulationScenarioSchema,
  inventorySchema,
} from '@ancadeba/schemas'
import {
  CombatSimulation,
  runCombatScenario,
  checkCombatScenario,
  CombatMetricCollector,
  combatMetricTotal,
  type CombatSimulationSetup,
} from '@ancadeba/game-runtime'
import { mergeCombatScenarios } from '../packages/editor-core/src/combatScenarioEditing.js'

function fixture() {
  const definition = combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'assertions',
    label: 'Assertions',
    player: {
      id: 'player',
      label: 'Diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 100,
      ap: 3,
      moves: ['hit', 'guard'],
    },
    enemies: [
      {
        id: 'eel',
        label: 'Eel',
        health: { source: 'game.state', path: ['eel'] },
        maximumHealth: 200,
        ap: 2,
        moves: ['hit'],
        ai: { fallback: 'wait', rules: [{ id: 'strike', move: 'hit', maxUses: 2 }] },
      },
    ],
    moves: {
      hit: {
        type: 'attack',
        label: 'Hit',
        apCost: 1,
        damageType: 'water',
        damage: { min: 10, max: 10 },
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 5 },
      heal: {
        type: 'ability',
        label: 'Heal',
        apCost: 1,
        cooldown: 1,
        target: 'self',
        effects: [{ id: 'heal', type: 'heal', amount: 20 }],
      },
    },
    itemUse: { owner: 'diver', itemTypes: ['potion', 'stone'] },
    statuses: {
      ward: {
        type: 'composite',
        label: 'Ward',
        duration: 5,
        passives: [{ library: 'water', id: 'shield' }],
      },
      dazed: { type: 'stun', label: 'Dazed', duration: 1 },
    },
    passiveDefinitions: {
      water: {
        shield: {
          label: 'Shield',
          triggers: {
            absorb: {
              event: 'damage-pending',
              target: 'self',
              perTurn: 1,
              charges: 2,
              cooldown: 1,
              conditions: [{ type: 'event-value', field: 'amount', operator: 'gt', value: 0 }],
              effects: [{ type: 'absorb-damage', resource: 'barrier', maximum: 4 }],
            },
          },
        },
      },
    },
    mechanics: { resources: { barrier: { initial: 10, maximum: 100 } } },
  })

  const use = { ability: { library: 'water', id: 'heal' }, contexts: ['combat'] }

  const inventory = inventorySchema.parse({
    'schema-version': '1.0.0',
    owners: { diver: { label: 'Diver' } },
    itemTypes: {
      potion: { label: 'Potion', use: { ...use, consumption: 'consume' } },
      stone: { label: 'Stone', use: { ...use, consumption: 'keep' } },
    },
    items: {
      bottle: { itemType: 'potion', placement: { type: 'carried', owner: 'diver' } },
      stone: { itemType: 'stone', placement: { type: 'carried', owner: 'diver' } },
    },
  })

  const setup: CombatSimulationSetup = {
    health: { player: 50, eel: 200 },
    maximumHealth: { player: 100, eel: 200 },
    statuses: { player: [{ id: 'ward', source: 'player', remaining: 5 }] },
    itemContext: { inventory },
  }

  return { definition, setup }
}

function eq<
  T extends
    | 'damage-total'
    | 'healing-total'
    | 'interception'
    | 'passive-activations'
    | 'action-choices'
    | 'item-consumption',
>(type: T, value: number) {
  return { type, operator: 'eq' as const, value }
}

describe('rich scenario assertions and committed simulation metrics', () => {
  it('checks every new assertion against actual effects even with a one-frame trace', () => {
    const { definition, setup } = fixture()

    const scenario = combatSimulationScenarioSchema.parse({
      setup: { statuses: setup.statuses },
      steps: [{ id: 'sip', plan: [{ move: 'heal', item: 'bottle' }] }],
      expect: [
        eq('damage-total', 16),
        eq('healing-total', 20),
        eq('passive-activations', 1),
        { ...eq('interception', 4), measure: 'spent', operation: 'absorb-damage' },
        { ...eq('action-choices', 2), actor: 'eel', move: 'hit', rule: 'strike', result: 'chosen' },
        {
          ...eq('action-choices', 2),
          actor: 'eel',
          move: 'hit',
          rule: 'strike',
          result: 'executed',
        },
        { ...eq('action-choices', 1), actor: 'player', move: 'heal', result: 'executed' },
        { type: 'cooldown', actor: 'player', move: 'heal', operator: 'eq', value: 1 },
        {
          type: 'trigger-cooldown',
          actor: 'player',
          library: 'water',
          passive: 'shield',
          sourceKind: 'status',
          sourceId: 'ward',
          trigger: 'absorb',
          operator: 'eq',
          value: 1,
        },
        { ...eq('item-consumption', 1), item: 'bottle', itemType: 'potion' },
      ],
    })

    const tiny = runCombatScenario(definition, setup, scenario, 1),
      full = runCombatScenario(definition, setup, scenario, 2000)

    expect(tiny.error).toBeUndefined()
    expect(tiny.checks.filter((check) => !check.passed)).toEqual([])
    expect(tiny.status).toBe('passed')
    expect(tiny.simulation!.report().truncated).toBe(true)
    expect(tiny.simulation!.statistics()).toEqual(full.simulation!.statistics())
    expect(tiny.simulation!.snapshot()).toEqual(full.simulation!.snapshot())
    expect(tiny.simulation!.preview().length).toBeGreaterThan(0)
    expect(tiny.simulation!.statistics()).toEqual(full.simulation!.statistics())
  })

  it('separates current-step totals from cumulative totals and checks cooldown recovery', () => {
    const { definition, setup } = fixture()

    const scenario = combatSimulationScenarioSchema.parse({
      setup: { statuses: setup.statuses },
      steps: [
        { id: 'first', plan: [{ move: 'heal', item: 'bottle' }], expect: [eq('damage-total', 16)] },
        {
          id: 'wait',
          repeat: 1,
          expect: [
            { ...eq('damage-total', 20), scope: 'step' },
            eq('damage-total', 36),
            { ...eq('healing-total', 0), scope: 'step' },
            { type: 'cooldown', actor: 'player', move: 'heal', operator: 'eq', value: 0 },
          ],
        },
      ],
      expect: [{ ...eq('item-consumption', 0), scope: 'step' }, eq('item-consumption', 1)],
    })

    const result = runCombatScenario(definition, setup, scenario, 1)
    expect(result.checks.filter((check) => !check.passed)).toEqual([])
    expect(result.status).toBe('passed')
  })

  it('supports reusable items without consuming them and reserves instances until undo or resolution', () => {
    const { definition, setup } = fixture(),
      sim = new CombatSimulation(definition, setup)

    expect(sim.queueIssue('heal')).toContain('unavailable')
    expect(sim.queueIssue('heal', 'eel', 'bottle')).toBeUndefined()
    sim.queue('heal', undefined, 'bottle')
    expect(sim.queueIssue('heal', undefined, 'bottle')).toContain('reserved')
    sim.undo()
    expect(sim.queueIssue('heal', undefined, 'bottle')).toBeUndefined()
    sim.queue('heal', undefined, 'bottle')
    sim.resolve()
    expect(sim.queueIssue('heal', undefined, 'bottle')).toContain('consumed')
    sim.resolve()
    sim.queue('heal', undefined, 'stone')
    sim.resolve()
    expect(
      checkCombatScenario(sim, { ...eq('item-consumption', 1), item: 'bottle' }, 'final').passed,
    ).toBe(true)
    expect(
      checkCombatScenario(sim, { ...eq('item-consumption', 0), item: 'stone' }, 'final').passed,
    ).toBe(true)
    expect(sim.report().consumedItems).toEqual(['bottle'])
    sim.reset()
    expect(sim.statistics()).toEqual([])
    expect(sim.queueIssue('heal', undefined, 'bottle')).toBeUndefined()
    expect(setup.itemContext!.inventory.items).toHaveProperty('bottle')
  })

  it('distinguishes actions selected before a hook from actions that actually execute', () => {
    const { definition, setup } = fixture()
    definition.mechanics!.triggers.stop = {
      event: 'before-action',
      actor: 'player',
      once: true,
      conditions: [],
      effects: [{ type: 'apply-status', actor: 'player', status: 'dazed' }],
    }

    const result = runCombatScenario(
      definition,
      setup,
      combatSimulationScenarioSchema.parse({
        steps: [{ id: 'interrupted', unavailable: 'skip', plan: [{ move: 'hit', target: 'eel' }] }],
        expect: [
          { ...eq('action-choices', 1), actor: 'player', result: 'chosen' },
          { ...eq('action-choices', 0), actor: 'player', result: 'executed' },
        ],
      }),
      1,
    )

    expect(result.status).toBe('passed')
    expect(result.skipped).toHaveLength(1)
  })

  it('uses actual healing and damage with overkill and overheal accounted separately', () => {
    const { definition, setup } = fixture()
    const healed = new CombatSimulation(definition, { ...setup, health: { player: 99, eel: 200 } })
    healed.queue('heal', undefined, 'bottle')
    healed.resolve()
    expect(
      checkCombatScenario(
        healed,
        { ...eq('healing-total', 1), source: 'player', move: 'heal' },
        'final',
      ).passed,
    ).toBe(true)
    expect(
      checkCombatScenario(healed, { ...eq('healing-total', 19), measure: 'overheal' }, 'final')
        .passed,
    ).toBe(true)
    const killed = new CombatSimulation(definition, { ...setup, health: { player: 50, eel: 3 } })
    killed.queue('hit', 'eel')
    killed.resolve()
    expect(
      checkCombatScenario(
        killed,
        { ...eq('damage-total', 3), target: 'eel', damageType: 'water' },
        'final',
      ).passed,
    ).toBe(true)
  })

  it('reports failed comparisons with the actual number and rejects unknown zero-count filters up front', () => {
    const { definition, setup } = fixture()

    const failed = runCombatScenario(
      definition,
      setup,
      combatSimulationScenarioSchema.parse({
        setup: { statuses: setup.statuses },
        steps: [{ id: 'wait' }],
        expect: [eq('damage-total', 999)],
      }),
    )

    expect(failed.status).toBe('failed')
    expect(failed.checks[0]).toMatchObject({ actual: 16, passed: false })

    for (const expectation of [
      { ...eq('damage-total', 0), source: 'missing' },
      { ...eq('damage-total', 0), damageType: 'typo' },
      { ...eq('action-choices', 0), move: 'missing' },
      { ...eq('action-choices', 0), rule: 'missing' },
      { ...eq('passive-activations', 0), passive: 'missing' },
      { ...eq('item-consumption', 0), item: 'missing' },
      { type: 'trigger-cooldown', trigger: 'absorb', actor: 'player', operator: 'eq', value: 0 },
    ]) {
      const result = runCombatScenario(
        definition,
        setup,
        combatSimulationScenarioSchema.parse({ steps: [{ id: 'wait' }], expect: [expectation] }),
      )

      expect(result.status).toBe('error')
      expect(result.simulation!.completedRounds).toBe(0)
    }
  })

  it('does not commit provisional metrics, consumption or history after a rejected round', () => {
    const { definition, setup } = fixture()
    definition.mechanics!.triggers.overflow = {
      event: 'round-end',
      once: false,
      conditions: [],
      effects: [
        { type: 'change-resource', resource: 'barrier', amount: Number.MAX_SAFE_INTEGER },
        { type: 'change-resource', resource: 'barrier', amount: Number.MAX_SAFE_INTEGER },
      ],
    }
    const sim = new CombatSimulation(definition, setup)
    sim.queue('heal', undefined, 'bottle')
    const before = sim.report()
    expect(() => sim.resolve()).toThrow('overflow')
    expect(sim.report()).toEqual(before)
  })

  it('rejects malformed scopes, measures and item/move mismatches without trusting scripted consumption flags', () => {
    const base = { steps: [{ id: 'wait' }], expect: [eq('interception', 0)] }
    expect(
      combatSimulationScenarioSchema.safeParse({
        ...base,
        expect: [{ ...eq('interception', 0), measure: 'unknown' }],
      }).success,
    ).toBe(false)
    expect(
      combatSimulationScenarioSchema.safeParse({
        ...base,
        expect: [{ ...eq('damage-total', 0), scope: 'round' }],
      }).success,
    ).toBe(false)
    const { definition, setup } = fixture()

    const result = runCombatScenario(
      definition,
      setup,
      combatSimulationScenarioSchema.parse({
        ...base,
        steps: [{ id: 'mismatch', plan: [{ move: 'hit', item: 'bottle' }] }],
      }),
    )

    expect(result.status).toBe('error')
    expect(result.error).toContain('does not match')
  })

  it('validates equipment source filters for injected loadouts without an inventory catalog', () => {
    const { definition, setup } = fixture()
    definition.player.equipmentOwner = 'diver'

    const sim = new CombatSimulation(definition, {
      ...setup,
      itemContext: undefined,
      equipment: {
        player: [
          {
            item: 'coat',
            itemType: 'coat',
            slot: 'body',
            label: 'Coat',
            effects: { passives: [{ library: 'water', id: 'shield' }] },
          },
        ],
      },
    })

    sim.resolve()
    expect(
      checkCombatScenario(
        sim,
        {
          ...eq('passive-activations', 1),
          actor: 'player',
          sourceKind: 'equipment',
          sourceId: 'coat',
        },
        'final',
      ).passed,
    ).toBe(true)
  })

  it('keeps reports and item catalog snapshots isolated from callers', () => {
    const { definition, setup } = fixture(),
      sim = new CombatSimulation(definition, setup)

    sim.resolve()
    const metrics = sim.statistics()
    metrics.length = 0
    delete sim.itemCatalog()!.inventory.items.bottle
    expect(sim.statistics().length).toBeGreaterThan(0)
    expect(sim.queueIssue('heal', undefined, 'bottle')).toBeUndefined()
    expect(combatMetricTotal(sim.statistics(), 'passive-activations', {}, 'count')).toBe(1)
  })

  it('bounds metric arithmetic and clears obsolete assertion fields while preserving extension data', () => {
    const collector = new CombatMetricCollector()
    collector.record({
      kind: 'damage-total',
      effect: {
        source: 'eel',
        target: 'player',
        amount: Number.MAX_SAFE_INTEGER,
        rawAmount: Number.MAX_SAFE_INTEGER,
        delivery: 'direct',
        reactive: false,
      },
    })
    expect(() =>
      collector.record({
        kind: 'damage-total',
        effect: {
          source: 'eel',
          target: 'player',
          amount: 1,
          rawAmount: 1,
          delivery: 'direct',
          reactive: false,
        },
      }),
    ).toThrow('overflow')

    const next = combatSimulationScenarioSchema.parse({
      steps: [{ id: 'wait', plan: [{ move: 'hit' }] }],
      expect: [eq('item-consumption', 0)],
    })

    const merged = mergeCombatScenarios(
      {
        test: {
          steps: [{ id: 'wait', plan: [{ move: 'heal', item: 'bottle', consume: false }] }],
          expect: [
            {
              type: 'damage-total',
              source: 'eel',
              move: 'hit',
              damageType: 'water',
              extension: 'keep',
            },
          ],
        },
      },
      { test: next },
    )!

    expect(merged.test!.expect[0]).toMatchObject({
      type: 'item-consumption',
      source: undefined,
      move: undefined,
      damageType: undefined,
      extension: 'keep',
    })
    expect(merged.test!.steps[0]!.plan[0]).toMatchObject({ item: undefined, consume: undefined })
  })
})
