import { describe, expect, it } from 'vite-plus/test'
import {
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  inventorySchema,
  combatPassiveReferencesSchema,
  combatMechanicsStateSchema,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  CombatSimulation,
  combatSimulationSetup,
  validateCombatMechanicsState,
  resolveCombatRound,
} from '@ancadeba/game-runtime'
import { applyCommand, inspectProject, validateProject, object } from '@ancadeba/editor-core'

function fixture() {
  const library = combatLibrarySchema.parse({
    'schema-version': '1.0.0',
    id: 'water',
    statuses: {
      charged: {
        type: 'composite',
        label: 'Charged',
        duration: 3,
        stacking: { maximum: 3 },
        intensity: { initial: 1, maximum: 3 },
        passives: [{ library: 'water', id: 'current-return' }],
      },
      venom: { type: 'damage', label: 'Venom', duration: 2, amount: 1 },
    },
    passives: {
      'wave-refund': {
        label: 'Wave refund',
        triggers: {
          refund: {
            event: 'damage-received',
            target: 'self',
            damageType: 'water',
            effects: [{ type: 'change-resource', resource: 'energy', amount: 3 }],
          },
        },
      },
      'current-return': {
        label: 'Current return',
        triggers: {
          refund: {
            event: 'damage-dealt',
            source: 'self',
            damageType: 'lightning',
            effects: [
              { type: 'change-resource', resource: 'energy', amount: 1 },
              { type: 'change-resource', resource: 'exhaustion', amount: -2 },
            ],
          },
        },
      },
      'one-breath': {
        label: 'One breath',
        triggers: {
          refund: {
            event: 'turn-start',
            actor: 'self',
            once: true,
            effects: [{ type: 'heal', actor: 'self', amount: 5 }],
          },
        },
      },
    },
  })

  const inventory = inventorySchema.parse({
    'schema-version': '1.0.0',
    owners: {
      diver: {
        label: 'Diver',
        equipmentSlots: { body: 'Body', head: 'Head' },
        combatStats: { health: { source: 'game.state', path: ['hp'] }, maximumHealth: 80 },
      },
    },
    itemTypes: {
      suit: {
        label: 'Diving suit',
        equipmentSlots: ['body', 'head'],
        combatEffects: { passives: [{ library: 'water', id: 'wave-refund' }] },
      },
    },
    items: {
      suit: { itemType: 'suit', placement: { type: 'equipped', owner: 'diver', slot: 'body' } },
      spare: { itemType: 'suit', placement: { type: 'carried', owner: 'diver' } },
    },
  })

  const source = combatSourceSchema.parse({
    'schema-version': '1.0.0',
    id: 'passives',
    label: 'Passives',
    seed: 1024,
    player: {
      id: 'player',
      label: 'Diver',
      equipmentOwner: 'diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 4,
      moves: ['hit', 'attune', 'cleanse', 'guard'],
    },
    enemies: [
      {
        id: 'eel',
        label: 'Eel',
        health: { source: 'game.state', path: ['eel'] },
        maximumHealth: 90,
        ap: 1,
        moves: ['wave'],
        rotation: ['wave'],
      },
    ],
    moves: {
      hit: {
        type: 'attack',
        label: 'Arc',
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
      attune: {
        type: 'ability',
        label: 'Attune',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'charge', type: 'apply-status', status: 'charged' }],
      },
      cleanse: {
        type: 'ability',
        label: 'Cleanse',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'cleanse', type: 'remove-status', status: 'charged' }],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 20 },
    },
    sharedStatuses: [{ library: 'water', id: 'charged' }],
    mechanics: {
      resources: {
        energy: { initial: 10, maximum: 100, actor: 'player' },
        exhaustion: { initial: 20, maximum: 100, actor: 'player' },
      },
    },
  })

  const resolve = () => {
    const resolved = resolveCombatSource(
      source,
      new Map([['water', library]]),
      undefined,
      inventory,
    )

    if (!resolved.definition) throw new Error(JSON.stringify(resolved.issues))

    return resolved.definition
  }

  const setup = (definition: CombatDefinition) =>
    combatSimulationSetup(definition, (binding) => (binding.path[0] === 'hp' ? 50 : 90), inventory)

  const simulate = () => {
    const definition = resolve()

    return new CombatSimulation(definition, setup(definition))
  }

  return { library, inventory, source, resolve, setup, simulate }
}

const charged = [{ id: 'charged', source: 'player', remaining: 3, stacks: 3, intensity: 3 }]

describe('equipment and status granted shared passives', () => {
  it('validates unique bounded references, contextual contracts and missing grants', () => {
    expect(
      combatPassiveReferencesSchema.safeParse([
        { library: 'water', id: 'one' },
        { library: 'water', id: 'one' },
      ]).success,
    ).toBe(false)
    const { library, source, inventory } = fixture()
    library.passives!['wave-refund']!.triggers.refund!.delivery = 'periodic'
    expect(combatLibrarySchema.safeParse(library).success).toBe(true)
    library.passives!['wave-refund']!.triggers.refund!.event = 'turn-start'
    expect(combatLibrarySchema.safeParse(library).success).toBe(false)
    inventory.itemTypes.suit!.combatEffects!.passives = [{ library: 'missing', id: 'wave-refund' }]
    expect(
      resolveCombatSource(
        source,
        new Map([['water', fixture().library]]),
        undefined,
        inventory,
      ).issues.some((issue) => issue.message.includes('Missing shared passive')),
    ).toBe(true)
  })

  it('imports status dependencies transitively without looping on passive/status reference cycles', () => {
    const f = fixture()
    f.library.passives!['current-return']!.triggers.refund!.effects.push(
      { type: 'apply-status', actor: 'self', status: 'charged' },
      { type: 'apply-status', actor: 'event.target', status: 'venom' },
    )
    const definition = f.resolve()
    expect(definition.statuses!.venom).toBeDefined()
    expect(Object.keys(definition.passiveDefinitions!.water!)).toEqual([
      'current-return',
      'wave-refund',
    ])
  })

  it('rejects conflicting shared passive dependencies while allowing explicit local status overrides', () => {
    const f = fixture()
    f.library.passives!['current-return']!.triggers.refund!.effects.push({
      type: 'apply-status',
      actor: 'event.target',
      status: 'venom',
    })

    const other = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'other',
      statuses: { venom: { type: 'damage', label: 'Other venom', duration: 1, amount: 99 } },
    })

    f.source.sharedStatuses!.push({ library: 'other', id: 'venom' })

    const libraries = new Map([
      ['water', f.library],
      ['other', other],
    ])

    expect(
      resolveCombatSource(f.source, libraries, undefined, f.inventory).issues.some((issue) =>
        issue.message.includes('conflicting'),
      ),
    ).toBe(true)
    f.source.sharedStatuses = f.source.sharedStatuses!.filter(
      (reference) => reference.id !== 'venom',
    )
    f.source.statuses = { venom: other.statuses.venom! }
    expect(resolveCombatSource(f.source, libraries, undefined, f.inventory).issues).toEqual([])
  })

  it('fires only equipped grants, independently per equipped item, with source traces and logs', () => {
    const f = fixture()
    let sim = f.simulate()
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(13)
    expect(
      sim.trace().find((frame) => frame.mechanicsEvent?.passive)?.mechanicsEvent,
    ).toMatchObject({
      matched: true,
      trigger: 'refund',
      passive: {
        kind: 'equipment',
        id: 'suit',
        actor: 'player',
        library: 'water',
        passive: 'wave-refund',
      },
    })
    f.inventory.items.suit!.placement = { type: 'carried', owner: 'diver' }
    sim = f.simulate()
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(10)
    f.inventory.items.suit!.placement = { type: 'equipped', owner: 'diver', slot: 'body' }
    f.inventory.items.spare!.placement = { type: 'equipped', owner: 'diver', slot: 'head' }
    sim = f.simulate()
    const result = sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(16)
    expect(
      result.entries
        .filter((entry) => entry.type === 'passiveTriggered')
        .map((entry) => entry.passive!.id),
    ).toEqual(['suit', 'spare'])
  })

  it('activates statuses immediately for later events, and stops their grants on removal or expiry', () => {
    const f = fixture()
    let sim = f.simulate()
    sim.queue('attune')
    sim.queue('hit', 'eel')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources).toMatchObject({ energy: 14, exhaustion: 18 })
    sim.queue('cleanse')
    sim.queue('hit', 'eel')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources).toMatchObject({ energy: 17, exhaustion: 18 })
    const definition = f.resolve()
    sim = new CombatSimulation(definition, {
      ...f.setup(definition),
      statuses: { player: [{ ...charged[0]!, remaining: 1 }] },
    })
    sim.resolve()
    expect(sim.snapshot().statuses.player ?? []).toEqual([])
    sim.queue('hit', 'eel')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.exhaustion).toBe(20)
  })

  it('recognizes new grants for later queued notifications but never for the current dispatch', () => {
    const f = fixture()
    f.library.passives!['current-return']!.triggers = {
      resolved: {
        event: 'damage-resolved',
        target: 'self',
        once: false,
        conditions: [],
        effects: [{ type: 'change-resource', resource: 'energy', amount: 1 }],
      },
    }
    f.source.mechanics!.triggers.attune = {
      event: 'damage-received',
      target: 'player',
      once: false,
      conditions: [],
      effects: [{ type: 'apply-status', actor: 'player', status: 'charged' }],
    }
    let sim = f.simulate()
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(14)
    f.source.mechanics!.triggers.attune!.event = 'damage-resolved'
    sim = f.simulate()
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(13)
  })

  it('runs once per active status entry, regardless of stacks or intensity', () => {
    const f = fixture(),
      definition = f.resolve()

    const sim = new CombatSimulation(definition, {
      ...f.setup(definition),
      statuses: { player: charged },
    })

    sim.queue('hit', 'eel')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(14)
  })

  it('binds self to the bearer for enemy statuses and attributes applied statuses to the passive owner', () => {
    const f = fixture()
    f.library.passives!['current-return']!.triggers.refund!.damageType = 'water'
    f.library.passives!['current-return']!.triggers.refund!.effects = [
      { type: 'apply-status', actor: 'event.target', status: 'venom' },
    ]
    const definition = f.resolve()

    const sim = new CombatSimulation(definition, {
      ...f.setup(definition),
      statuses: { eel: [{ id: 'charged', source: 'eel', remaining: 3 }] },
    })

    sim.resolve()
    expect(sim.snapshot().statuses.player!.find((status) => status.id === 'venom')!.source).toBe(
      'eel',
    )
  })

  it('suppresses grants removed by encounter triggers and finishes only the already matched passive effect list', () => {
    const f = fixture()
    f.source.mechanics!.triggers.clear = {
      event: 'damage-dealt',
      source: 'player',
      once: false,
      conditions: [],
      effects: [{ type: 'remove-status', actor: 'player', status: 'charged' }],
    }
    let definition = f.resolve()

    let sim = new CombatSimulation(definition, {
      ...f.setup(definition),
      statuses: { player: charged },
    })

    sim.queue('hit', 'eel')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.exhaustion).toBe(20)
    delete f.source.mechanics!.triggers.clear
    f.library.passives!['current-return']!.triggers = {
      remove: {
        event: 'damage-dealt',
        source: 'self',
        once: false,
        conditions: [],
        effects: [
          { type: 'remove-status', actor: 'self', status: 'charged' },
          { type: 'change-resource', resource: 'energy', amount: 1 },
        ],
      },
      late: {
        event: 'damage-dealt',
        source: 'self',
        once: false,
        conditions: [],
        effects: [{ type: 'change-resource', resource: 'energy', amount: 50 }],
      },
    }
    definition = f.resolve()
    sim = new CombatSimulation(definition, {
      ...f.setup(definition),
      statuses: { player: charged },
    })
    sim.queue('hit', 'eel')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(14)
  })

  it('does not fire received-damage passives for immune or fully guarded hits', () => {
    const f = fixture()
    f.source.player.damageDefenses = { immunities: ['water'] }
    let sim = f.simulate()
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(10)
    f.source.player.damageDefenses = undefined
    sim = f.simulate()
    sim.queue('guard')
    sim.resolve()
    expect(sim.snapshot().mechanics!.resources.energy).toBe(10)
  })

  it('keeps once-only receipts per source across rounds, save-shaped state and status reapplication', () => {
    const f = fixture()
    f.library.statuses.charged!.passives = [{ library: 'water', id: 'one-breath' }]
    const definition = f.resolve()

    const sim = new CombatSimulation(definition, {
      ...f.setup(definition),
      statuses: { player: charged },
    })

    sim.resolve()
    expect(sim.snapshot().health.player).toBe(45)
    const state = sim.snapshot()
    expect(state.mechanics!.fired).toEqual([])
    expect(state.mechanics!.passiveFired).toEqual([
      {
        kind: 'status',
        actor: 'player',
        id: 'charged',
        library: 'water',
        passive: 'one-breath',
        trigger: 'refund',
      },
    ])
    const restored = combatMechanicsStateSchema.parse(state.mechanics)
    validateCombatMechanicsState(definition, restored)

    const result = resolveCombatRound(definition, {
      ...state,
      maximumHealth: { player: 80, eel: 90 },
      equipment: f.setup(definition).equipment,
      escape: false,
      plan: [
        { move: 'cleanse', target: 'player' },
        { move: 'attune', target: 'player' },
      ],
      mechanics: restored,
    })

    expect(result.health.player).toBe(35)
    expect(result.mechanics!.passiveFired).toEqual(restored.passiveFired)

    const next = resolveCombatRound(definition, {
      ...result,
      round: 3,
      maximumHealth: { player: 80, eel: 90 },
      equipment: f.setup(definition).equipment,
      escape: false,
      plan: [],
      enemies: state.enemies,
    })

    expect(next.health.player).toBe(25)
    expect(
      next.entries.some(
        (entry) => entry.type === 'passiveTriggered' && entry.passive?.kind === 'status',
      ),
    ).toBe(false)
  })
  it('separates once-only equipment sources and rejects malformed or duplicate receipts', () => {
    const f = fixture()
    f.inventory.itemTypes.suit!.combatEffects!.passives = [{ library: 'water', id: 'one-breath' }]
    f.inventory.items.spare!.placement = { type: 'equipped', owner: 'diver', slot: 'head' }
    const sim = f.simulate()
    sim.resolve()
    expect(sim.snapshot().health.player).toBe(50)
    const state = sim.snapshot().mechanics!
    expect(state.passiveFired).toHaveLength(2)
    expect(() =>
      validateCombatMechanicsState(f.resolve(), {
        ...state,
        passiveFired: [state.passiveFired![0]!, state.passiveFired![0]!],
      }),
    ).toThrow('receipts')
    expect(() =>
      validateCombatMechanicsState(f.resolve(), {
        ...state,
        passiveFired: [{ ...state.passiveFired![0]!, trigger: 'missing' }],
      }),
    ).toThrow('reference')
  })

  it('supports passive-only encounters and does not retroactively observe events before activation', () => {
    const f = fixture()
    f.source.mechanics = undefined
    f.inventory.itemTypes.suit!.combatEffects!.passives = []
    f.library.passives!['current-return']!.triggers = {
      heal: {
        event: 'turn-start',
        actor: 'self',
        once: false,
        conditions: [],
        effects: [{ type: 'heal', actor: 'self', amount: 5 }],
      },
    }
    const sim = f.simulate()
    sim.queue('attune')
    sim.resolve()
    expect(sim.snapshot().health.player).toBe(40)
    sim.resolve()
    expect(sim.snapshot().health.player).toBe(35)
    expect(sim.snapshot().mechanics).toMatchObject({ initialized: true, resources: {} })
  })

  it('shares reaction safeguards and rolls back looping passives with state, RNG and history intact', () => {
    const f = fixture()
    f.library.passives!['current-return']!.triggers = {
      loop: {
        event: 'healing-resolved',
        target: 'self',
        once: false,
        includeReactions: true,
        conditions: [],
        effects: [{ type: 'heal', actor: 'self', amount: 1 }],
      },
    }
    f.source.moves.heal = {
      type: 'ability',
      label: 'Heal',
      description: '',
      apCost: 1,
      target: 'self',
      effects: [{ id: 'heal', type: 'heal', amount: 1 }],
    }
    f.source.player.moves.push('heal')
    const definition = f.resolve()

    const sim = new CombatSimulation(definition, {
      ...f.setup(definition),
      statuses: { player: charged },
    })

    sim.queue('heal')
    const before = sim.report()
    expect(() => sim.resolve()).toThrow('operation limit')
    expect(sim.report()).toEqual(before)
  })

  it('preserves shared/passive reference extensions and protects deletions across editor saves', () => {
    const f = fixture()

    const documents = {
      'game.json': {
        'schema-version': '1.0.0',
        id: 'passives',
        version: '1',
        title: 'Passives',
        scenes: ['home'],
        inventory: ['gear'],
        combat: ['passives'],
        combatLibraries: ['water'],
      },
      'scenes/home.json': {
        'schema-version': '1.0.0',
        id: 'home',
        title: 'Home',
        type: 'game',
        screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
        components: [],
      },
      'inventory/gear.json': f.inventory,
      'combat/passives.json': f.source,
      'combat-libraries/water.json': f.library,
      'rules/state.json': {
        state: [
          { path: ['hp'], value: 50 },
          { path: ['eel'], value: 90 },
        ],
        actions: {},
      },
    }

    object(documents['game.json']).rules = ['state']
    expect(validateProject(documents)).toEqual([])
    object(
      object(object(documents['combat-libraries/water.json']).passives)['wave-refund'],
    ).extension = 'keep'

    const saved = applyCommand(
      { revision: 'one', documents },
      { type: 'game.upsertCombatLibrary', library: f.library },
    )

    expect(
      object(
        object(object(saved.project.documents['combat-libraries/water.json']).passives)[
          'wave-refund'
        ],
      ).extension,
    ).toBe('keep')

    const library = combatLibrarySchema.parse(
      saved.project.documents['combat-libraries/water.json'],
    )

    delete library.passives!['wave-refund']
    expect(() =>
      applyCommand(saved.project, { type: 'game.upsertCombatLibrary', library }),
    ).toThrow()
    const source = combatSourceSchema.parse(saved.project.documents['combat/passives.json'])
    const view = inspectProject(saved.project)
    expect(view.combat!.passives!.passiveDefinitions!.water!['wave-refund']).toBeDefined()
    const updated = applyCommand(saved.project, { type: 'game.upsertCombat', encounter: source })
    expect(
      object(updated.project.documents['combat/passives.json']).passiveDefinitions,
    ).toBeUndefined()
  })
})
