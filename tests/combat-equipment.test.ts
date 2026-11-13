import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  inventorySchema,
  combatLibrarySchema,
  combatSourceSchema,
  resolveCombatSource,
  equipmentCombatEffectsSchema,
  combatSimulationScenarioSchema,
  type CombatDefinition,
  type CombatEquipment,
} from '@ancadeba/schemas'
import {
  combatEquipmentFor,
  combatOwnerEquipment,
  combatDamageProfile,
  combatTypedDamage,
  combatEquipmentResourceGain,
  combatSimulationSetup,
  runCombatScenario,
  CombatSimulation,
  resolveCombatRound,
  combatStatusImmune,
  combatMoveRestriction,
  Engine,
  GameLoader,
  type EngineMessages,
  type GameSaveStore,
} from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject, validateProject, object } from '@ancadeba/editor-core'
import { mergeEquipmentCombatEffects } from '../packages/editor-core/src/equipmentCombatEditing.js'

function fixture() {
  const inventory = inventorySchema.parse({
    'schema-version': '1.0.0',
    owners: {
      diver: {
        label: 'Diver',
        equipmentSlots: { body: 'Body', back: 'Back', feet: 'Feet', head: 'Head' },
        combatStats: { health: { source: 'game.state', path: ['hp'] }, maximumHealth: 80 },
      },
      other: { label: 'Other', equipmentSlots: { body: 'Body' } },
    },
    itemTypes: {
      suit: {
        label: 'Diving suit',
        equipmentSlots: ['body'],
        combatEffects: { damageDefenses: { resistances: { water: 50 } } },
      },
      breather: {
        label: 'Rebreather',
        equipmentSlots: ['back'],
        combatEffects: {
          resourceGains: { exhaustion: { percent: -50 }, seal: { percent: -100 } },
          grantedMoves: [{ library: 'gear', id: 'vent' }],
        },
      },
      fins: {
        label: 'Diving fins',
        equipmentSlots: ['feet'],
        combatEffects: { resourceGains: { exhaustion: { flat: -2 } } },
      },
      mask: {
        label: 'Mask',
        equipmentSlots: ['head'],
        combatEffects: { statusImmunities: ['venom'], blockedMoveCategories: ['weapon'] },
      },
      bag: { label: 'Bag', container: true, equipmentSlots: ['back'] },
    },
    items: {
      suit: { itemType: 'suit', placement: { type: 'equipped', owner: 'diver', slot: 'body' } },
      breather: {
        itemType: 'breather',
        placement: { type: 'equipped', owner: 'diver', slot: 'back' },
      },
      fins: { itemType: 'fins', placement: { type: 'carried', owner: 'diver' } },
      mask: { itemType: 'mask', placement: { type: 'carried', owner: 'diver' } },
      bag: { itemType: 'bag', placement: { type: 'carried', owner: 'diver' } },
    },
  })

  const library = combatLibrarySchema.parse({
    'schema-version': '1.0.0',
    id: 'gear',
    moves: {
      vent: {
        type: 'ability',
        label: 'Vent ballast',
        categories: ['utility'],
        apCost: 1,
        resourceCosts: { stamina: 3 },
        target: 'self',
        effects: [{ id: 'vent', type: 'change-resource', resource: 'exhaustion', amount: -20 }],
      },
    },
  })

  const source = combatSourceSchema.parse({
    'schema-version': '1.0.0',
    id: 'water',
    label: 'Water',
    allowEscape: true,
    seed: 1024,
    player: {
      id: 'player',
      label: 'Diver',
      equipmentOwner: 'diver',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 3,
      moves: ['strike', 'rest', 'guard'],
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
      strike: {
        type: 'attack',
        label: 'Strike',
        categories: ['weapon'],
        apCost: 1,
        damage: { min: 5, max: 5 },
      },
      wave: {
        type: 'attack',
        label: 'Wave',
        apCost: 1,
        damageType: 'water',
        damage: { min: 10, max: 10 },
      },
      rest: {
        type: 'ability',
        label: 'Rest',
        target: 'self',
        apCost: 1,
        effects: [{ id: 'recover', type: 'change-resource', resource: 'exhaustion', amount: -20 }],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 2 },
    },
    statuses: {
      venom: { type: 'damage', label: 'Venom', duration: 2, amount: 4 },
      tired: { type: 'modifier', label: 'Tired', duration: 1, modifiers: { ap: -1 } },
      insulated: {
        type: 'composite',
        label: 'Insulated',
        duration: 2,
        damageDefenses: { resistances: { water: 25 } },
      },
    },
    mechanics: {
      resources: {
        exhaustion: { actor: 'player', initial: 30, maximum: 100 },
        stamina: { actor: 'player', initial: 100, maximum: 100 },
        seal: { initial: 0, maximum: 100 },
      },
      triggers: {
        pressure: {
          event: 'turn-start',
          actor: 'player',
          effects: [{ type: 'change-resource', resource: 'exhaustion', amount: 10 }],
        },
        gauge: {
          event: 'round-start',
          effects: [{ type: 'change-resource', resource: 'seal', amount: 10 }],
        },
        fatigue: {
          event: 'resource-changed',
          resource: 'exhaustion',
          conditions: [{ type: 'resource', resource: 'exhaustion', operator: 'gte', value: 40 }],
          effects: [{ type: 'apply-status', actor: 'player', status: 'tired' }],
        },
      },
    },
  })

  const resolved = resolveCombatSource(source, new Map([['gear', library]]), undefined, inventory)

  if (!resolved.definition) throw new Error(JSON.stringify(resolved.issues))
  const definition = resolved.definition

  const read = (binding: { path: readonly (string | number)[] }) =>
    binding.path[0] === 'hp' ? 80 : 90

  const setup = combatSimulationSetup(definition, read, inventory)
  const equipment = setup.equipment!

  const documents = {
    'game.json': {
      'schema-version': '1.0.0',
      id: 'gear',
      title: 'Gear',
      version: '1',
      scenes: ['home', 'fight'],
      'initial-scene': 'home',
      inventory: ['gear'],
      rules: ['state'],
      combat: ['water'],
      combatLibraries: ['gear'],
    },
    'inventory/gear.json': inventory,
    'combat-libraries/gear.json': library,
    'combat/water.json': source,
    'rules/state.json': {
      state: [
        { path: ['hp'], value: 80 },
        { path: ['eel'], value: 90 },
      ],
      actions: {},
    },
    'scenes/home.json': {
      'schema-version': '1.0.0',
      id: 'home',
      title: 'Home',
      type: 'game',
      screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
      components: [],
    },
    'scenes/fight.json': {
      'schema-version': '1.0.0',
      id: 'fight',
      title: 'Fight',
      type: 'game',
      screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
      components: [
        { id: 'combat', type: 'combat', encounter: 'water', placement: { row: 1, column: 1 } },
      ],
    },
  }

  return { inventory, library, source, definition, read, setup, equipment, documents }
}

function resolve(
  definition: CombatDefinition,
  equipment: CombatEquipment,
  moves: string[] = [],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
) {
  return resolveCombatRound(definition, {
    health: { player: 80, eel: 90 },
    maximumHealth: { player: 80, eel: 90 },
    guard: {},
    seed: 1024,
    escape: false,
    plan: moves.map((move) => ({
      move,
      target:
        definition.moves[move]?.type === 'ability' && definition.moves[move].target === 'self'
          ? 'player'
          : 'eel',
    })),
    enemies: { eel: { moves: [{ move: 'wave', target: 'player' }], cursor: 0 } },
    equipment,
    ...options,
  })
}

async function launch(documents = fixture().documents, store?: GameSaveStore) {
  const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

  const engine = new Engine(
    new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (path) => JSON.stringify(object(documents)[path]),
          readBytes: async () => new Uint8Array(),
        },
        logger,
      ),
    ),
    { mount: () => () => {} },
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      ...(store ? { saveStore: store } : {}),
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  engine.lifecycle!.startGame()

  const flush = () => {
    for (let i = 0; i < 6; i++) engine.flushMessages()
  }

  const enter = (id: string) => {
    engine.lifecycle!.enterScene(id)
    flush()
  }

  const game = () => engine.lifecycle!.currentGame!
  const scene = () => engine.lifecycle!.activeScene!

  const command = (
    command: Parameters<NonNullable<ReturnType<typeof game>['combat']>['request']>[2],
  ) => {
    game().combat!.request(scene(), 'combat', command)
    flush()
  }

  const snapshot = () => game().combat!.snapshot(scene(), 'combat')!

  return { engine, game, scene, enter, command, snapshot }
}

describe('equipment combat defenses and mechanics', () => {
  it('validates identifiers, duplicate grants, percent bounds and safe flat modifiers', () => {
    expect(
      equipmentCombatEffectsSchema.safeParse({
        resourceGains: { exhaustion: { percent: -100.01 } },
      }).success,
    ).toBe(false)
    expect(
      equipmentCombatEffectsSchema.safeParse({ resourceGains: { exhaustion: { percent: 0.001 } } })
        .success,
    ).toBe(false)
    expect(
      equipmentCombatEffectsSchema.safeParse({
        resourceGains: { exhaustion: { flat: Number.MAX_SAFE_INTEGER + 1 } },
      }).success,
    ).toBe(false)
    expect(
      equipmentCombatEffectsSchema.safeParse({
        grantedMoves: [
          { library: 'gear', id: 'vent' },
          { library: 'gear', id: 'vent' },
        ],
      }).success,
    ).toBe(false)
  })

  it('uses only equipped instances for the correct owner and returns deeply immutable contributions', () => {
    const { inventory, definition } = fixture()
    const equipment = combatEquipmentFor(definition, inventory)
    expect(equipment.player?.map((entry) => entry.item)).toEqual(['suit', 'breather'])
    expect(Object.isFrozen(equipment.player?.[0]?.effects.damageDefenses?.resistances)).toBe(true)
    inventory.items.suit!.placement = { type: 'carried', owner: 'diver' }
    inventory.items.breather!.placement = { type: 'inside', container: 'bag' }
    expect(combatEquipmentFor(definition, inventory)).toEqual({})
    expect(
      combatOwnerEquipment(
        inventory,
        Object.entries(inventory.items).map(([id, item]) => ({ id, ...item })),
        'other',
      ),
    ).toEqual([])
  })

  it('combines actor, equipment and temporary defenses before Guard and records actual damage', () => {
    const { definition, equipment } = fixture()

    const result = resolve(definition, equipment, [], {
      statuses: { player: [{ id: 'insulated', source: 'player', remaining: 2 }] },
    })

    expect(result.health.player).toBe(78)
    expect(result.entries.find((entry) => entry.type === 'attack')).toMatchObject({
      damage: 2,
      damageType: 'water',
      resistance: 75,
      resisted: 8,
    })
    expect(
      combatTypedDamage(10, 'water', combatDamageProfile(definition, 'player', {}, equipment))
        .amount,
    ).toBe(5)
    expect(resolve(definition, {}).health.player).toBe(70)
  })

  it('reduces exhaustion before threshold hooks while leaving unowned gauges unchanged', () => {
    const { definition, equipment } = fixture()
    const result = resolve(definition, equipment)
    expect(result.mechanics?.resources).toMatchObject({ exhaustion: 35, seal: 10 })
    expect(result.statuses.player?.some((entry) => entry.id === 'tired') ?? false).toBe(false)
    expect(result.entries).toContainEqual({
      type: 'resourceAdjusted',
      resource: 'exhaustion',
      requested: 10,
      amount: 5,
      equipment: ['breather'],
    })
    expect(
      resolve(definition, {}).entries.some(
        (entry) => entry.type === 'statusApplied' && entry.status === 'tired',
      ),
    ).toBe(true)
  })

  it('adds flat modifiers before additive percentages and never turns a gain into a loss', () => {
    const { inventory, definition } = fixture()
    inventory.items.fins!.placement = { type: 'equipped', owner: 'diver', slot: 'feet' }
    const equipment = combatEquipmentFor(definition, inventory)
    expect(combatEquipmentResourceGain(equipment, 'player', 'exhaustion', 10)).toMatchObject({
      amount: 4,
      items: ['breather', 'fins'],
    })
    expect(combatEquipmentResourceGain(equipment, 'player', 'exhaustion', 1).amount).toBe(0)
    expect(combatEquipmentResourceGain(equipment, undefined, 'exhaustion', 10).amount).toBe(10)
  })

  it('does not scale fixed sets, recovery losses or action payments', () => {
    const { definition, equipment } = fixture()
    expect(resolve(definition, equipment, ['vent']).mechanics?.resources).toMatchObject({
      exhaustion: 15,
      stamina: 97,
    })
    const fixed = structuredClone(definition)
    fixed.mechanics!.triggers.pressure!.effects = [
      { type: 'set-resource', resource: 'exhaustion', amount: 50 },
    ]
    expect(resolve(fixed, equipment).mechanics?.resources.exhaustion).toBe(50)
  })

  it('makes imported shared moves available only while the granting gear is equipped', () => {
    const { inventory, definition, setup } = fixture()
    expect(definition.player.moves).not.toContain('vent')
    expect(definition.player.equipmentMoves).toContain('vent')
    expect(setup.availableMoves).toContain('vent')
    expect(new CombatSimulation(definition, setup).queueIssue('vent')).toBeUndefined()
    inventory.items.breather!.placement = { type: 'carried', owner: 'diver' }
    const naked = combatSimulationSetup(definition, fixture().read, inventory)
    expect(new CombatSimulation(definition, naked).queueIssue('vent')).toContain('unavailable')
  })

  it('applies equipment status immunities and action restrictions independently of damage defense', () => {
    const { inventory, definition } = fixture()
    inventory.items.mask!.placement = { type: 'equipped', owner: 'diver', slot: 'head' }
    const equipment = combatEquipmentFor(definition, inventory)
    expect(combatStatusImmune(definition, 'player', 'venom', {}, equipment)).toBe(true)
    expect(
      combatMoveRestriction(definition, 'player', definition.moves.strike!, {}, equipment),
    ).toEqual({ category: 'weapon' })
    expect(combatDamageProfile(definition, 'player', {}, equipment).resistances.water).toBe(50)
  })

  it('rejects malformed simulation gear and rolls back overflow without changing reports', () => {
    const { definition, setup } = fixture()
    expect(
      () =>
        new CombatSimulation(definition, {
          ...setup,
          equipment: { player: [setup.equipment!.player![0]!, setup.equipment!.player![0]!] },
        }),
    ).toThrow('Duplicate')
    const equipment = structuredClone(setup.equipment!)
    equipment.player![1]!.effects.resourceGains = { exhaustion: { flat: Number.MAX_SAFE_INTEGER } }
    const simulation = new CombatSimulation(definition, { ...setup, equipment })
    const before = simulation.report()
    expect(() => simulation.resolve()).toThrow('overflow')
    expect(simulation.report()).toEqual(before)
  })

  it('preserves nested extensions and clears removed equipment fields in both editor commands', () => {
    const { documents, inventory } = fixture()
    inventory.itemTypes.suit!.combatEffects = {
      damageDefenses: { resistances: { water: 25 } },
      resourceGains: { exhaustion: { flat: -1 } },
    }
    const source = object(object(documents['inventory/gear.json']).itemTypes)
    const effects = object(object(source.suit).combatEffects)
    effects.extension = 'keep'
    object(object(effects.resourceGains).exhaustion).extension = 'resource'
    const project = { revision: 'one', documents }

    const saved = applyCommand(project, {
      type: 'inventory.setItemPresentation',
      itemType: 'suit',
      presentation: inventory.itemTypes.suit!,
      combatEffects: { resourceGains: { exhaustion: { percent: -50 } } },
    })

    const next = object(
      object(object(saved.project.documents['inventory/gear.json']).itemTypes).suit,
    )

    expect(next.combatEffects).toMatchObject({
      extension: 'keep',
      damageDefenses: undefined,
      resourceGains: { exhaustion: { extension: 'resource', flat: undefined, percent: -50 } },
    })
    const reset = inventorySchema.parse(saved.project.documents['inventory/gear.json'])
    reset.itemTypes.suit!.combatEffects = undefined

    const cleared = applyCommand(saved.project, {
      type: 'game.upsertInventory',
      inventoryId: 'gear',
      inventory: reset,
    })

    expect(
      object(object(object(cleared.project.documents['inventory/gear.json']).itemTypes).suit)
        .combatEffects,
    ).toBeUndefined()
    expect(mergeEquipmentCombatEffects({ extension: 1 }, undefined)).toBeUndefined()
  })

  it('validates gear references and exposes potential grants to action/scenario authoring', () => {
    const { documents } = fixture()
    expect(validateProject(documents)).toEqual([])
    const view = inspectProject({ revision: 'one', documents })
    expect(view.combat!.water!.player.equipmentMoves).toEqual(['vent'])
    const bad = structuredClone(documents)
    object(object(object(bad['inventory/gear.json']).itemTypes).breather).combatEffects = {
      grantedMoves: [{ library: 'missing', id: 'vent' }],
    }
    expect(validateProject(bad).some((issue) => issue.message.includes('shared move'))).toBe(true)
  })

  it('rebuilds saved loadouts from current gear and retains valid numeric bonuses', () => {
    const { inventory, definition, read } = fixture()
    inventory.items.suit!.placement = { type: 'carried', owner: 'diver' }
    inventory.items.breather!.placement = { type: 'carried', owner: 'diver' }
    inventory.itemTypes.suit!.combatBonuses = { attack: 2, defense: 0, guard: 0, maximumHealth: 10 }

    const scenario = combatSimulationScenarioSchema.parse({
      setup: { loadout: { player: { body: 'suit', back: 'breather' } } },
      steps: [{ id: 'vent', plan: [{ move: 'vent' }] }],
      expect: [
        { type: 'resource', resource: 'exhaustion', operator: 'eq', value: 15 },
        { type: 'health', actor: 'player', operator: 'eq', value: 75 },
      ],
    })

    const run = () =>
      runCombatScenario(definition, combatSimulationSetup(definition, read, inventory), scenario)

    const first = run()
    expect(first.status).toBe('passed')
    expect(first.simulation!.report().setup.stats!.player).toMatchObject({
      attack: 2,
      maximumHealth: 90,
    })
    expect(inventory.items.suit!.placement.type).toBe('carried')
    inventory.itemTypes.breather!.combatEffects!.resourceGains!.exhaustion!.percent = -100
    expect(run().status).toBe('failed')
    expect(first.simulation!.snapshot().mechanics!.resources.exhaustion).toBe(15)
  })

  it('rejects missing, incompatible, nested or duplicated loadout selections and preserves health validation', () => {
    const { definition, setup, inventory, read } = fixture()

    for (const loadout of [
      { ghost: { body: 'suit' } },
      { player: { unknown: 'suit' } },
      { player: { body: 'missing' } },
      { player: { back: 'suit' } },
      { player: { back: 'bag', body: 'bag' } },
    ])
      expect(() => new CombatSimulation(definition, { ...setup, loadout })).toThrow()
    inventory.items.breather!.placement = { type: 'inside', container: 'bag' }
    expect(
      () =>
        new CombatSimulation(definition, {
          ...combatSimulationSetup(definition, read, inventory),
          loadout: { player: { back: 'breather' } },
        }),
    ).toThrow('Invalid loadout item')
    inventory.itemTypes.suit!.combatBonuses = { attack: 0, defense: 0, guard: 0, maximumHealth: 10 }
    const base = combatSimulationSetup(definition, () => 90, inventory)
    expect(
      () => new CombatSimulation(definition, { ...base, loadout: { player: { body: null } } }),
    ).toThrow('Invalid simulation health')
  })

  it('clears saved scenario loadouts without retaining old actor or slot entries', () => {
    const { documents } = fixture()

    const scenario = combatSimulationScenarioSchema.parse({
      setup: { loadout: { player: { body: 'suit', back: 'breather' } } },
      steps: [{ id: 'one' }],
      expect: [{ type: 'outcome', value: 'planning' }],
    })

    const save = (project: { revision: string; documents: Record<string, unknown> }) =>
      applyCommand(project, {
        type: 'combat.upsertSimulationScenario',
        encounterId: 'water',
        scenarioId: 'gear',
        scenario,
      }).project

    const first = save({ revision: 'one', documents })
    object(
      object(object(object(first.documents['combat/water.json']).simulationScenarios).gear).setup,
    ).extension = 'keep'
    scenario.setup.loadout = { player: { body: null } }
    const replaced = save(first)
    expect(
      inspectProject(replaced).combatSources!.water!.simulationScenarios!.gear!.setup.loadout,
    ).toEqual({ player: { body: null } })
    scenario.setup.loadout = undefined
    const cleared = save(replaced)

    const setup = object(
      object(object(object(cleared.documents['combat/water.json']).simulationScenarios).gear).setup,
    )

    expect(setup.extension).toBe('keep')
    expect(setup.loadout).toBeUndefined()
  })

  it('removes unequipped gear grants without removing native moves or mutating the initial setup', () => {
    const { definition, setup } = fixture()

    const simulation = new CombatSimulation(definition, {
      ...setup,
      loadout: { player: { body: null, back: null } },
    })

    expect(simulation.queueIssue('vent')).toBeDefined()
    expect(simulation.queueIssue('strike', 'eel')).toBeUndefined()
    expect(simulation.report().setup.equipment).toEqual({})
    expect(setup.equipment!.player).toHaveLength(2)
    simulation.resolve()
    expect(simulation.snapshot().health.player).toBe(70)
    simulation.reset()
    expect(simulation.snapshot().health.player).toBe(80)
  })

  it('selects enemy equipment moves only while equipped and explains unavailable candidates', () => {
    const { source, inventory, library, read } = fixture()
    source.enemies[0]!.equipmentOwner = 'enemy'
    source.enemies[0]!.ai = {
      fallback: 'rotation',
      rules: [{ id: 'vent-first', move: 'vent', conditions: [], maxUses: 1 }],
    }
    inventory.owners.enemy = {
      ...inventory.owners.diver!,
      combatStats: {
        ...inventory.owners.diver!.combatStats!,
        health: source.enemies[0]!.health,
        maximumHealth: 90,
      },
    }
    inventory.items['enemy-breather'] = {
      colors: {},
      itemType: 'breather',
      placement: { type: 'equipped', owner: 'enemy', slot: 'back' },
    }
    const resolved = resolveCombatSource(source, new Map([['gear', library]]), undefined, inventory)
    expect(resolved.issues).toEqual([])
    const definition = resolved.definition!

    const equipped = new CombatSimulation(
      definition,
      combatSimulationSetup(definition, read, inventory),
    )

    expect(equipped.preview()[0]!.choice?.move).toBe('vent')
    inventory.items['enemy-breather']!.placement = { type: 'carried', owner: 'enemy' }

    const carried = new CombatSimulation(
      definition,
      combatSimulationSetup(definition, read, inventory),
    )

    expect(carried.preview()[0]!.choice?.move).toBe('wave')
    expect(carried.preview()[0]!.candidates[0]!.blockers).toContain('equipment')
  })

  it('compares and locks equipment-only effects, releases on escape, and updates granted action eligibility', async () => {
    const app = await launch()
    app.enter('home')
    const stats = app.game().combatStats!
    expect(
      stats.compare('diver', 'fins', 'feet')?.proposed.equipmentEffects?.map((entry) => entry.item),
    ).toContain('fins')
    const before = stats.snapshot('diver')!.version
    expect(app.game().inventory!.equip('fins', 'diver', 'feet').status).toBe('applied')
    expect(stats.snapshot('diver')!.version).not.toBe(before)
    app.enter('fight')
    expect(
      app.game().combat!.canCommand(app.scene(), 'combat', { type: 'queue-move', move: 'vent' }),
    ).toBe(true)
    expect(app.game().inventory!.move('breather', { type: 'carried', owner: 'diver' }).status).toBe(
      'rejected',
    )
    app.command({ type: 'escape' })
    app.command({ type: 'end-turn' })
    app.enter('home')
    expect(app.game().inventory!.move('breather', { type: 'carried', owner: 'diver' }).status).toBe(
      'applied',
    )
  })

  it('restores equipped effects, granted plans and adjusted-resource logs without duplicating gear', async () => {
    const values = new Map<string, string>()

    const store: GameSaveStore = {
      read: (id) => values.get(id),
      write: (id, value) => {
        values.set(id, value)
      },
    }

    const app = await launch(fixture().documents, store)
    app.enter('fight')
    app.command({ type: 'queue-move', move: 'vent' })
    app.command({ type: 'end-turn' })
    expect(app.snapshot()).toMatchObject({
      health: { player: 75 },
      resources: { exhaustion: 15, stamina: 97 },
    })
    expect(app.game().combat!.text(app.scene(), 'combat')).toContain(
      'equipment changes gain 10 → 5',
    )
    app.command({ type: 'queue-move', move: 'vent' })
    expect(app.engine.saves!.save()).toBe(true)
    app.engine.stop()
    const restored = await launch(fixture().documents, store)
    expect(restored.engine.saves!.load()).toBe(true)
    expect(restored.snapshot().plan).toEqual([{ move: 'vent', target: 'player' }])
    expect(restored.snapshot().equipment?.player?.map((entry) => entry.item)).toEqual([
      'suit',
      'breather',
    ])
    expect(restored.snapshot().log.some((entry) => entry.type === 'resourceAdjusted')).toBe(true)
    restored.command({ type: 'end-turn' })
    expect(restored.snapshot().health.player).toBe(70)
    expect(restored.snapshot().resources.exhaustion).toBe(0)
  })
})
