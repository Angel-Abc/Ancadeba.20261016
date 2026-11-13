import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  bindCombatRulesetActors,
  combatRulesetSchema,
  inventorySchema,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  CombatSimulation,
  combatValueContext,
  evaluateCombatValue,
  resolveCombatEffectValues,
  combatAbilityEffectValues,
  combatActorEconomy,
} from '@ancadeba/game-runtime'
import { mergeCombatEffectValueScaling } from '../packages/editor-core/src/combatValueEditing.js'

function fixture(): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'values',
    label: 'Dynamic effects',
    player: {
      id: 'player',
      label: 'Diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 100,
      ap: 3,
      moves: ['hit', 'heal', 'resource', 'ward', 'cleanse'],
    },
    enemies: [
      {
        id: 'eel',
        label: 'Eel',
        health: { source: 'game.state', path: ['eel'] },
        maximumHealth: 200,
        ap: 1,
        moves: ['hit'],
        rotation: ['hit'],
      },
    ],
    moves: {
      hit: { type: 'attack', label: 'Hit', apCost: 1, damage: { min: 10, max: 10 } },
      heal: {
        type: 'ability',
        label: 'Heal',
        target: 'self',
        apCost: 1,
        effects: [
          {
            id: 'heal',
            type: 'heal',
            amount: 2,
            scaling: { terms: [{ type: 'missing-health', actor: 'self', factor: 0.5 }] },
          },
        ],
      },
      resource: {
        type: 'ability',
        label: 'Resource',
        target: 'self',
        apCost: 1,
        effects: [
          {
            id: 'resource',
            type: 'change-resource',
            resource: 'energy',
            amount: -2,
            valueScaling: { amount: { terms: [{ type: 'round', factor: -1 }] } },
          },
        ],
      },
      ward: {
        type: 'ability',
        label: 'Ward',
        target: 'self',
        apCost: 1,
        effects: [
          {
            id: 'ward',
            type: 'apply-status',
            status: 'ward',
            stacks: 1,
            intensity: 1,
            duration: 2,
            valueScaling: {
              stacks: { terms: [{ type: 'round', factor: 1 }] },
              intensity: { terms: [{ type: 'stat', actor: 'self', stat: 'attack', factor: 0.5 }] },
              duration: { terms: [{ type: 'missing-health', actor: 'self', factor: 0.1 }] },
            },
          },
        ],
      },
      cleanse: {
        type: 'ability',
        label: 'Cleanse',
        target: 'self',
        apCost: 1,
        effects: [
          {
            id: 'cleanse',
            type: 'remove-status',
            status: 'ward',
            stacks: 1,
            valueScaling: { stacks: { terms: [{ type: 'round', factor: 1 }] } },
          },
        ],
      },
    },
    statuses: {
      ward: {
        type: 'composite',
        label: 'Ward',
        duration: 10,
        stacking: { maximum: 5 },
        intensity: { initial: 1, maximum: 5 },
        modifiers: { defense: 0 },
      },
    },
    mechanics: { resources: { energy: { initial: 50, maximum: 100 } } },
  })
}

function simulation(definition = fixture(), round = 1) {
  return new CombatSimulation(definition, {
    health: { player: 50, eel: 200 },
    maximumHealth: { player: 100, eel: 200 },
    stats: { player: { attack: 4, defense: 2, guard: 1, maximumHealth: 100 } },
    round,
  })
}

describe('dynamic values across combat effects', () => {
  it('combines exact health percentages, missing health, effective stats and round values', () => {
    const definition = fixture()

    const context = combatValueContext(definition, undefined, {}, 'player', 'eel', {
      health: { player: 25, eel: 100 },
      maximumHealth: { player: 100, eel: 200 },
      stats: { player: { attack: 4, defense: 2, guard: 1, maximumHealth: 100 } },
      round: 3,
    })

    expect(
      evaluateCombatValue(
        0,
        {
          terms: [
            { type: 'health', actor: 'self', measure: 'percent', factor: 0.2 },
            { type: 'missing-health', actor: 'target', measure: 'percent', factor: 0.1 },
            { type: 'stat', actor: 'self', stat: 'attack', factor: 1 },
            { type: 'round', factor: 2 },
          ],
        },
        context,
      ),
    ).toBe(20)
    expect(
      evaluateCombatValue(
        0,
        { terms: [{ type: 'missing-health', actor: 'self', factor: -1 }] },
        context,
        'floor',
        true,
      ),
    ).toBe(-75)
    expect(() =>
      evaluateCombatValue(
        0,
        { terms: [{ type: 'round', factor: 1 }] },
        { ...context, round: undefined },
      ),
    ).toThrow('round unavailable')
  })

  it('uses health and round scaling for both resource payments and AP planning', () => {
    const definition = fixture()
    definition.moves.resource!.apCostScaling = { terms: [{ type: 'round', factor: 1 }] }
    const sim = simulation(definition)
    expect(sim.queueIssue('resource')).toBeUndefined()
    sim.queue('resource')
    expect(sim.queueIssue('resource')).toBe('Insufficient AP')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(47)
    sim.resolve()
    expect(sim.queueIssue('resource')).toBe('Insufficient AP')
  })

  it('re-evaluates missing-health healing between actions and matches the preview', () => {
    const sim = simulation()
    const definition = sim.definition

    const context = combatValueContext(definition, undefined, {}, 'player', 'player', {
      health: { player: 50, eel: 200 },
      round: 1,
    })

    const heal = definition.moves.heal!

    if (heal.type !== 'ability') throw new Error('Expected heal ability')
    expect(combatAbilityEffectValues(heal.effects[0]!, undefined, 0, context).amount).toBe(27)
    sim.queue('heal')
    sim.queue('heal')
    sim.resolve()
    expect(
      sim
        .trace()
        .flatMap((frame) => frame.entries)
        .filter((entry) => entry.type === 'healed')
        .map((entry) => entry.amount),
    ).toEqual([27, 13])
    expect(sim.snapshot().health.player).toBe(82)
  })

  it('scales application stacks, intensity and duration, and dynamic stack removal', () => {
    const sim = simulation()
    sim.queue('ward')
    sim.resolve()
    expect(sim.snapshot().statuses.player![0]).toMatchObject({
      stacks: 2,
      intensity: 3,
      remaining: 7,
    })
    sim.queue('cleanse')
    sim.resolve()
    expect(sim.snapshot().statuses.player).toEqual([])
  })

  it.each(['stacks', 'intensity'] as const)(
    'allows status items whose scaled %s exceed the status maximum',
    (strength) => {
      const definition = fixture()
      definition.itemUse = { owner: 'player', itemTypes: ['tonic'] }
      definition.moves.ward = {
        type: 'ability',
        label: 'Ward',
        description: '',
        target: 'self',
        apCost: 1,
        effects: [
          {
            id: 'ward',
            type: 'apply-status',
            status: 'ward',
            stacks: 1,
            intensity: 1,
            valueScaling: { [strength]: { terms: [{ type: 'round', factor: 10 }] } },
          },
        ],
      }

      const inventory = inventorySchema.parse({
        'schema-version': '1.0.0',
        owners: { player: { label: 'Player' } },
        itemTypes: {
          tonic: {
            label: 'Ward tonic',
            use: { ability: { library: 'items', id: 'ward' }, contexts: ['combat'] },
          },
        },
        items: { tonic: { itemType: 'tonic', placement: { type: 'carried', owner: 'player' } } },
      })

      const sim = new CombatSimulation(definition, {
        health: { player: 50, eel: 200 },
        maximumHealth: { player: 100, eel: 200 },
        itemContext: { inventory },
      })

      expect(sim.queueIssue('ward', 'player', 'tonic')).toBeUndefined()
      sim.queue('ward', 'player', 'tonic')
      sim.resolve()
      expect(sim.snapshot().statuses.player).toEqual([
        { id: 'ward', source: 'player', remaining: 10, stacks: 1, intensity: 1, [strength]: 5 },
      ])
      expect(sim.queueIssue('ward', 'player', 'tonic')).toBe('Item is consumed or already reserved')
    },
  )

  it('evaluates periodic payloads live on each tick and applies strength afterward', () => {
    const definition = fixture()
    definition.statuses!.ward = {
      type: 'composite',
      label: 'Ward',
      description: '',
      duration: 10,
      damage: 1,
      regeneration: 1,
      valueScaling: {
        damage: { terms: [{ type: 'round', factor: 1 }] },
        regeneration: { terms: [{ type: 'missing-health', actor: 'target', factor: 0.1 }] },
      },
    }

    const sim = new CombatSimulation(definition, {
      health: { player: 50, eel: 200 },
      maximumHealth: { player: 100, eel: 200 },
      statuses: { player: [{ id: 'ward', source: 'player', remaining: 10 }] },
    })

    sim.resolve()
    sim.resolve()
    const entries = sim.trace().flatMap((frame) => frame.entries)
    expect(
      entries.filter((entry) => entry.type === 'periodicDamage').map((entry) => entry.amount),
    ).toEqual([2, 3])
    expect(
      entries.filter((entry) => entry.type === 'regenerated').map((entry) => entry.amount),
    ).toEqual([6, 6])
  })

  it('scales modifiers from pre-status stats without recursively counting their own contribution', () => {
    const definition = fixture()
    definition.statuses!.ward!.valueScaling = {
      'modifiers.defense': {
        terms: [{ type: 'stat', actor: 'target', stat: 'defense', factor: 2 }],
      },
    }

    const context = combatValueContext(
      definition,
      undefined,
      { player: [{ id: 'ward', source: 'player', remaining: 10 }] },
      'player',
      'eel',
      {
        health: { player: 50, eel: 200 },
        stats: { player: { attack: 4, defense: 2, guard: 1, maximumHealth: 100 } },
        round: 1,
      },
    )

    expect(context.stats!.player!.defense).toBe(6)
    expect(combatActorEconomy(definition, definition.player, [], context).ap).toBe(3)
  })

  it('scales trigger resources, reactive healing and interception before resolving packets', () => {
    const definition = fixture()
    definition.mechanics!.triggers = {
      shield: {
        event: 'damage-pending',
        target: 'player',
        priority: 10,
        once: false,
        conditions: [],
        effects: [
          {
            type: 'absorb-damage',
            resource: 'energy',
            maximum: 1,
            valueScaling: { maximum: { terms: [{ type: 'round', factor: 2 }] } },
          },
        ],
      },
      refund: {
        event: 'damage-received',
        target: 'player',
        once: false,
        conditions: [],
        effects: [
          {
            type: 'heal',
            actor: 'event.target',
            amount: 1,
            valueScaling: {
              amount: {
                terms: [{ type: 'stat', actor: 'event.target', stat: 'defense', factor: 1 }],
              },
            },
          },
        ],
      },
      drain: {
        event: 'round-end',
        once: false,
        conditions: [],
        effects: [
          {
            type: 'change-resource',
            resource: 'energy',
            amount: -1,
            valueScaling: { amount: { terms: [{ type: 'round', factor: -1 }] } },
          },
        ],
      },
    }
    const sim = simulation(definition)
    sim.resolve()
    expect(sim.snapshot().health.player).toBe(48)
    expect(sim.snapshot().mechanics!.resources.energy).toBe(45)
    expect(sim.trace().some((frame) => frame.mechanicsEvent?.interception?.spent === 3)).toBe(true)
  })

  it('preserves signed adjustments and fractional percentage points and bounds redirect percentages', () => {
    const context = combatValueContext(fixture(), undefined, {}, 'player', 'eel', { round: 2 })
    expect(
      resolveCombatEffectValues(
        {
          type: 'adjust-effect',
          amount: -2,
          percent: -10.25,
          valueScaling: {
            amount: { terms: [{ type: 'round' as const, factor: -1 }] },
            percent: { terms: [{ type: 'round' as const, factor: -0.25 }] },
          },
        },
        context,
      ),
    ).toMatchObject({ amount: -4, percent: -10.75 })
    expect(
      resolveCombatEffectValues(
        {
          type: 'redirect-damage',
          percent: 50,
          valueScaling: { percent: { terms: [{ type: 'round' as const, factor: 100 }] } },
        },
        context,
      ).percent,
    ).toBe(100)
  })

  it('validates numeric paths, actor/resource references and event-only actor inputs', () => {
    for (const patch of [
      { amount: { terms: [{ type: 'health', actor: 'missing', factor: 1 }] } },
      { stacks: { terms: [{ type: 'round', factor: 1 }] } },
      { amount: { terms: [{ type: 'health', actor: 'event.source', factor: 1 }] } },
    ]) {
      const definition = fixture()
      const move = definition.moves.resource!

      if (move.type !== 'ability') throw new Error('Expected resource ability')
      expect(
        combatDefinitionSchema.safeParse({
          ...definition,
          moves: {
            ...definition.moves,
            resource: { ...move, effects: [{ ...move.effects[0], valueScaling: patch }] },
          },
        }).success,
      ).toBe(false)
    }
  })

  it('binds formula actor roles and imports status dependencies used only by formulas', () => {
    const ruleset = combatRulesetSchema.parse({
      actors: ['swimmer'],
      mechanics: {
        resources: { energy: { initial: 0, maximum: 100 } },
        triggers: {
          restore: {
            event: 'round-end',
            effects: [
              {
                type: 'change-resource',
                resource: 'energy',
                amount: 1,
                valueScaling: {
                  amount: { terms: [{ type: 'health', actor: 'swimmer', factor: 0.1 }] },
                },
              },
            ],
          },
        },
      },
    })

    expect(
      bindCombatRulesetActors(ruleset, { swimmer: 'player' }).triggers.restore!.effects[0]!
        .valueScaling!.amount!.terms[0],
    ).toMatchObject({ actor: 'player' })

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'water',
      statuses: {
        ward: {
          type: 'damage',
          label: 'Ward',
          duration: 3,
          amount: 1,
          valueScaling: {
            amount: { terms: [{ type: 'status', actor: 'self', status: 'focus', factor: 1 }] },
          },
        },
        focus: { type: 'modifier', label: 'Focus', duration: 3, modifiers: { attack: 1 } },
      },
    })

    const source = combatSourceSchema.parse({
      ...fixture(),
      statuses: {},
      sharedStatuses: [{ library: 'water', id: 'ward' }],
    })

    const resolved = resolveCombatSource(source, new Map([['water', library]]))
    expect(resolved.issues).toEqual([])
    expect(resolved.definition!.statuses).toHaveProperty('focus')
  })

  it('rolls back failed formula candidates and preserves editor extension fields while clearing union fields', () => {
    const definition = fixture()
    definition.mechanics!.triggers.bad = {
      event: 'round-end',
      once: false,
      conditions: [],
      effects: [
        {
          type: 'change-resource',
          resource: 'energy',
          amount: 1,
          valueScaling: {
            amount: { terms: [{ type: 'round', factor: 10000 }], maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      ],
    }
    const sim = simulation(definition, Number.MAX_SAFE_INTEGER)
    const before = sim.report()
    expect(() => sim.resolve()).toThrow('overflow')
    expect(sim.report()).toEqual(before)

    const merged = mergeCombatEffectValueScaling(
      {
        amount: {
          extension: 'keep',
          terms: [
            { type: 'status', actor: 'self', status: 'ward', measure: 'intensity', factor: 1 },
          ],
        },
      },
      { amount: { terms: [{ type: 'round', factor: 2 }] } },
    )

    expect(merged!.amount).toMatchObject({
      extension: 'keep',
      terms: [
        { type: 'round', actor: undefined, status: undefined, measure: undefined, factor: 2 },
      ],
    })
  })
})
