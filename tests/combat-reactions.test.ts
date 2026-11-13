import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatConditionSchema,
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  diffCombatMechanics,
  previewCombatMechanicsOverrides,
  savedCombatSchema,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  resolveCombatRound,
  CombatSimulation,
  combatEventAmount,
  evaluateCombatCondition,
  type CombatDebugFrame,
} from '@ancadeba/game-runtime'
import { mergeCombatMechanics } from '../packages/editor-core/src/combatMechanicsEditing.js'

function fixture(triggers: Record<string, unknown> = {}): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'reactive',
    label: 'Reactive',
    player: {
      id: 'player',
      label: 'Player',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 4,
      moves: ['bolt', 'water', 'heal', 'venom', 'guard'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Enemy',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 90,
        ap: 1,
        moves: ['guard'],
        rotation: ['guard'],
        damageDefenses: { vulnerabilities: { lightning: 50 }, immunities: ['water'] },
      },
    ],
    moves: {
      bolt: {
        type: 'ability',
        label: 'Bolt',
        target: 'enemy',
        apCost: 1,
        effects: [
          { id: 'hit', type: 'damage', damage: { min: 12, max: 12 }, damageType: 'lightning' },
        ],
      },
      water: {
        type: 'attack',
        label: 'Water',
        apCost: 1,
        damage: { min: 12, max: 12 },
        damageType: 'water',
      },
      heal: {
        type: 'ability',
        label: 'Heal',
        target: 'self',
        apCost: 1,
        effects: [{ id: 'heal', type: 'heal', amount: 12 }],
      },
      venom: {
        type: 'ability',
        label: 'Venom',
        target: 'enemy',
        apCost: 1,
        effects: [{ id: 'venom', type: 'apply-status', status: 'venom' }],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 5 },
    },
    statuses: {
      venom: { type: 'damage', label: 'Venom', duration: 2, amount: 4, damageType: 'lightning' },
      regen: { type: 'regeneration', label: 'Regen', duration: 2, amount: 5 },
    },
    mechanics: {
      resources: { seal: { initial: 0, maximum: 100 }, recovery: { initial: 0, maximum: 100 } },
      triggers,
    },
  })
}

const charge = {
  event: 'damage-dealt',
  source: 'player',
  target: 'enemy',
  damageType: 'lightning',
  effects: [
    {
      type: 'change-resource',
      resource: 'seal',
      amount: 0,
      eventValue: { field: 'amount', factor: 1 },
    },
  ],
}

function resolve(
  definition: CombatDefinition,
  moves: string[],
  overrides: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
) {
  const frames: CombatDebugFrame[] = []

  const result = resolveCombatRound(
    definition,
    {
      health: { player: 40, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      guard: {},
      seed: 1024,
      escape: false,
      plan: moves.map((move) => ({
        move,
        target:
          definition.moves[move]?.type === 'ability' && definition.moves[move].target === 'self'
            ? 'player'
            : 'enemy',
      })),
      enemies: { enemy: { moves: [], cursor: 0 } },
      ...overrides,
    },
    (frame) => {
      frames.push(frame)
    },
  )

  return {
    result,
    frames,
    events: frames.flatMap((frame) =>
      frame.mechanicsEvent && !frame.mechanicsEvent.trigger ? [frame.mechanicsEvent] : [],
    ),
  }
}

describe('combat effect events and reactions', () => {
  it('charges from actual HP loss after defense, type adjustment, Guard and health clamp', () => {
    const { result, events } = resolve(fixture({ charge }), ['bolt'], {
      health: { player: 40, enemy: 7 },
      guard: { enemy: 2 },
      stats: { enemy: { attack: 0, defense: 2, guard: 0, maximumHealth: 90 } },
    })

    expect(result.health.enemy).toBe(0)
    expect(result.mechanics?.resources.seal).toBe(7)
    expect(events.find((event) => event.event === 'damage-dealt')).toMatchObject({
      actor: 'player',
      source: 'player',
      target: 'enemy',
      move: 'bolt',
      effect: {
        source: 'player',
        target: 'enemy',
        amount: 7,
        rawAmount: 12,
        defended: 2,
        typeAmount: 15,
        amplified: 5,
        blocked: 2,
        damageType: 'lightning',
        immune: false,
        reactive: false,
        delivery: 'direct',
      },
    })
  })

  it('reports zero and immune hits through resolved events, retaining positive-only received events', () => {
    const definition = fixture({
      zero: {
        event: 'damage-resolved',
        damageType: 'water',
        conditions: [
          { type: 'event-flag', field: 'immune', value: true },
          { type: 'event-value', field: 'amount', operator: 'eq', value: 0 },
        ],
        effects: [{ type: 'change-resource', resource: 'recovery', amount: 1 }],
      },
      charge,
    })

    const { result, events } = resolve(definition, ['water'], { guard: { enemy: 10 } })
    expect(result.mechanics?.resources).toEqual({ seal: 0, recovery: 1 })
    expect(events.filter((event) => event.event === 'damage-received')).toHaveLength(0)
    expect(events.find((event) => event.event === 'damage-resolved')?.effect).toMatchObject({
      amount: 0,
      immune: true,
      blocked: 0,
    })
    expect(result.seed).not.toBe(1024)
    const blocked = resolve(fixture(), ['bolt'], { guard: { enemy: 100 } })
    expect(blocked.events.find((event) => event.event === 'damage-resolved')?.effect).toMatchObject(
      { amount: 0, blocked: 18, immune: false },
    )
  })

  it('preserves caster, status, delivery and actual typed amount on periodic damage', () => {
    const { result, events } = resolve(fixture({ charge }), ['venom'])
    expect(result.mechanics?.resources.seal).toBe(6)
    expect(events.find((event) => event.event === 'damage-dealt')).toMatchObject({
      source: 'player',
      target: 'enemy',
      status: 'venom',
      effect: { delivery: 'periodic', amount: 6, rawAmount: 4 },
    })
    expect(events.find((event) => event.event === 'damage-dealt')?.move).toBeUndefined()
  })

  it('emits actual healing and overheal with source, target and action context', () => {
    const definition = fixture({
      recovery: {
        event: 'healing-received',
        target: 'player',
        move: 'heal',
        effects: [
          {
            type: 'change-resource',
            resource: 'recovery',
            amount: 0,
            eventValue: { field: 'amount', factor: 1 },
          },
        ],
      },
    })

    const { result, events } = resolve(definition, ['heal', 'heal'], {
      health: { player: 75, enemy: 90 },
    })

    expect(result.health.player).toBe(80)
    expect(result.mechanics?.resources.recovery).toBe(5)
    expect(events.filter((event) => event.event === 'healing-received')).toHaveLength(1)
    expect(
      events.filter((event) => event.event === 'healing-resolved').map((event) => event.effect),
    ).toMatchObject([
      {
        amount: 5,
        rawAmount: 12,
        overheal: 7,
        source: 'player',
        target: 'player',
        delivery: 'direct',
      },
      { amount: 0, overheal: 12 },
    ])
  })

  it('emits periodic healing with its original caster and status', () => {
    const { events, result } = resolve(fixture(), [], {
      statuses: { player: [{ id: 'regen', source: 'enemy', remaining: 2 }] },
    })

    expect(result.health.player).toBe(45)
    expect(events.find((event) => event.event === 'healing-received')).toMatchObject({
      actor: 'player',
      source: 'enemy',
      status: 'regen',
      effect: { delivery: 'periodic', amount: 5 },
    })
  })

  it('supports lifesteal and healing-derived recovery with explicit reaction opt-in', () => {
    const definition = fixture({
      siphon: {
        event: 'damage-dealt',
        source: 'player',
        damageType: 'lightning',
        effects: [
          {
            type: 'heal',
            actor: 'event.source',
            amount: 0,
            eventValue: { field: 'amount', factor: 0.5 },
          },
        ],
      },
      relief: {
        event: 'healing-received',
        target: 'player',
        includeReactions: true,
        delivery: 'reaction',
        effects: [
          {
            type: 'change-resource',
            resource: 'recovery',
            amount: 0,
            eventValue: { field: 'amount', factor: 1 },
          },
        ],
      },
    })

    const { result, events } = resolve(definition, ['bolt'])
    expect(result.health).toEqual({ player: 49, enemy: 72 })
    expect(result.mechanics?.resources.recovery).toBe(9)
    expect(result.entries.find((entry) => entry.type === 'healed')).toMatchObject({
      amount: 9,
      reactive: true,
    })
    expect(events.find((event) => event.event === 'healing-dealt')?.effect).toMatchObject({
      reactive: true,
      delivery: 'reaction',
      amount: 9,
    })
  })

  it('applies normal healing percentages and caps lifesteal at missing HP', () => {
    const definition = fixture({
      siphon: {
        event: 'damage-dealt',
        effects: [
          {
            type: 'heal',
            actor: 'event.source',
            amount: 0,
            eventValue: { field: 'amount', factor: 0.5 },
          },
        ],
      },
    })

    definition.statuses!.power = {
      type: 'modifier',
      label: 'Power',
      description: '',
      duration: 2,
      modifiers: {},
      percentModifiers: { healing: 50 },
    }

    const { events, result } = resolve(definition, ['bolt'], {
      health: { player: 77, enemy: 90 },
      statuses: { player: [{ id: 'power', source: 'player', remaining: 2 }] },
    })

    expect(result.health.player).toBe(80)
    expect(events.find((event) => event.event === 'healing-resolved')?.effect).toMatchObject({
      amount: 3,
      rawAmount: 13,
      overheal: 10,
    })
  })

  it('reflects damage without recursion or RNG draws and records the defender as source', () => {
    const definition = fixture({
      reflect: {
        event: 'damage-received',
        effects: [
          {
            type: 'damage',
            actor: 'event.source',
            source: 'event.target',
            amount: 0,
            eventValue: { field: 'amount', factor: 0.5 },
            damageType: 'lightning',
          },
        ],
      },
    })

    const { result, events } = resolve(definition, ['bolt'])
    expect(result.health).toEqual({ player: 31, enemy: 72 })
    expect(result.seed).toBe(resolve(fixture(), ['bolt']).result.seed)
    expect(events.filter((event) => event.event === 'damage-resolved')).toHaveLength(2)
    expect(
      events.find((event) => event.event === 'damage-dealt' && event.effect?.reactive),
    ).toMatchObject({ source: 'enemy', target: 'player', effect: { amount: 9, reactive: true } })
    expect(result.entries.filter((entry) => entry.reactive)).toHaveLength(1)
  })

  it('uses live defenses for reactive damage and consumes no Guard when immune', () => {
    const definition = fixture({
      reflect: {
        event: 'damage-received',
        target: 'enemy',
        effects: [
          {
            type: 'damage',
            actor: 'event.source',
            source: 'event.target',
            amount: 10,
            damageType: 'water',
          },
        ],
      },
    })

    definition.player.damageDefenses = { immunities: ['water'] }
    const { result, events } = resolve(definition, ['bolt'])
    expect(result.health.player).toBe(40)
    expect(
      events.find((event) => event.event === 'damage-resolved' && event.effect?.reactive)?.effect,
    ).toMatchObject({ amount: 0, immune: true })
  })

  it('binds source/recipient filters and actor roles in composed reusable rulesets', () => {
    const definition = fixture()

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'shared',
      rulesets: {
        reactions: {
          actors: ['caster', 'boss'],
          mechanics: {
            resources: { seal: { initial: 0, maximum: 100 } },
            triggers: {
              charge: {
                ...charge,
                source: 'caster',
                target: 'boss',
                effects: [
                  {
                    type: 'heal',
                    actor: 'event.source',
                    source: 'caster',
                    amount: 1,
                    conditions: [
                      { type: 'health', actor: 'event.source', operator: 'lt', value: 80 },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    })

    const source = combatSourceSchema.parse({
      ...definition,
      mechanics: undefined,
      rulesets: [
        { library: 'shared', id: 'reactions', actors: { caster: 'player', boss: 'enemy' } },
      ],
    })

    const resolved = resolveCombatSource(source, new Map([['shared', library]]))
    expect(resolved.issues).toEqual([])
    expect(resolved.definition?.mechanics?.triggers.charge).toMatchObject({
      source: 'player',
      target: 'enemy',
      effects: [{ actor: 'event.source', source: 'player' }],
    })
    expect(resolve(resolved.definition!, ['bolt']).result.health.player).toBe(41)
  })

  it('filters by move, status and delivery independently', () => {
    const definition = fixture({
      direct: { ...charge, move: 'bolt', delivery: 'direct' },
      tick: {
        ...charge,
        status: 'venom',
        delivery: 'periodic',
        effects: [
          {
            type: 'change-resource',
            resource: 'recovery',
            amount: 0,
            eventValue: { field: 'amount', factor: 1 },
          },
        ],
      },
    })

    const { result } = resolve(definition, ['bolt', 'venom'])
    expect(result.mechanics?.resources).toEqual({ seal: 18, recovery: 6 })
  })

  it('keeps original effect facts stable while FIFO reactions change live HP', () => {
    const definition = fixture({
      reflect: {
        event: 'damage-received',
        target: 'enemy',
        effects: [{ type: 'damage', actor: 'event.source', source: 'event.target', amount: 9 }],
      },
      siphon: {
        event: 'damage-dealt',
        source: 'player',
        effects: [
          {
            type: 'heal',
            actor: 'event.source',
            amount: 0,
            eventValue: { field: 'amount', factor: 0.5 },
          },
        ],
      },
      charge,
    })

    const { result, events, frames } = resolve(definition, ['bolt'])
    expect(result.health.player).toBe(40)
    expect(result.mechanics?.resources.seal).toBe(18)
    const effects = events.filter((entry) => entry.effect)

    expect(effects.slice(0, 3).map((entry) => entry.event)).toEqual([
      'damage-received',
      'damage-dealt',
      'damage-resolved',
    ])
    expect(effects.slice(0, 3).map((entry) => entry.effect?.amount)).toEqual([18, 18, 18])
    expect(frames.find((frame) => frame.kind === 'action')?.spentAp).toBe(1)
  })

  it('ends a plan on lethal reflected damage without reviving its defeated actor', () => {
    const definition = fixture({
      reflect: {
        event: 'damage-received',
        target: 'enemy',
        effects: [{ type: 'damage', actor: 'event.source', source: 'event.target', amount: 10 }],
      },
    })

    const { result } = resolve(definition, ['bolt', 'heal'], { health: { player: 5, enemy: 90 } })
    expect(result.outcome).toBe('defeat')
    expect(result.health.player).toBe(0)
    expect(result.entries.some((entry) => entry.type === 'healed')).toBe(false)
    expect(result.seed).toBe(resolve(fixture(), ['bolt']).result.seed)
  })

  it('validates event-specific fields and keeps event-only conditions out of ordinary abilities', () => {
    expect(() =>
      fixture({
        wrong: {
          ...charge,
          effects: [
            {
              type: 'change-resource',
              resource: 'seal',
              amount: 0,
              eventValue: { field: 'overheal', factor: 1 },
            },
          ],
        },
      }),
    ).toThrow('unavailable')
    expect(() =>
      fixture({
        wrong: {
          event: 'healing-resolved',
          conditions: [{ type: 'event-flag', field: 'immune', value: false }],
          effects: [{ type: 'heal', actor: 'player', amount: 1 }],
        },
      }),
    ).toThrow('unavailable')
    const definition = fixture()
    const heal = definition.moves.heal!

    if (heal.type !== 'ability') throw new Error('Expected ability')
    heal.effects[0]!.conditions = [
      { type: 'event-value', field: 'amount', operator: 'gt', value: 0 },
    ]
    expect(() => combatDefinitionSchema.parse(definition)).toThrow('Event conditions require')
  })

  it('rejects wrong event filters, invalid references and event formulas outside effect events', () => {
    for (const entry of [
      { ...charge, source: 'missing' },
      { ...charge, event: 'round-start' },
      { ...charge, event: 'healing-received' },
      { event: 'round-start', effects: [{ type: 'heal', actor: 'event.source', amount: 1 }] },
    ])
      expect(() => fixture({ broken: entry })).toThrow()
    expect(() =>
      fixture({
        broken: {
          event: 'round-start',
          conditions: [{ type: 'event-value', field: 'amount', operator: 'gt', value: 0 }],
          effects: [{ type: 'set-resource', resource: 'seal', amount: 1 }],
        },
      }),
    ).toThrow()
  })

  it('evaluates nested event expressions and fails closed when no event facts exist', () => {
    const condition = combatConditionSchema.parse({
      type: 'and',
      conditions: [
        { type: 'event-value', field: 'amount', operator: 'gte', value: 5 },
        { type: 'not', condition: { type: 'event-flag', field: 'immune', value: true } },
      ],
    })

    const context = { health: {}, resources: {}, statuses: {}, phase: undefined }
    expect(evaluateCombatCondition(condition, context)).toMatchObject({
      available: false,
      matched: false,
    })
    expect(
      evaluateCombatCondition(condition, {
        ...context,
        event: {
          source: 'a',
          target: 'b',
          amount: 6,
          rawAmount: 12,
          immune: false,
          reactive: false,
          delivery: 'direct',
        },
      }),
    ).toMatchObject({ available: true, matched: true })
  })

  it('rounds signed event formulas exactly and rejects unavailable fields or overflow', () => {
    const event = {
      source: 'a',
      target: 'b',
      amount: 5,
      rawAmount: 5,
      reactive: false,
      delivery: 'direct' as const,
    }

    expect(combatEventAmount(0, { field: 'amount', factor: -0.5 }, event, true)).toBe(-3)
    expect(
      combatEventAmount(0, { field: 'amount', factor: -0.5, rounding: 'ceil' }, event, true),
    ).toBe(-2)
    expect(combatEventAmount(0, { field: 'amount', factor: -0.5 }, event)).toBe(0)
    expect(combatEventAmount(1, { field: 'amount', factor: 0.5, rounding: 'nearest' }, event)).toBe(
      4,
    )
    expect(() => combatEventAmount(0, { field: 'overheal', factor: 1 }, event)).toThrow(
      'unavailable',
    )
    expect(() =>
      combatEventAmount(Number.MAX_SAFE_INTEGER, { field: 'amount', factor: 1 }, event),
    ).toThrow('overflow')
  })

  it('rolls back explicit infinite reaction chains including RNG, state and debug history', () => {
    const definition = fixture({
      loop: {
        event: 'healing-resolved',
        includeReactions: true,
        effects: [{ type: 'heal', actor: 'event.source', amount: 1 }],
      },
    })

    const simulation = new CombatSimulation(definition, {
      health: { player: 40, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
    })

    simulation.queue('heal')
    const before = simulation.report()
    expect(() => simulation.resolve()).toThrow('operation limit')
    expect(simulation.report()).toEqual(before)
  })

  it('preserves reaction fields, sparse overrides and extension data while clearing removed union fields', () => {
    const definition = fixture({ charge })
    const base = definition.mechanics!
    const edited = structuredClone(base)
    delete edited.triggers.charge!.damageType
    edited.triggers.charge!.includeReactions = true
    const diff = diffCombatMechanics(base, edited)
    expect(diff.triggers?.charge).toEqual({ damageType: null, includeReactions: true })
    expect(previewCombatMechanicsOverrides(base, diff)).toEqual(edited)

    const previous = {
      triggers: {
        charge: {
          extension: true,
          source: 'player',
          damageType: 'lightning',
          effects: [
            {
              type: 'damage',
              actor: 'enemy',
              source: 'player',
              amount: 0,
              damageType: 'water',
              eventValue: { field: 'amount', factor: 1, extension: 'keep' },
            },
          ],
        },
      },
    }

    const saved = mergeCombatMechanics(previous, base)!
    expect(saved.triggers.charge).toMatchObject({
      extension: true,
      effects: [
        {
          eventValue: { extension: 'keep', field: 'amount' },
          actor: undefined,
          source: undefined,
          damageType: undefined,
        },
      ],
    })

    const result = resolve(
      fixture({
        siphon: {
          event: 'damage-dealt',
          effects: [{ type: 'heal', actor: 'event.source', amount: 1 }],
        },
      }),
      ['bolt'],
    ).result

    expect(
      savedCombatSchema.parse({
        round: 1,
        seed: result.seed,
        started: true,
        guard: {},
        plan: [],
        enemies: {},
        statuses: {},
        cooldowns: {},
        escape: false,
        log: result.entries,
      }).log,
    ).toContainEqual(expect.objectContaining({ reactive: true, type: 'healed' }))
  })
})
