import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatTriggerSchema,
  combatMechanicsStateSchema,
  combatMechanicsOverridesSchema,
  applyCombatMechanicsOverrides,
  previewCombatMechanicsOverrides,
  diffCombatMechanics,
  type CombatDefinition,
  type CombatTriggerDefinition,
} from '@ancadeba/schemas'
import {
  CombatSimulation,
  validateCombatMechanicsState,
  resolveCombatRound,
} from '@ancadeba/game-runtime'
import { mergeCombatMechanics } from '../packages/editor-core/src/combatMechanicsEditing.js'

function fixture(trigger: Partial<CombatTriggerDefinition> = {}): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'limits',
    label: 'Trigger limits',
    player: {
      id: 'player',
      label: 'Diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 160,
      ap: 3,
      moves: ['hit', 'cleanse', 'ward'],
    },
    enemies: [
      {
        id: 'eel',
        label: 'Eel',
        health: { source: 'game.state', path: ['eel'] },
        maximumHealth: 160,
        ap: 2,
        moves: ['hit'],
        rotation: ['hit'],
      },
    ],
    moves: {
      hit: { type: 'attack', label: 'Wave', apCost: 1, damage: { min: 10, max: 10 } },
      cleanse: {
        type: 'ability',
        label: 'Cleanse',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'cleanse', type: 'remove-status', status: 'ward' }],
      },
      ward: {
        type: 'ability',
        label: 'Ward',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'ward', type: 'apply-status', status: 'ward' }],
      },
    },
    mechanics: {
      resources: { energy: { initial: 0, maximum: 100 }, barrier: { initial: 6, maximum: 100 } },
      triggers: {
        refund: {
          event: 'damage-received',
          target: 'player',
          effects: [{ type: 'change-resource', resource: 'energy', amount: 1 }],
          ...trigger,
        },
      },
    },
    statuses: {
      ward: {
        type: 'composite',
        label: 'Ward',
        duration: 20,
        passives: [{ library: 'water', id: 'ward' }],
      },
    },
    passiveDefinitions: {
      water: {
        ward: {
          label: 'Ward',
          triggers: {
            absorb: {
              event: 'damage-pending',
              target: 'self',
              effects: [{ type: 'absorb-damage', resource: 'barrier' }],
            },
          },
        },
      },
    },
  })
}

function simulation(definition: CombatDefinition, statuses = false) {
  return new CombatSimulation(
    definition,
    {
      health: { player: 160, eel: 160 },
      maximumHealth: { player: 160, eel: 160 },
      ...(statuses
        ? { statuses: { player: [{ id: 'ward', source: 'player', remaining: 20 }] } }
        : {}),
    },
    2000,
  )
}

const activations = (sim: CombatSimulation) => sim.snapshot().mechanics!.activations!

const traces = (sim: CombatSimulation) =>
  sim.trace().flatMap((frame) => (frame.mechanicsEvent ? [frame.mechanicsEvent] : []))

describe('trigger priorities and activation limits', () => {
  it('validates bounded optional controls without adding defaults to legacy triggers', () => {
    for (const patch of [
      { priority: 10001 },
      { priority: 0.5 },
      { charges: 0 },
      { charges: 10001 },
      { perTurn: -1 },
      { perTurn: 1.5 },
      { cooldown: -1 },
      { cooldown: 1001 },
    ])
      expect(
        combatTriggerSchema.safeParse({
          event: 'round-start',
          effects: [{ type: 'finish', outcome: 'victory' }],
          ...patch,
        }).success,
      ).toBe(false)

    const trigger = combatTriggerSchema.parse({
      event: 'round-start',
      effects: [{ type: 'change-resource', resource: 'energy', amount: 1 }],
    })

    expect(trigger).not.toHaveProperty('priority')
    expect(trigger).not.toHaveProperty('charges')
    expect(
      combatTriggerSchema.parse({ ...trigger, priority: -10, charges: 2, perTurn: 1, cooldown: 0 }),
    ).toMatchObject({ priority: -10, charges: 2, perTurn: 1, cooldown: 0 })
  })

  it('sorts encounter and passive interceptors together and preserves existing tie order', () => {
    const definition = fixture({
      event: 'damage-pending',
      effects: [{ type: 'adjust-effect', amount: 0, percent: -50 }],
    })

    definition.enemies[0]!.ap = 1
    const absorb = definition.passiveDefinitions!.water!.ward!.triggers.absorb!
    absorb.priority = 10
    const high = simulation(definition, true)
    high.resolve()
    expect(high.snapshot().health.player).toBe(158)
    expect(high.snapshot().mechanics!.resources.barrier).toBe(0)
    expect(
      traces(high)
        .filter((entry) => entry.interception)
        .map((entry) => entry.trigger),
    ).toEqual(['absorb', 'refund'])
    absorb.priority = 0
    const tied = simulation(definition, true)
    tied.resolve()
    expect(tied.snapshot().health.player).toBe(160)
    expect(tied.snapshot().mechanics!.resources.barrier).toBe(1)
    absorb.priority = -10
    const low = simulation(definition, true)
    low.resolve()
    expect(low.snapshot().health.player).toBe(160)
  })

  it('limits activations per combatant turn, skips cooldown rounds and exhausts encounter charges', () => {
    const sim = simulation(fixture({ priority: 5, charges: 3, perTurn: 1, cooldown: 1 }))
    const totals: number[] = []

    for (let round = 1; round <= 6; round++) {
      sim.resolve()
      totals.push(sim.snapshot().mechanics!.resources.energy!)
    }

    expect(totals).toEqual([1, 1, 2, 2, 3, 3])
    expect(activations(sim)[0]).toMatchObject({ trigger: 'refund', uses: 3, readyRound: 7 })

    const blocked = traces(sim)
      .filter((entry) => entry.matched === false)
      .flatMap((entry) => entry.activation?.blockers ?? [])

    expect(blocked).toContain('per-turn')
    expect(blocked).toContain('cooldown')
    expect(blocked).toContain('charges')
    expect(traces(sim).filter((entry) => entry.activated)).toHaveLength(3)
  })

  it('resets per-turn budgets at each actor turn, rather than only once per round', () => {
    const definition = fixture({ event: 'damage-resolved', target: undefined, perTurn: 1 })
    const sim = simulation(definition)
    sim.queue('hit', 'eel')
    sim.queue('hit', 'eel')
    sim.queue('hit', 'eel')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(2)
    expect(activations(sim)[0]).toMatchObject({ uses: 2, turn: 2, turnUses: 1 })
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(3)
  })

  it('does not consume activations when filters or conditions fail and keeps Once as a stricter cap', () => {
    const definition = fixture({
      charges: 3,
      once: true,
      conditions: [{ type: 'resource', resource: 'energy', operator: 'gte', value: 1 }],
    })

    const sim = simulation(definition)
    sim.resolve()
    expect(sim.snapshot().mechanics!.activations).toBeUndefined()
    definition.mechanics!.triggers.refund!.conditions = []
    const once = simulation(definition)
    once.resolve()
    once.resolve()
    expect(activations(once)[0]!.uses).toBe(1)
    expect(once.snapshot().mechanics!.fired).toEqual(['refund'])
    expect(traces(once).some((entry) => entry.activation?.blockers.includes('once'))).toBe(true)
  })

  it('tracks each granting source separately and preserves exhausted limits after cleansing and reapplication', () => {
    const definition = fixture()
    definition.mechanics!.triggers = {}
    const trigger = definition.passiveDefinitions!.water!.ward!.triggers.absorb!
    Object.assign(trigger, {
      event: 'damage-received',
      charges: 1,
      perTurn: 1,
      effects: [{ type: 'change-resource', resource: 'energy', amount: 1 }],
    })
    definition.statuses!.other = { ...definition.statuses!.ward!, label: 'Other ward' }

    const sim = new CombatSimulation(definition, {
      health: { player: 160, eel: 160 },
      maximumHealth: { player: 160, eel: 160 },
      statuses: {
        player: [
          { id: 'ward', source: 'player', remaining: 20 },
          { id: 'other', source: 'eel', remaining: 20 },
        ],
      },
    })

    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(2)
    expect(activations(sim).map((entry) => entry.passive?.id)).toEqual(['ward', 'other'])
    sim.queue('cleanse')
    sim.queue('ward')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(2)
    expect(activations(sim).map((entry) => entry.uses)).toEqual([1, 1])
  })

  it('keeps equipment copies independent from each other and from a status granting the same passive', () => {
    const definition = fixture()
    definition.player.equipmentOwner = 'diver'
    definition.mechanics!.triggers = {}
    const trigger = definition.passiveDefinitions!.water!.ward!.triggers.absorb!
    Object.assign(trigger, {
      event: 'damage-received',
      charges: 2,
      perTurn: 1,
      cooldown: 1,
      effects: [{ type: 'change-resource', resource: 'energy', amount: 1 }],
    })

    const sim = new CombatSimulation(definition, {
      health: { player: 160, eel: 160 },
      maximumHealth: { player: 160, eel: 160 },
      statuses: { player: [{ id: 'ward', source: 'player', remaining: 20 }] },
      equipment: {
        player: ['first', 'second'].map((id) => ({
          item: id,
          itemType: 'charm',
          slot: id,
          label: id,
          effects: { passives: [{ library: 'water', id: 'ward' }] },
        })),
      },
    })

    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(3)
    expect(
      activations(sim).map((entry) => [entry.passive!.kind, entry.passive!.id, entry.uses]),
    ).toEqual([
      ['equipment', 'first', 1],
      ['equipment', 'second', 1],
      ['status', 'ward', 1],
    ])
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(3)
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(6)
    expect(activations(sim).every((entry) => entry.uses === 2)).toBe(true)
  })

  it('reserves charges before reactive effects can dispatch nested damage', () => {
    const sim = simulation(
      fixture({
        event: 'damage-resolved',
        target: undefined,
        includeReactions: true,
        charges: 2,
        effects: [{ type: 'damage', actor: 'event.source', source: 'event.target', amount: 1 }],
      }),
    )

    sim.resolve()
    expect(activations(sim)[0]!.uses).toBe(2)
    expect(sim.report().state.health).toEqual({ player: 139, eel: 159 })
    expect(
      sim
        .trace()
        .flatMap((frame) => frame.entries)
        .filter((entry) => entry.reactive && entry.type === 'attack'),
    ).toHaveLength(2)
  })

  it('serializes cooldowns and usage without mutating the supplied mechanics state', () => {
    const definition = fixture({ charges: 3, perTurn: 1, cooldown: 1 })
    const first = simulation(definition)
    first.resolve()

    const state = combatMechanicsStateSchema.parse(
      JSON.parse(JSON.stringify(first.snapshot().mechanics)),
    )

    const before = JSON.stringify(state)
    const current = first.snapshot()

    const second = resolveCombatRound(definition, {
      ...current,
      mechanics: state,
      round: 2,
      escape: false,
    })

    expect(second.mechanics!.resources.energy).toBe(1)
    const third = resolveCombatRound(definition, { ...current, ...second, round: 3, escape: false })
    expect(third.mechanics!.resources.energy).toBe(2)
    expect(JSON.stringify(state)).toBe(before)
  })

  it('rejects malformed, duplicate and unknown activation histories', () => {
    const definition = fixture({ charges: 3, perTurn: 1 })
    const sim = simulation(definition)
    sim.resolve()
    const state = sim.snapshot().mechanics!

    for (const patch of [
      { uses: 4 },
      { turnUses: 2 },
      { trigger: 'missing' },
      { turn: 999 },
      { readyRound: 2 },
    ]) {
      const invalid = { ...state, activations: [{ ...state.activations![0]!, ...patch }] }
      expect(() => validateCombatMechanicsState(definition, invalid)).toThrow('activation')
    }

    expect(() =>
      validateCombatMechanicsState(definition, {
        ...state,
        activations: [...state.activations!, ...state.activations!],
      }),
    ).toThrow('activation')
  })

  it('rolls back resources, charges, clocks, history and RNG after an effect fails', () => {
    const definition = fixture({
      charges: 2,
      perTurn: 1,
      effects: [
        { type: 'change-resource', resource: 'energy', amount: Number.MAX_SAFE_INTEGER },
        { type: 'change-resource', resource: 'energy', amount: Number.MAX_SAFE_INTEGER },
      ],
    })

    const sim = simulation(definition)
    const before = sim.report()
    expect(() => sim.resolve()).toThrow('overflow')
    expect(sim.report()).toEqual(before)
  })

  it('retains legacy state and debug shapes when no controls are configured', () => {
    const definition = fixture()
    const sim = simulation(definition)
    sim.resolve()
    expect(sim.snapshot().mechanics).not.toHaveProperty('activations')
    expect(sim.snapshot().mechanics).not.toHaveProperty('turn')
    expect(traces(sim).some((entry) => entry.activation !== undefined)).toBe(false)
  })

  it('round-trips controls and explicit removals through inherited overrides and editor merges', () => {
    const base = fixture({ priority: 20, charges: 3, perTurn: 1, cooldown: 2 }).mechanics!

    const edited = fixture({
      priority: undefined,
      charges: undefined,
      perTurn: undefined,
      cooldown: undefined,
    }).mechanics!

    const patch = combatMechanicsOverridesSchema.parse(diffCombatMechanics(base, edited))
    expect(patch.triggers!.refund).toEqual({
      priority: null,
      charges: null,
      perTurn: null,
      cooldown: null,
    })
    expect(applyCombatMechanicsOverrides(base, patch)).toEqual(edited)
    expect(previewCombatMechanicsOverrides(base, patch)).toEqual(edited)

    const merged = mergeCombatMechanics(
      { ...base, triggers: { refund: { ...base.triggers.refund, extension: 'keep' } } },
      edited,
    )

    expect(merged!.triggers.refund).toMatchObject({
      extension: 'keep',
      priority: undefined,
      charges: undefined,
      perTurn: undefined,
      cooldown: undefined,
    })
  })
})
