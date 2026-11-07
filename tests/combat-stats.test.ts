import { describe, it, expect, onTestFinished } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatStatsProfileSchema,
  combatBonusesSchema,
  combatStatsIssues,
  combatMoveSchema,
  gameRulesSchema,
  gameSchema,
  inputSchema,
  inventorySchema,
  levelingProfileSchema,
  sceneSchema,
  localizeInventory,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  MapStateTransactions,
  GameCombatStats,
  assembleGameData,
  combatMoveValues,
  resolveCombatRound,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject, validateProject, object } from '@ancadeba/editor-core'

const field = (key: string) => ({ source: 'game.state' as const, path: [key] })

const profile = combatStatsProfileSchema.parse({
  health: field('hp'),
  maximumHealth: field('max'),
  attack: field('power'),
  defense: 1,
  guard: 1,
})

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  owners: {
    player: {
      label: 'Player',
      equipmentSlots: { hand: 'Hand', body: 'Body' },
      combatStats: profile,
    },
    enemy: {
      label: 'Enemy',
      equipmentSlots: { body: 'Body' },
      combatStats: { health: field('enemy'), maximumHealth: 80, defense: 2 },
    },
    other: { label: 'Other', equipmentSlots: { hand: 'Hand', body: 'Body' } },
  },
  itemTypes: {
    sword: { label: '<b>Sword</b>', equipmentSlots: ['hand'], combatBonuses: { attack: 4 } },
    armor: {
      label: 'Armor',
      equipmentSlots: ['body'],
      combatBonuses: { defense: 3, guard: 2, maximumHealth: 10 },
    },
    strong: {
      label: 'Strong armor',
      equipmentSlots: ['body'],
      combatBonuses: { maximumHealth: 20 },
    },
    bag: { label: 'Bag', container: true, equipmentSlots: ['body'] },
  },
  items: {
    sword: { itemType: 'sword', placement: { type: 'carried', owner: 'player' } },
    armor: { itemType: 'armor', placement: { type: 'carried', owner: 'player' } },
    strong: { itemType: 'strong', placement: { type: 'carried', owner: 'player' } },
    bag: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
    other: { itemType: 'sword', placement: { type: 'carried', owner: 'other' } },
  },
})

const rules = gameRulesSchema.parse({
  state: Object.entries({ hp: 25, max: 30, power: 1, enemy: 80, enemy2: 80, xp: 0, level: 1 }).map(
    ([key, value]) => ({ path: [key], value }),
  ),
  actions: {},
})

const leveling = levelingProfileSchema.parse({
  'schema-version': '1.0.0',
  id: 'player',
  label: 'Player',
  xp: field('xp'),
  level: field('level'),
  health: { current: field('hp'), maximum: field('max'), policy: 'restore' },
  levels: [
    { xp: 0 },
    { xp: 5, gains: [{ id: 'hp', label: 'HP', field: field('max'), amount: 5 }] },
  ],
})

const combat = combatDefinitionSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  label: 'Fight',
  allowEscape: true,
  seed: 1024,
  player: {
    id: 'player',
    label: 'Player',
    equipmentOwner: 'player',
    leveling: 'player',
    health: field('hp'),
    maximumHealth: field('max'),
    moves: ['attack', 'guard'],
  },
  enemies: [
    {
      id: 'enemy',
      label: 'Enemy',
      equipmentOwner: 'enemy',
      health: field('enemy'),
      maximumHealth: 80,
      ap: 1,
      moves: ['attack'],
      rotation: ['attack'],
    },
  ],
  moves: {
    attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 6, max: 9 } },
    guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 3 },
  },
})

const second = combatDefinitionSchema.parse({
  ...combat,
  id: 'second',
  label: 'Second',
  enemies: [{ ...combat.enemies[0], equipmentOwner: undefined, health: field('enemy2') }],
})

const makeScene = (id: string, encounter?: string) =>
  sceneSchema.parse({
    'schema-version': '1.0.0',
    id,
    title: id,
    type: 'game',
    screen: { type: 'grid', grid: { rows: 12, columns: 12 } },
    components: [
      { id: 'items', type: 'inventory', owners: ['player'], placement: { row: 1, column: 1 } },
      {
        id: 'equipment',
        type: 'equipment',
        inventory: 'items',
        owner: 'player',
        showCombatStats: true,
        placement: { row: 1, column: 2 },
      },
      ...(encounter
        ? [{ id: 'combat', type: 'combat', encounter, placement: { row: 2, column: 1 } }]
        : []),
      {
        id: 'bar',
        type: 'action-bar',
        placement: { row: 10, column: 1 },
        slots: {
          '1': {
            label: 'Equip',
            action: { type: 'equipment-action', equipment: 'equipment', operation: 'equip' },
            inputBinding: { context: 'play', input: 'equip' },
          },
          '2': {
            label: 'Unequip',
            action: { type: 'equipment-action', equipment: 'equipment', operation: 'unequip' },
            inputBinding: { context: 'play', input: 'unequip' },
          },
        },
      },
    ],
  })

const scenes = new Map([
  ['home', makeScene('home')],
  ['fight', makeScene('fight', 'fight')],
  ['second', makeScene('second', 'second')],
])

const keys = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['equip', 'unequip'],
  keyboard: { KeyQ: 'equip', KeyW: 'unequip' },
  contexts: { play: { equip: 'equip', unequip: 'unequip' } },
  'initial-context': 'play',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'stats',
  title: 'Stats',
  version: '1',
  scenes: [...scenes.keys()],
  inventory: ['items'],
  combat: ['fight', 'second'],
  leveling: ['player'],
  rules: ['rules'],
  input: 'keys',
  'initial-scene': 'home',
})

async function setup(adapter = true, pendingRewards = false) {
  const data = assembleGameData(
    manifest,
    scenes,
    keys,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['rules', rules]]),
    new Map([
      [
        'fight',
        pendingRewards
          ? combatDefinitionSchema.parse({
              ...combat,
              rewards: {
                numeric: [
                  {
                    id: 'power',
                    label: 'Power',
                    field: field('power'),
                    amount: Number.MAX_SAFE_INTEGER,
                  },
                ],
              },
            })
          : combat,
      ],
      ['second', second],
    ]),
    new Map([['player', leveling]]),
  )

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      createGameLifecycle: (data) =>
        new GameLifecycle(data, {
          createGameState: () => new Map(rules.state.map((entry) => [entry.path[0]!, entry.value])),
          createSceneState: () => undefined,
        }),
      createStateTransactions: (game) =>
        adapter && game.state instanceof Map
          ? new MapStateTransactions(
              game.state,
              rules.state.map((entry) => entry.path),
            )
          : undefined,
    },
  )

  await engine.start()
  onTestFinished(() => engine.stop())
  const game = () => engine.lifecycle!.currentGame!
  const active = () => engine.lifecycle!.activeScene!

  const state = () => {
    const value = game().state

    if (!(value instanceof Map)) throw new Error('Expected fixture Map state')

    return value
  }

  const stats = () => {
    const value = game().combatStats

    if (!(value instanceof GameCombatStats)) throw new Error('Expected combat stats')

    return value
  }

  const flush = () => {
    for (let i = 0; i < 8; i++) engine.flushMessages()
  }

  const enter = (id: string) => engine.lifecycle!.enterScene(id)
  const snapshot = () => game().combat!.snapshot(active(), 'combat')!

  const command = (
    command: Parameters<NonNullable<ReturnType<typeof game>['combat']>['request']>[2],
  ) => {
    game().combat!.request(active(), 'combat', command)
    flush()
  }

  return { engine, game, active, state, stats, flush, enter, snapshot, command }
}

describe('combat equipment stats', () => {
  it('derives only directly equipped bonuses, preserves base values, and calculates replacement comparisons', async () => {
    const t = await setup(),
      inv = t.game().inventory!

    expect(t.stats().snapshot('player')!.total).toEqual({
      attack: 1,
      defense: 1,
      guard: 1,
      maximumHealth: 30,
    })
    inv.equip('bag', 'player', 'body')
    inv.move('armor', { type: 'inside', container: 'bag' })
    expect(t.stats().snapshot('player')!.equipment.maximumHealth).toBe(0)
    inv.equip('sword', 'player', 'hand')
    inv.equip('armor', 'player', 'body')
    const snapshot = t.stats().snapshot('player')!
    expect(snapshot.total).toEqual({ attack: 5, defense: 4, guard: 3, maximumHealth: 40 })
    expect(t.state().get('hp')).toBe(25)
    expect(t.state().get('max')).toBe(30)
    expect(Object.isFrozen(snapshot.total)).toBe(true)
    expect(t.stats().compare('player', 'strong', 'body')).toMatchObject({
      delta: { defense: -3, guard: -2, maximumHealth: 10 },
    })
    expect(t.stats().compare('player', 'armor')).toMatchObject({
      proposed: { total: { maximumHealth: 30 } },
    })
    expect(inv.equip('other', 'player', 'hand').status).toBe('rejected')
    expect(
      t.game().bindings!.read({ source: 'game.combatStats', path: ['player', 'maximumHealth'] }),
    ).toEqual({ status: 'resolved', value: 40 })
  })
  it('commits replacement and health clamping before any observer and keeps the result on observer failure', async () => {
    const t = await setup(),
      inv = t.game().inventory!

    inv.equip('strong', 'player', 'body')
    t.state().set('hp', 48)
    const snapshots: number[] = []

    const cleanup = inv.subscribeChanges(() => {
      snapshots.push(t.state().get('hp')!)
      expect(t.stats().snapshot('player')!.total.maximumHealth).toBe(40)
      throw new Error('observer')
    })

    expect(() => inv.equip('armor', 'player', 'body')).toThrow()
    cleanup()
    expect(snapshots).toEqual([40])
    expect(inv.snapshot.find((i) => i.id === 'strong')!.placement.type).toBe('carried')
    expect(inv.move('armor', { type: 'carried', owner: 'player' }).status).toBe('applied')
    expect(t.state().get('hp')).toBe(30)
    inv.equip('armor', 'player', 'body')
    expect(t.state().get('hp')).toBe(30)
    t.state().set('hp', 0)
    inv.move('armor', { type: 'carried', owner: 'player' })
    expect(t.state().get('hp')).toBe(0)
  })
  it('rejects unsupported clamps without changing inventory and discards stale staged transactions', async () => {
    const t = await setup(false),
      inv = t.game().inventory!

    inv.equip('strong', 'player', 'body')
    t.state().set('hp', 48)
    const before = inv.snapshot
    expect(inv.equip('armor', 'player', 'body').status).toBe('rejected')
    expect(inv.snapshot).toEqual(before)
    expect(t.state().get('hp')).toBe(48)

    const s = await setup(),
      owned = s.game().inventory!

    owned.equip('armor', 'player', 'body')
    s.state().set('hp', 40)
    const staged = owned.prepareTransfer!('armor', { type: 'carried', owner: 'player' })!
    s.enter('fight')
    s.snapshot()
    expect(staged.isCurrent()).toBe(false)
    staged.commit()
    staged.notify()
    expect(s.state().get('hp')).toBe(40)
    expect(owned.snapshot.find((i) => i.id === 'armor')!.placement.type).toBe('equipped')
  })
  it('locks every owner across pause and overlapping encounters, consumes held input, and releases after escape', async () => {
    const t = await setup(),
      inv = t.game().inventory!

    inv.equip('armor', 'player', 'body')
    t.enter('fight')
    expect(t.snapshot().issue).toBeUndefined()
    expect(t.stats().reason('enemy')).toContain('Fight')
    t.enter('home')
    expect(inv.checkMove('armor', { type: 'carried', owner: 'other' })).toContain('Fight')
    expect(
      inv.prepareTransfers!([{ item: 'armor', destination: { type: 'inside', container: 'bag' } }]),
    ).toBeUndefined()
    t.game().inventorySelection!.select(t.active(), 'items', 'armor')
    t.engine.input!.pressKey('KeyW')
    t.enter('second')
    expect(t.snapshot().issue).toContain('Fight')
    expect(t.game().combat!.canCommand(t.active(), 'combat', { type: 'end-turn' })).toBe(false)
    t.enter('fight')
    t.command({ type: 'escape' })
    t.command({ type: 'end-turn' })
    expect(t.snapshot().outcome).toBe('escaped')
    t.enter('home')
    t.engine.input!.releaseKey('KeyW')
    t.flush()
    expect(inv.snapshot.find((i) => i.id === 'armor')!.placement.type).toBe('equipped')
    expect(t.stats().reason('player')).toBeUndefined()
    t.game().inventorySelection!.select(t.active(), 'items', 'armor')
    t.engine.input!.pressKey('KeyW')
    t.engine.input!.releaseKey('KeyW')
    t.flush()
    expect(inv.snapshot.find((i) => i.id === 'armor')!.placement.type).toBe('carried')
    t.enter('second')
    expect(t.snapshot().issue).toBeUndefined()
    t.engine.lifecycle!.startGame()
    expect(t.game().combatStats!.snapshot('player')!.lockedBy).toBeUndefined()
  })
  it('invalidates queued combat and equipment requests on relevant stat changes, without altering existing plans', async () => {
    const t = await setup()
    t.game().inventorySelection!.select(t.active(), 'items', 'sword')
    t.engine.input!.pressKey('KeyQ')
    t.state().set('power', 2)
    t.flush()
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.game().inventory!.snapshot.find((i) => i.id === 'sword')!.placement.type).toBe(
      'carried',
    )
    t.enter('fight')
    t.game().combat!.selectTarget(t.active(), 'combat', 'enemy')
    t.command({ type: 'queue-move', move: 'attack' })
    const before = t.snapshot()
    t.game().combat!.request(t.active(), 'combat', { type: 'end-turn' })
    t.state().set('power', 3)
    t.flush()
    expect(t.snapshot().round).toBe(before.round)
    expect(t.snapshot().plan).toEqual(before.plan)
    expect(t.snapshot().enemyPlans).toEqual(before.enemyPlans)
    t.command({ type: 'end-turn' })
    expect(t.snapshot().round).toBe(2)
  })
  it('applies level recovery to the effective maximum without adding equipment to base fields', async () => {
    const t = await setup()
    t.game().inventory!.equip('armor', 'player', 'body')
    t.state().set('hp', 39)
    expect(t.game().leveling!.snapshot('player')!.available).toBe(true)
    expect(t.game().leveling!.grantXp('player', 5).status).toBe('applied')
    expect(t.state().get('max')).toBe(35)
    expect(t.state().get('hp')).toBe(45)
    expect(t.stats().snapshot('player')!.total.maximumHealth).toBe(45)
    t.game().inventory!.move('armor', { type: 'carried', owner: 'player' })
    expect(t.state().get('hp')).toBe(35)
  })
  it('releases loadouts after victory with pending rewards and after defeat, even when observers fail', async () => {
    const winner = await setup(true, true)
    winner.game().inventory!.equip('sword', 'player', 'hand')
    winner.state().set('enemy', 1)
    winner.enter('fight')
    winner.game().combat!.selectTarget(winner.active(), 'combat', 'enemy')
    winner.command({ type: 'queue-move', move: 'attack' })

    const unsubscribe = winner.game().bindings!.subscribeChanges(() => {
      throw new Error('observer')
    })

    winner.game().combat!.request(winner.active(), 'combat', { type: 'end-turn' })

    try {
      winner.flush()
    } catch {
      /* Observer failures retain the complete commit. */
    }

    unsubscribe()
    expect(winner.snapshot().outcome).toBe('victory')
    expect(winner.game().combatRewards!.snapshot(winner.active(), 'combat')!.delivered).toBe(false)
    expect(winner.stats().reason('player')).toBeUndefined()
    expect(
      winner.game().inventory!.move('sword', { type: 'carried', owner: 'player' }).status,
    ).toBe('applied')
    const loser = await setup()
    loser.state().set('hp', 1)
    loser.enter('fight')
    loser.command({ type: 'end-turn' })
    expect(loser.snapshot().outcome).toBe('defeat')
    expect(loser.stats().reason('player')).toBeUndefined()
  })
  it('rejects state writes whose effective totals overflow and rejects invalid runtime inputs', async () => {
    const t = await setup()
    t.game().inventory!.equip('sword', 'player', 'hand')
    expect(
      t.stats().prepareState([{ path: ['power'], expected: 1, value: Number.MAX_SAFE_INTEGER }]),
    ).toBeUndefined()
    expect(t.state().get('power')).toBe(1)
    t.state().set('power', -1)
    expect(t.stats().snapshot('player')).toBeUndefined()
    expect(t.game().inventory!.equip('armor', 'player', 'body').status).toBe('rejected')
    t.state().set('power', 1)
    t.state().set('hp', 100)
    expect(t.stats().snapshot('player')).toBeUndefined()
  })
  it('shares preview calculations with resolution, applies defense before Guard, and preserves RNG draw count', () => {
    const totals = { attack: 4, defense: 3, guard: 2, maximumHealth: 80 }
    expect(combatMoveValues(combat.moves.attack!, totals, 2)).toEqual({ min: 8, max: 11 })
    expect(combatMoveValues(combat.moves.guard!, totals)).toEqual({ guard: 5 })

    const current = {
      health: { player: 80, enemy: 80 },
      guard: {},
      seed: 1024,
      plan: [{ move: 'guard', target: 'player' }],
      enemies: { enemy: { cursor: 0, moves: [{ move: 'attack', target: 'player' }] } },
      escape: false,
    }

    const plain = resolveCombatRound(combat, current)

    const equipped = resolveCombatRound(combat, {
      ...current,
      stats: { player: totals, enemy: { ...totals, attack: 0, defense: 0 } },
    })

    expect(equipped.seed).toBe(plain.seed)
    const hit = equipped.entries.find((e) => e.type === 'attack')!
    expect(hit.defended).toBe(3)
    expect(hit.blocked).toBeGreaterThan(0)
    expect(equipped.entries[0]!.guard).toBe(5)
    expect(equipped.health.player).toBe(80 - hit.damage!)

    const invulnerable = resolveCombatRound(combat, {
      ...current,
      stats: { player: { ...totals, defense: 100 } },
    })

    expect(invulnerable.entries.find((e) => e.type === 'attack')).toMatchObject({
      damage: 0,
      blocked: 0,
    })
    expect(() =>
      combatMoveValues(combat.moves.attack!, { ...totals, attack: Number.MAX_SAFE_INTEGER }),
    ).toThrow()
  })
  it('rejects invalid bonuses, overflow, health aliases, and dangling derived bindings', () => {
    expect(combatBonusesSchema.safeParse({ attack: -1 }).success).toBe(false)
    expect(combatBonusesSchema.safeParse({ guard: 0.5 }).success).toBe(false)

    const broken = inventorySchema.parse({
      ...inventory,
      owners: {
        ...inventory.owners,
        player: { ...inventory.owners.player, combatStats: { ...profile, attack: field('hp') } },
      },
    })

    expect(
      combatStatsIssues(broken, rules, new Map()).some((i) => i.message.includes('current health')),
    ).toBe(true)
    expect(
      combatStatsIssues(inventory, rules, new Map(), [
        { source: 'game.combatStats', path: ['player', 'typo'] },
      ]),
    ).toHaveLength(1)

    const overflow = inventorySchema.parse({
      ...inventory,
      owners: {
        ...inventory.owners,
        player: {
          ...inventory.owners.player,
          combatStats: { ...profile, maximumHealth: Number.MAX_SAFE_INTEGER },
        },
      },
      items: {
        ...inventory.items,
        armor: {
          ...inventory.items.armor,
          placement: { type: 'equipped', owner: 'player', slot: 'body' },
        },
      },
    })

    expect(
      combatStatsIssues(overflow, rules, new Map()).some((i) => i.message.includes('overflow')),
    ).toBe(true)
    expect(
      combatMoveSchema.safeParse({
        type: 'attack',
        label: 'A',
        apCost: 1,
        damage: { min: 0, max: 1 },
      }).success,
    ).toBe(true)
  })
  it('preserves editor extensions, protects references, and localizes stat labels and lock reasons', () => {
    const documents = {
      'game.json': manifest,
      'input/keys.json': keys,
      'inventory/items.json': {
        ...inventory,
        owners: {
          ...inventory.owners,
          player: {
            ...inventory.owners.player,
            combatStats: {
              ...profile,
              extension: 'keep',
              health: { ...profile.health, extension: 7 },
            },
          },
        },
      },
      'rules/rules.json': rules,
      'leveling/player.json': leveling,
      'combat/fight.json': combat,
      'combat/second.json': second,
      ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
    }

    expect(validateProject(documents)).toEqual([])
    const project = { revision: 'r1', documents, sourceDiagnostics: [] }
    expect(inspectProject(project).diagnostics).toEqual([])

    const updated = applyCommand(project, {
      type: 'inventory.setEquipmentSlots',
      owner: 'player',
      slots: { hand: 'Hand', body: 'Body' },
      combatStats: { ...profile, defense: 4 },
    })

    expect(
      object(object(object(updated.project.documents['inventory/items.json']).owners).player)
        .combatStats,
    ).toMatchObject({ extension: 'keep', defense: 4, health: { extension: 7 } })
    expect(() =>
      applyCommand(project, {
        type: 'inventory.setEquipmentSlots',
        owner: 'player',
        slots: { hand: 'Hand', body: 'Body' },
        combatStats: null,
      }),
    ).toThrow()

    const localized = localizeInventory(
      inventorySchema.parse({
        ...inventory,
        owners: {
          ...inventory.owners,
          player: {
            ...inventory.owners.player,
            combatStats: { ...profile, messageKeys: { locked: 'lock' } },
          },
        },
      }),
      { fallback: { lock: 'Locked: {encounter}' }, messages: { lock: 'Vergrendeld: {encounter}' } },
    )

    expect(localized.owners.player!.combatStats!.messages.locked).toBe('Vergrendeld: {encounter}')
  })
})
