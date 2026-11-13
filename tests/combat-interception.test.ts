import { describe, expect, it } from 'vite-plus/test'
import {
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  combatDefinitionSchema,
  savedCombatSchema,
  type CombatDefinition,
  type CombatTriggerEffect,
  type CombatTriggerDefinition,
} from '@ancadeba/schemas'
import {
  resolveCombatRound,
  CombatSimulation,
  combatEventAmount,
  evaluateCombatCondition,
  type CombatDebugFrame,
} from '@ancadeba/game-runtime'
import { mergeCombatRuleEffects } from '../packages/editor-core/src/combatRuleEntryEditing.js'

function fixture(): CombatDefinition {
  const library = combatLibrarySchema.parse({
    'schema-version': '1.0.0',
    id: 'wards',
    statuses: {
      shield: {
        type: 'composite',
        label: 'Shield',
        duration: 3,
        passives: [{ library: 'wards', id: 'shield' }],
      },
      soaked: {
        type: 'composite',
        label: 'Waterlogged',
        duration: 2,
        passives: [{ library: 'wards', id: 'dampen' }],
      },
      tether: {
        type: 'composite',
        label: 'Tether',
        duration: 3,
        passives: [{ library: 'wards', id: 'tether' }],
      },
      rescue: {
        type: 'composite',
        label: 'Rescue',
        duration: 3,
        passives: [{ library: 'wards', id: 'rescue' }],
      },
    },
    passives: {
      shield: {
        label: 'Bubble shield',
        triggers: {
          absorb: {
            event: 'damage-pending',
            target: 'self',
            effects: [{ type: 'absorb-damage', resource: 'barrier' }],
          },
        },
      },
      dampen: {
        label: 'Dampen',
        triggers: {
          reduce: {
            event: 'healing-pending',
            target: 'self',
            effects: [{ type: 'adjust-effect', percent: -50 }],
          },
        },
      },
      tether: {
        label: 'Tether',
        triggers: {
          redirect: {
            event: 'damage-pending',
            target: 'self',
            effects: [{ type: 'redirect-damage', actor: 'protector', percent: 50 }],
          },
        },
      },
      rescue: {
        label: 'Rescue',
        triggers: {
          survive: {
            event: 'damage-pending',
            target: 'self',
            once: true,
            conditions: [{ type: 'event-flag', field: 'lethal', value: true }],
            effects: [{ type: 'prevent-lethal', minimumHealth: 1 }],
          },
        },
      },
    },
  })

  const source = combatSourceSchema.parse({
    'schema-version': '1.0.0',
    id: 'interception',
    label: 'Interception',
    seed: 1024,
    player: {
      id: 'player',
      label: 'Diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 3,
      moves: ['hit', 'heal', 'guard'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Eel',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 90,
        ap: 1,
        moves: ['wave'],
        rotation: ['wave'],
      },
      {
        id: 'protector',
        label: 'Protector',
        health: { source: 'game.state', path: ['protector'] },
        maximumHealth: 60,
        ap: 1,
        moves: ['guard'],
        rotation: [],
        ai: { rules: [], fallback: 'wait' },
      },
    ],
    moves: {
      hit: {
        type: 'attack',
        label: 'Hit',
        apCost: 1,
        damageType: 'lightning',
        damage: { min: 10, max: 10 },
      },
      wave: {
        type: 'attack',
        label: 'Wave',
        apCost: 1,
        damageType: 'water',
        damage: { min: 10, max: 10 },
      },
      heal: {
        type: 'ability',
        label: 'Heal',
        target: 'self',
        apCost: 1,
        effects: [{ id: 'heal', type: 'heal', amount: 20 }],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 5 },
    },
    sharedStatuses: ['shield', 'soaked', 'tether', 'rescue'].map((id) => ({
      library: 'wards',
      id,
    })),
    mechanics: { resources: { barrier: { initial: 6, maximum: 100, actor: 'player' } } },
  })

  const result = resolveCombatSource(source, new Map([['wards', library]]))

  if (!result.definition) throw new Error(JSON.stringify(result.issues))

  return combatDefinitionSchema.parse(result.definition)
}

const status = (id: string) => ({ id, source: 'player', remaining: 3 })

function resolve(
  definition: CombatDefinition,
  moves: string[] = [],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
) {
  const frames: CombatDebugFrame[] = []

  const result = resolveCombatRound(
    definition,
    {
      health: { player: 80, enemy: 90, protector: 60 },
      maximumHealth: { player: 80, enemy: 90, protector: 60 },
      guard: {},
      seed: 1024,
      escape: false,
      plan: moves.map((move) => ({ move, target: move === 'hit' ? 'enemy' : 'player' })),
      enemies: {
        enemy: { moves: [{ move: 'wave', target: 'player' }], cursor: 0 },
        protector: { moves: [], cursor: 0 },
      },
      ...options,
    },
    (frame) => {
      frames.push(frame)
    },
  )

  return { result, frames }
}

function addTrigger(
  definition: CombatDefinition,
  id: string,
  event: CombatTriggerDefinition['event'],
  effects: CombatTriggerEffect[],
) {
  definition.mechanics!.triggers[id] = { event, once: false, conditions: [], effects }
}

describe('damage and healing interception', () => {
  it('validates pending-only operations, event fields, percentages, shields and redirect references', () => {
    for (const [event, effect] of [
      ['damage-received', { type: 'absorb-damage', resource: 'barrier' }],
      ['healing-pending', { type: 'redirect-damage', actor: 'enemy', percent: 50 }],
      ['damage-pending', { type: 'damage', actor: 'player', amount: 1 }],
      ['healing-pending', { type: 'heal', actor: 'player', amount: 1 }],
      ['damage-pending', { type: 'finish', outcome: 'victory' }],
    ] as const) {
      const definition = fixture()
      addTrigger(definition, 'bad', event, [effect])
      expect(combatDefinitionSchema.safeParse(definition).success).toBe(false)
    }

    const definition = fixture()
    addTrigger(definition, 'adjust', 'healing-pending', [
      { type: 'adjust-effect', amount: 0, percent: -100.01 },
    ])
    expect(combatDefinitionSchema.safeParse(definition).success).toBe(false)
    definition.mechanics!.triggers.adjust!.effects = [{ type: 'adjust-effect', amount: 0 }]
    definition.mechanics!.triggers.adjust!.conditions = [
      { type: 'event-flag', field: 'lethal', value: true },
    ]
    expect(combatDefinitionSchema.safeParse(definition).success).toBe(false)
  })

  it('spends a shield resource against post-defense/Guard damage before HP and records actual facts', () => {
    const definition = fixture()
    const { result, frames } = resolve(definition, [], { statuses: { player: [status('shield')] } })
    expect(result.health.player).toBe(76)
    expect(result.mechanics!.resources.barrier).toBe(0)
    expect(result.entries.find((entry) => entry.type === 'attack')).toMatchObject({
      damage: 4,
      incomingAmount: 10,
      absorbed: 6,
    })
    expect(
      frames.find((frame) => frame.mechanicsEvent?.interception)?.mechanicsEvent,
    ).toMatchObject({
      interception: { type: 'absorb-damage', before: 10, after: 4, spent: 6 },
      effect: { amount: 4, absorbed: 6 },
    })

    const guarded = resolve(definition, ['guard'], {
      statuses: { player: [status('shield')] },
    }).result

    expect(guarded.health.player).toBe(80)
    expect(guarded.mechanics!.resources.barrier).toBe(1)
    expect(guarded.entries.find((entry) => entry.type === 'attack')).toMatchObject({
      blocked: 5,
      absorbed: 5,
      damage: 0,
    })
  })

  it('does not spend shields or create redirected damage through immunity or fully absorbed Guard', () => {
    const definition = fixture()
    definition.player.damageDefenses = { immunities: ['water'] }
    addTrigger(definition, 'amplify', 'damage-pending', [{ type: 'adjust-effect', amount: 10 }])

    const immune = resolve(definition, [], {
      statuses: { player: [status('shield'), status('tether')] },
    }).result

    expect(immune.health).toEqual({ player: 80, enemy: 90, protector: 60 })
    expect(immune.mechanics!.resources.barrier).toBe(6)
    delete definition.mechanics!.triggers.amplify
    definition.player.damageDefenses = { resistances: { water: 50 } }
    expect(
      resolve(definition, ['guard'], { statuses: { player: [status('shield')] } }).result.mechanics!
        .resources.barrier,
    ).toBe(6)
  })

  it('applies recipient defenses to redirected packets without applying outgoing bonuses twice', () => {
    const definition = fixture()
    definition.enemies[1]!.damageDefenses = { resistances: { water: 50 } }
    const { result, frames } = resolve(definition, [], { statuses: { player: [status('tether')] } })
    expect(result.health).toEqual({ player: 75, enemy: 90, protector: 58 })
    expect(
      result.entries.find((entry) => entry.type === 'attack' && entry.target === 'player'),
    ).toMatchObject({ damage: 5, redirectedAmount: 5 })
    expect(result.entries.find((entry) => entry.redirected)).toMatchObject({
      actor: 'enemy',
      target: 'protector',
      damage: 2,
      reactive: true,
      originalTarget: 'player',
    })
    expect(frames.some((frame) => frame.mechanicsEvent?.effect?.redirected)).toBe(true)
  })

  it('ignores dead/self redirect recipients and prevents redirect chains', () => {
    const definition = fixture()

    let result = resolve(definition, [], {
      statuses: { player: [status('tether')] },
      health: { player: 80, enemy: 90, protector: 0 },
    }).result

    expect(result.health.player).toBe(70)
    definition.passiveDefinitions!.wards!.tether!.triggers.redirect!.effects = [
      { type: 'redirect-damage', actor: 'event.source', percent: 100 },
    ]
    result = resolve(definition, [], {
      statuses: { player: [status('tether')], enemy: [status('tether')] },
    }).result
    expect(result.health.player).toBe(80)
    expect(result.health.enemy).toBe(80)
    expect(result.entries.filter((entry) => entry.redirected)).toHaveLength(1)
  })

  it('protects redirected and reactive packets by default, with explicit reaction opt-out', () => {
    const definition = fixture()
    const options = { statuses: { player: [status('tether')], protector: [status('shield')] } }
    let result = resolve(definition, [], options).result
    expect(result.health.protector).toBe(60)
    expect(result.mechanics!.resources.barrier).toBe(1)
    definition.passiveDefinitions!.wards!.shield!.triggers.absorb!.includeReactions = false
    result = resolve(definition, [], options).result
    expect(result.health.protector).toBe(55)
    expect(result.mechanics!.resources.barrier).toBe(6)
  })

  it('reduces healing before the missing-HP cap and exposes adjusted overheal and actual restored HP', () => {
    const definition = fixture()

    const { result, frames } = resolve(definition, ['heal'], {
      health: { player: 75, enemy: 90, protector: 60 },
      statuses: { player: [status('soaked')] },
    })

    expect(result.entries.find((entry) => entry.type === 'healed')).toMatchObject({
      amount: 5,
      incomingAmount: 20,
    })

    const event = frames.find((frame) => frame.mechanicsEvent?.event === 'healing-resolved')!
      .mechanicsEvent!.effect!

    expect(event).toMatchObject({ rawAmount: 20, amount: 5, incomingAmount: 20, overheal: 5 })
    expect(result.health.player).toBe(70)
  })

  it('allows healing cancellation without turning healing into damage', () => {
    const definition = fixture()
    definition.passiveDefinitions!.wards!.dampen!.triggers.reduce!.effects = [
      { type: 'adjust-effect', amount: -999 },
    ]

    const result = resolve(definition, ['heal'], {
      health: { player: 40, enemy: 90, protector: 60 },
      statuses: { player: [status('soaked')] },
    }).result

    expect(result.entries.find((entry) => entry.type === 'healed')!.amount).toBe(0)
    expect(result.health.player).toBe(30)
  })

  it('consumes item casts and their normal costs when interception cancels their healing', () => {
    const definition = fixture()
    definition.moves.heal!.resourceCosts = { barrier: 2 }
    definition.passiveDefinitions!.wards!.dampen!.triggers.reduce!.effects = [
      { type: 'adjust-effect', amount: 0, percent: -100 },
    ]

    const { result, frames } = resolve(definition, [], {
      health: { player: 40, enemy: 90, protector: 60 },
      statuses: { player: [status('soaked')] },
      plan: [{ move: 'heal', target: 'player', item: 'potion', itemType: 'potion', consume: true }],
    })

    expect(result.usedItems).toEqual(['potion'])
    expect(result.mechanics!.resources.barrier).toBe(4)
    expect(frames.find((frame) => frame.kind === 'action')!.spentAp).toBe(1)
    expect(result.entries.some((entry) => entry.type === 'itemUsed')).toBe(true)
  })

  it('prevents lethal HP loss before defeat and preserves once-only receipts through save-shaped state', () => {
    const definition = fixture()

    const first = resolve(definition, [], {
      health: { player: 5, enemy: 90, protector: 60 },
      statuses: { player: [status('rescue')] },
    }).result

    expect(first.health.player).toBe(1)
    expect(first.outcome).toBeUndefined()
    expect(first.entries.find((entry) => entry.type === 'attack')).toMatchObject({
      damage: 4,
      prevented: 6,
    })

    const saved = savedCombatSchema.parse({
      round: 2,
      seed: first.seed,
      started: true,
      guard: first.guard,
      statuses: first.statuses,
      cooldowns: first.cooldowns,
      mechanics: first.mechanics,
      plan: [],
      enemies: {},
      escape: false,
      log: first.entries,
    })

    expect(saved.mechanics!.passiveFired).toHaveLength(1)

    const next = resolve(definition, [], {
      health: first.health,
      mechanics: saved.mechanics,
      round: 2,
      statuses: first.statuses,
    }).result

    expect(next.health.player).toBe(0)
    expect(next.outcome).toBe('defeat')
  })

  it('retains lethal protection against later amount increases and does not consume it on nonlethal hits', () => {
    const definition = fixture()

    const sim = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90, protector: 60 },
      maximumHealth: { player: 80, enemy: 90, protector: 60 },
      statuses: { player: [status('rescue')] },
    })

    sim.resolve()
    expect(sim.snapshot().mechanics!.passiveFired).toBeUndefined()
    definition.passiveDefinitions!.wards!.rescue!.triggers.later = {
      event: 'damage-pending',
      target: 'self',
      once: false,
      conditions: [],
      effects: [{ type: 'adjust-effect', amount: 20 }],
    }
    expect(
      resolve(definition, [], {
        health: { player: 5, enemy: 90, protector: 60 },
        statuses: { player: [status('rescue')] },
      }).result.health.player,
    ).toBe(1)
  })

  it('intercepts periodic damage while retaining its existing defense/Guard rules', () => {
    const definition = fixture()
    definition.statuses!.venom = {
      type: 'damage',
      label: 'Venom',
      description: '',
      duration: 2,
      amount: 8,
    }

    const result = resolve(definition, [], {
      statuses: { player: [status('shield'), status('venom')] },
      guard: { player: 20 },
      enemies: { enemy: { moves: [], cursor: 0 }, protector: { moves: [], cursor: 0 } },
    }).result

    expect(result.health.player).toBe(78)
    expect(result.entries.find((entry) => entry.type === 'periodicDamage')).toMatchObject({
      amount: 2,
      absorbed: 6,
    })
  })

  it('runs interception synchronously inside reactive effects and preserves outer event attribution', () => {
    const definition = fixture()
    definition.mechanics!.triggers.thorns = {
      event: 'damage-received',
      target: 'enemy',
      once: false,
      conditions: [],
      effects: [{ type: 'damage', actor: 'event.source', source: 'event.target', amount: 10 }],
    }

    const { result, frames } = resolve(definition, ['hit'], {
      statuses: { player: [status('shield')] },
      enemies: { enemy: { moves: [], cursor: 0 }, protector: { moves: [], cursor: 0 } },
    })

    expect(result.health.player).toBe(76)
    expect(
      frames.find((frame) => frame.mechanicsEvent?.interception)!.mechanicsEvent!.effect,
    ).toMatchObject({ source: 'enemy', target: 'player', reactive: true, absorbed: 6 })
    expect(
      result.entries.find((entry) => entry.type === 'attack' && entry.target === 'enemy')!.damage,
    ).toBe(10)
  })

  it('rolls back overflow with HP, shield resources, RNG and history unchanged', () => {
    const definition = fixture()
    addTrigger(definition, 'overflow', 'damage-pending', [
      { type: 'adjust-effect', amount: Number.MAX_SAFE_INTEGER },
    ])

    const sim = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90, protector: 60 },
      maximumHealth: { player: 80, enemy: 90, protector: 60 },
      statuses: { player: [status('shield')] },
    })

    const before = sim.report()
    expect(() => sim.resolve()).toThrow('overflow')
    expect(sim.report()).toEqual(before)
  })

  it('preserves extension fields while clearing interception union fields and reads neutral counters', () => {
    expect(
      mergeCombatRuleEffects(
        [{ type: 'redirect-damage', actor: 'enemy', percent: 50, maximum: 5, extension: 'keep' }],
        [{ type: 'prevent-lethal', minimumHealth: 1 }],
      )[0],
    ).toMatchObject({
      type: 'prevent-lethal',
      minimumHealth: 1,
      actor: undefined,
      percent: undefined,
      maximum: undefined,
      extension: 'keep',
    })

    const event = {
      source: 'enemy',
      target: 'player',
      delivery: 'direct' as const,
      reactive: false,
      rawAmount: 10,
      typeAmount: 8,
      blocked: 2,
      amount: 4,
    }

    expect(combatEventAmount(0, { field: 'incomingAmount', factor: 1 }, event)).toBe(6)
    expect(combatEventAmount(0, { field: 'absorbed', factor: 1 }, event)).toBe(0)
    expect(
      evaluateCombatCondition(
        { type: 'event-flag', field: 'redirected', value: false },
        { event, health: { player: 80 }, resources: {}, statuses: {}, phase: undefined },
      ).matched,
    ).toBe(true)
  })
})
