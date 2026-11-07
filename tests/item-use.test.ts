import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import {
  combatLibrarySchema,
  combatSourceSchema,
  gameSchema,
  gameRulesSchema,
  inventorySchema,
  inputSchema,
  sceneSchema,
  resolveCombatSource,
  itemUseIssues,
  localizeInventory,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  assembleGameData,
  MapStateTransactions,
  resolveCombatRound,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject, object, validateProject } from '@ancadeba/editor-core'

const field = (id: string) => ({ source: 'game.state' as const, path: [id] })

const library = combatLibrarySchema.parse({
  'schema-version': '1.0.0',
  id: 'items',
  moves: {
    heal: {
      type: 'ability',
      label: 'Recover',
      target: 'self',
      apCost: 1,
      cooldown: 1,
      effects: [{ id: 'heal', type: 'heal', amount: 10 }],
    },
    cleanse: {
      type: 'ability',
      label: 'Antidote',
      target: 'self',
      apCost: 1,
      effects: [{ id: 'cure', type: 'remove-status', status: 'poison' }],
    },
    bomb: {
      type: 'ability',
      label: 'Flame',
      target: 'enemy',
      apCost: 1,
      effects: [{ id: 'damage', type: 'damage', damage: { min: 5, max: 8 } }],
    },
    poison: {
      type: 'ability',
      label: 'Poison',
      target: 'enemy',
      apCost: 1,
      effects: [{ id: 'poison', type: 'apply-status', status: 'poison' }],
    },
    stun: {
      type: 'ability',
      label: 'Stun',
      target: 'enemy',
      apCost: 1,
      effects: [{ id: 'stun', type: 'apply-status', status: 'stun' }],
    },
    zero: {
      type: 'ability',
      label: 'Empty',
      target: 'self',
      apCost: 1,
      effects: [{ id: 'heal', type: 'heal', amount: 0 }],
    },
    quick: {
      type: 'ability',
      label: 'Quick heal',
      target: 'self',
      apCost: 1,
      effects: [{ id: 'heal', type: 'heal', amount: 40 }],
    },
  },
  statuses: {
    poison: { type: 'damage', label: 'Poison', duration: 3, amount: 2 },
    stun: { type: 'stun', label: 'Stun', duration: 1 },
  },
})

const use = (ability: string, consumption: 'consume' | 'keep' = 'consume', outside = true) => ({
  ability: { library: 'items', id: ability },
  consumption,
  contexts: outside ? ['combat', 'outside-combat'] : ['combat'],
})

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  owners: {
    player: {
      label: 'Player',
      equipmentSlots: { hand: 'Hand' },
      combatStats: { health: field('hp'), maximumHealth: 40 },
    },
    other: { label: 'Other' },
  },
  itemTypes: {
    bag: { label: 'Bag', container: true },
    potion: { label: '<Potion>', use: { ...use('heal'), enabledWhen: field('enabled') } },
    rune: { label: 'Healing rune', use: use('heal', 'keep') },
    antidote: { label: 'Antidote', use: use('cleanse', 'consume', false) },
    scroll: { label: 'Flame scroll', use: use('bomb', 'consume', false) },
    zero: { label: 'Empty potion', use: use('zero') },
    quick: { label: 'Quick potion', use: use('quick'), equipmentSlots: ['hand'] },
  },
  items: {
    bag: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
    potion: { itemType: 'potion', placement: { type: 'inside', container: 'bag' } },
    potion2: { itemType: 'potion', placement: { type: 'carried', owner: 'player' } },
    rune: { itemType: 'rune', placement: { type: 'carried', owner: 'player' } },
    rune2: { itemType: 'rune', placement: { type: 'carried', owner: 'player' } },
    antidote: { itemType: 'antidote', placement: { type: 'carried', owner: 'player' } },
    scroll: { itemType: 'scroll', placement: { type: 'carried', owner: 'player' } },
    zero: { itemType: 'zero', placement: { type: 'carried', owner: 'player' } },
    quick: { itemType: 'quick', placement: { type: 'carried', owner: 'player' } },
    stolen: { itemType: 'potion', placement: { type: 'carried', owner: 'other' } },
  },
})

const rules = gameRulesSchema.parse({
  state: [
    { path: ['hp'], value: 20 },
    { path: ['enemy'], value: 80 },
    { path: ['second'], value: 80 },
    { path: ['enabled'], value: true },
  ],
  actions: {},
})

const encounter = combatSourceSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  label: 'Fight',
  allowEscape: true,
  seed: 1024,
  player: {
    id: 'player',
    label: 'Player',
    health: field('hp'),
    maximumHealth: 40,
    equipmentOwner: 'player',
    moves: ['attack', 'heal'],
  },
  enemies: ['enemy', 'second'].map((id) => ({
    id,
    label: id,
    health: field(id),
    maximumHealth: 80,
    moves: ['attack', 'guard', 'poison', 'stun'],
    rotation: ['guard'],
  })),
  moves: {
    attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 2, max: 2 } },
    guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 2 },
  },
  sharedMoves: [
    { library: 'items', id: 'heal' },
    { library: 'items', id: 'poison' },
    { library: 'items', id: 'stun' },
  ],
  itemUse: {
    owner: 'player',
    itemTypes: ['potion', 'rune', 'antidote', 'scroll', 'zero', 'quick'],
  },
})

const panel = {
  id: 'bag',
  type: 'inventory',
  label: 'Inventory',
  owners: ['player', 'other'],
  descriptionTarget: 'text',
  placement: { row: 1, column: 4 },
}

const scene = (id: string, fight: boolean) =>
  sceneSchema.parse({
    'schema-version': '1.0.0',
    id,
    title: id,
    type: 'game',
    screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
    components: [
      panel,
      { id: 'text', type: 'text', text: 'Narrative', placement: { row: 1, column: 1 } },
      ...(fight
        ? [{ id: 'combat', type: 'combat', encounter: 'fight', placement: { row: 1, column: 1 } }]
        : []),
      {
        id: 'bar',
        type: 'action-bar',
        placement: { row: 5, column: 1 },
        slots: {
          '1': {
            label: 'Use',
            action: { type: 'item-use', inventory: 'bag', ...(fight ? { combat: 'combat' } : {}) },
            inputBinding: { context: 'play', input: 'use' },
          },
          ...(fight
            ? {
                '15': {
                  label: 'End',
                  action: {
                    type: 'combat-action',
                    combat: 'combat',
                    command: { type: 'end-turn' },
                  },
                  inputBinding: { context: 'play', input: 'end' },
                },
              }
            : {}),
        },
      },
    ],
  })

const scenes = new Map([
  ['home', scene('home', false)],
  ['fight', scene('fight', true)],
])

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'items',
  title: 'Items',
  version: '1',
  scenes: ['home', 'fight'],
  'initial-scene': 'home',
  inventory: ['items'],
  combat: ['fight'],
  combatLibraries: ['items'],
  rules: ['state'],
  input: 'keys',
})

const keys = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['use', 'end'],
  keyboard: { KeyQ: 'use', KeyB: 'end' },
  contexts: { play: { use: 'use', end: 'end' } },
  'initial-context': 'play',
})

async function setup(
  options: { enemy?: 'guard' | 'poison' | 'stun'; readonly?: boolean; fail?: boolean } = {},
) {
  const fight = {
    ...encounter,
    enemies: encounter.enemies.map((enemy) => ({ ...enemy, rotation: [options.enemy ?? 'guard'] })),
  }

  const mapped = new Map(
    [...scenes].map(([id, scene]) => [
      id,
      sceneSchema.parse({
        ...scene,
        components: scene.components.map((entry) =>
          entry.type === 'inventory' ? { ...entry, readOnly: options.readonly ?? false } : entry,
        ),
      }),
    ]),
  )

  const data = assembleGameData(
    manifest,
    mapped,
    keys,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['state', rules]]),
    new Map([['fight', fight]]),
    new Map(),
    new Map([['items', library]]),
  )

  let fail = false
  const logger = { debug: () => '', info: () => '', warn: () => '', error: vi.fn(() => '') }

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      ...(options.fail
        ? {
            createGameRules: () => ({ handlers: new Map() }),
            createGameLifecycle: (data) =>
              new GameLifecycle(data, {
                createGameState: () =>
                  new Map(rules.state.map((field) => [field.path[0]!, field.value])),
                createSceneState: () => undefined,
              }),
            createStateTransactions: (game) => {
              if (!(game.state instanceof Map)) throw new Error('Expected Map')

              const adapter = new MapStateTransactions(
                game.state,
                rules.state
                  .filter((field) => typeof field.value === 'number')
                  .map((field) => field.path),
              )

              return {
                prepare: (writes) =>
                  fail && writes.some((write) => write.value !== write.expected)
                    ? undefined
                    : adapter.prepare(writes),
              }
            },
          }
        : {}),
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const lifecycle = engine.lifecycle!
  lifecycle.startGame()
  lifecycle.enterScene('home')
  const game = () => lifecycle.currentGame!
  const active = () => lifecycle.activeScene!

  const flush = () => {
    for (let i = 0; i < 8; i++) engine.flushMessages()
  }

  const select = (id: string) => game().inventorySelection!.select(active(), 'bag', id)

  const activate = () => {
    game().actionBar!.activate(active(), 'bar', '1')
    flush()
  }

  const command = (type: 'end-turn' | 'undo' | 'clear' | 'escape') => {
    game().combat!.request(active(), 'combat', { type })
    flush()
  }

  const snapshot = () => game().combat!.snapshot(active(), 'combat')!

  const set = (key: string, value: number | boolean) => {
    const state = game().state

    if (!(state instanceof Map)) throw new Error('Expected Map')
    state.set(key, value)
  }

  const enter = () => {
    lifecycle.enterScene('fight')
    game().combat!.selectTarget(active(), 'combat', 'enemy')
  }

  return {
    engine,
    lifecycle,
    game,
    active,
    flush,
    select,
    activate,
    command,
    snapshot,
    set,
    enter,
    logger,
    fail: (value = true) => {
      fail = value
    },
  }
}

describe('usable items outside combat', () => {
  it('atomically heals from a nested finite instance and clears its selection', async () => {
    const t = await setup()
    t.select('potion')
    expect(t.game().itemUse!.reason(t.active(), 'bag')).toBeUndefined()
    expect(t.game().itemUse!.details(t.active(), 'bag')).toContain('Recover')
    const observed: unknown[] = []
    t.game().inventory!.subscribeChanges(() =>
      observed.push([
        t.game().combatStats!.snapshot('player')!.health,
        t.game().inventory!.snapshot.some((item) => item.id === 'potion'),
      ]),
    )
    t.activate()
    expect(observed).toEqual([[30, false]])
    expect(t.game().inventorySelection!.get(t.active(), 'bag')).toBeUndefined()
    expect(t.game().itemUse!.feedback(t.active(), 'bag')).toBe('Used <Potion>: restored 10 health.')
    expect(t.game().inventory!.snapshot.find((item) => item.id === 'potion2')).toBeDefined()
    expect(t.game().actions!.progression.turn).toBe(0)
  })
  it('keeps reusable items selected, clamps healing, and rejects full-health or zero-effect use', async () => {
    const t = await setup()
    t.set('hp', 35)
    t.select('rune')
    t.activate()
    expect(t.game().combatStats!.snapshot('player')!.health).toBe(40)
    expect(t.game().inventorySelection!.get(t.active(), 'bag')?.item).toBe('rune')
    expect(t.game().itemUse!.reason(t.active(), 'bag')).toContain('no effect')
    t.set('hp', 20)
    t.select('zero')
    expect(t.game().itemUse!.reason(t.active(), 'bag')).toContain('no effect')
    t.activate()
    expect(t.game().inventory!.snapshot.find((item) => item.id === 'zero')).toBeDefined()
  })
  it('rejects read-only panels, disabled bindings, equipped items and combat-only abilities', async () => {
    const locked = await setup({ readonly: true })
    locked.select('potion')
    expect(locked.game().itemUse!.reason(locked.active(), 'bag')).toContain('read only')
    const t = await setup()
    t.select('potion')
    t.set('enabled', false)
    expect(t.game().itemUse!.reason(t.active(), 'bag')).toContain('right now')
    t.select('scroll')
    expect(t.game().itemUse!.reason(t.active(), 'bag')).toContain('context')
    t.game().inventory!.equip('quick', 'player', 'hand')
    t.select('quick')
    expect(t.game().itemUse!.reason(t.active(), 'bag')).toContain('Unequip')
  })
  it('retains the committed result when observers fail and does not consume twice', async () => {
    const t = await setup()
    t.select('potion')
    t.game().inventory!.subscribeChanges(() => {
      throw new Error('Observer failure')
    })
    expect(() => t.activate()).toThrow(AggregateError)
    t.flush()
    expect(t.game().combatStats!.snapshot('player')!.health).toBe(30)
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'potion')).toBe(false)
  })
})

describe('combat item planning', () => {
  it.each(['stun', 'poison', 'dead-target', 'victory'] as const)(
    'does not execute item uses skipped by %s',
    (reason) => {
      const definition = resolveCombatSource(
        encounter,
        new Map([['items', library]]),
        undefined,
        inventory,
      ).definition!

      const queued = {
        move: reason === 'dead-target' ? 'bomb' : 'heal',
        target: reason === 'dead-target' ? 'enemy' : 'player',
        item: 'potion',
        itemType: 'potion',
        consume: true,
      }

      const result = resolveCombatRound(definition, {
        health: {
          player: reason === 'poison' ? 1 : 20,
          enemy: reason === 'dead-target' ? 0 : reason === 'victory' ? 1 : 80,
          second: reason === 'victory' ? 0 : 80,
        },
        maximumHealth: { player: 40, enemy: 80, second: 80 },
        guard: {},
        seed: 1024,
        plan: reason === 'victory' ? [{ move: 'attack', target: 'enemy' }, queued] : [queued],
        enemies: { enemy: { cursor: 0, moves: [] }, second: { cursor: 0, moves: [] } },
        escape: false,
        statuses:
          reason === 'stun' || reason === 'poison'
            ? { player: [{ id: reason, remaining: 1, source: 'enemy' }] }
            : {},
      })

      expect(result.usedItems).toEqual([])
      expect(result.cooldowns.player?.heal).toBeUndefined()
    },
  )
  it('queues exact instances, locks their ancestors, and releases reservations through Undo and Clear', async () => {
    const t = await setup()
    t.enter()
    t.select('potion')
    t.activate()
    expect(t.snapshot().plan[0]).toMatchObject({ move: 'heal', item: 'potion', target: 'player' })
    expect(t.snapshot().remainingAp).toBe(2)
    expect(t.game().inventory!.isReserved!('potion')).toBe(true)
    expect(t.game().inventory!.move('bag', { type: 'carried', owner: 'other' }).status).toBe(
      'rejected',
    )
    expect(
      t.game().inventory!.prepareTransfer!('potion', { type: 'carried', owner: 'other' }),
    ).toBeUndefined()
    expect(t.game().inventory!.prepareRemove!(['potion'])).toBeUndefined()
    t.activate()
    expect(t.snapshot().plan).toHaveLength(1)
    t.command('undo')
    expect(t.game().inventory!.isReserved!('potion')).toBe(false)
    t.activate()
    t.command('clear')
    expect(t.snapshot().remainingAp).toBe(3)
    expect(t.game().inventory!.isReserved!('potion')).toBe(false)
  })
  it('shares cooldown reservations with other copies and learned uses, starting cooldown only on execution', async () => {
    const t = await setup()
    t.enter()
    t.select('rune')
    t.activate()
    t.select('rune2')
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '1')).toBe(false)
    expect(
      t.game().combat!.canCommand(t.active(), 'combat', { type: 'queue-move', move: 'heal' }),
    ).toBe(false)
    t.command('undo')
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '1')).toBe(true)
    t.activate()
    t.command('end-turn')
    expect(t.snapshot().cooldowns.player?.heal).toBe(3)
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'rune2')).toBe(true)
    t.command('end-turn')
    expect(t.snapshot().round).toBe(3)
    expect(
      t.game().combat!.canCommand(t.active(), 'combat', { type: 'queue-move', move: 'heal' }),
    ).toBe(true)
  })
  it('commits a rapid keyboard Use then End Turn in order and consumes only the executed instance', async () => {
    const t = await setup()
    t.enter()
    t.select('scroll')
    t.engine.input!.pressKey('KeyQ')
    t.engine.input!.releaseKey('KeyQ')
    t.engine.input!.pressKey('KeyB')
    t.engine.input!.releaseKey('KeyB')
    t.flush()
    expect(t.snapshot().round).toBe(2)
    expect(t.snapshot().health.enemy).toBeLessThan(80)
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'scroll')).toBe(false)
    expect(t.game().combat!.text(t.active(), 'combat')).toContain('uses Flame scroll')
  })
  it('pauses reservations and blocks outside healing until returning to the same encounter', async () => {
    const t = await setup()
    t.enter()
    t.select('potion')
    t.activate()
    const plan = t.snapshot().plan
    t.lifecycle.enterScene('home')
    t.select('rune')
    expect(t.game().itemUse!.reason(t.active(), 'bag')).toContain('unfinished encounter')
    expect(t.game().inventory!.isReserved!('potion')).toBe(true)
    t.enter()
    expect(t.snapshot().plan).toEqual(plan)
    t.command('end-turn')
    expect(t.game().inventory!.isReserved!('potion')).toBe(false)
  })
  it('keeps items when earlier healing makes their use ineffective', async () => {
    const t = await setup()
    t.enter()
    t.select('quick')
    t.activate()
    t.select('potion')
    t.activate()
    t.command('end-turn')
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'quick')).toBe(false)
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'potion')).toBe(true)
    expect(t.snapshot().cooldowns.player?.heal).toBeUndefined()
    expect(t.snapshot().log.some((entry) => entry.type === 'itemSkipped')).toBe(true)
  })
  it('does not consume or cool down a plan skipped by stun', async () => {
    const t = await setup({ enemy: 'stun' })
    t.enter()
    t.command('end-turn')
    t.select('potion')
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '1')).toBe(false)
    t.command('end-turn')
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'potion')).toBe(true)
  })
  it('cures an existing combat status but disables an ineffective antidote', async () => {
    const t = await setup({ enemy: 'poison' })
    t.enter()
    t.select('antidote')
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '1')).toBe(false)
    t.command('end-turn')
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '1')).toBe(true)
    t.activate()
    t.command('end-turn')
    expect(t.snapshot().log.some((entry) => entry.type === 'statusRemoved')).toBe(true)
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'antidote')).toBe(false)
  })
  it('rolls back failed commits, retaining the item, plan, reservations, and RNG outcome', async () => {
    const t = await setup({ fail: true })
    t.enter()
    t.select('scroll')
    t.activate()
    const before = t.snapshot()
    t.fail()
    t.command('end-turn')
    expect(t.snapshot().round).toBe(before.round)
    expect(t.snapshot().health).toEqual(before.health)
    expect(t.snapshot().plan).toEqual(before.plan)
    expect(t.game().inventory!.isReserved!('scroll')).toBe(true)
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'scroll')).toBe(true)
    t.fail(false)
    t.command('end-turn')
    const control = await setup()
    control.enter()
    control.select('scroll')
    control.activate()
    control.command('end-turn')
    expect(t.snapshot().health).toEqual(control.snapshot().health)
    expect(t.snapshot().log).toEqual(control.snapshot().log)
  })
  it('rejects stale selections, targets, ownership, scenes and held input', async () => {
    const t = await setup()
    t.enter()
    t.select('scroll')
    t.engine.input!.pressKey('KeyQ')
    t.game().combat!.selectTarget(t.active(), 'combat', 'second')
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.snapshot().plan).toEqual([])
    t.engine.input!.pressKey('KeyQ')
    t.select('potion')
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.snapshot().plan).toEqual([])
    t.engine.input!.pressKey('KeyQ')
    t.lifecycle.enterScene('home')
    t.select('potion')
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'potion')).toBe(true)
    t.enter()
    t.select('stolen')
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '1')).toBe(false)
  })
  it('invalidates a captured nested item when its containing bag moves away and back', async () => {
    const t = await setup()
    t.select('potion')
    t.engine.input!.pressKey('KeyQ')
    t.game().inventory!.move('bag', { type: 'carried', owner: 'other' })
    t.game().inventory!.move('bag', { type: 'carried', owner: 'player' })
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.game().combatStats!.snapshot('player')!.health).toBe(20)
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'potion')).toBe(true)
    t.enter()
    t.select('potion')

    const capture = t.game().combat!.capture(t.active(), 'combat', {
      type: 'queue-item',
      item: 'potion',
      inventory: 'bag',
    })

    t.game().inventory!.move('bag', { type: 'carried', owner: 'other' })
    t.game().inventory!.move('bag', { type: 'carried', owner: 'player' })
    t.game().combat!.request(
      t.active(),
      'combat',
      { type: 'queue-item', item: 'potion', inventory: 'bag' },
      capture,
    )
    t.flush()
    expect(t.snapshot().plan).toEqual([])
  })
  it('does not activate a press captured while a no-cooldown item was reserved', async () => {
    const t = await setup()
    t.enter()
    t.select('scroll')
    t.activate()
    t.game().combat!.request(t.active(), 'combat', { type: 'undo' })
    t.engine.input!.pressKey('KeyQ')
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.snapshot().plan).toEqual([])
    expect(t.game().inventory!.isReserved!('scroll')).toBe(false)
  })
  it('releases reservations on escape and resets consumption and cooldowns on New Game', async () => {
    const t = await setup()
    t.enter()
    t.select('potion')
    t.activate()
    t.command('escape')
    expect(t.game().inventory!.isReserved!('potion')).toBe(false)
    t.command('end-turn')
    expect(t.snapshot().outcome).toBe('escaped')
    t.lifecycle.startGame()
    t.enter()
    t.select('potion')
    t.activate()
    t.command('end-turn')
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'potion')).toBe(false)
    t.lifecycle.startGame()
    t.enter()
    expect(t.game().inventory!.snapshot.some((item) => item.id === 'potion')).toBe(true)
    expect(t.snapshot().cooldowns).toEqual({})
  })
})

describe('usable item authoring and resolution', () => {
  const documents = () => ({
    'game.json': manifest,
    'rules/state.json': rules,
    'input/keys.json': keys,
    'inventory/items.json': inventory,
    'combat/fight.json': encounter,
    'combat-libraries/items.json': library,
    ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
  })

  it('imports item-only abilities and statuses without adding learned moves or flattening source', () => {
    const project = { revision: 'one', documents: documents() }
    const view = inspectProject(project)
    expect(view.diagnostics).toEqual([])
    expect(view.combat!.fight!.moves.bomb).toBeDefined()
    expect(view.combat!.fight!.player.moves).not.toContain('bomb')

    const result = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: view.combatSources!.fight!,
    })

    expect(object(result.project.documents['combat/fight.json']).moves).not.toHaveProperty('bomb')
    expect(view.combatOrigins!.fight!.moves.bomb!.library).toBe('items')
  })
  it('protects referenced abilities, owners, types, boolean fields and context compatibility', () => {
    const project = { revision: 'one', documents: documents() }
    expect(() =>
      applyCommand(project, { type: 'game.removeCombatLibrary', libraryId: 'items' }),
    ).toThrow()
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombatLibrary',
        library: {
          ...library,
          moves: {
            ...library.moves,
            bomb: {
              ...library.moves.bomb!,
              type: 'guard',
              label: 'Guard',
              description: '',
              apCost: 1,
              guard: 2,
            },
          },
        },
      }),
    ).toThrow()
    expect(
      itemUseIssues(
        inventorySchema.parse({
          ...inventory,
          itemTypes: {
            ...inventory.itemTypes,
            scroll: { ...inventory.itemTypes.scroll, use: use('bomb') },
          },
        }),
        new Map([['items', library]]),
        rules,
      ).some((issue) => issue.message.includes('healing-only')),
    ).toBe(true)
    expect(
      resolveCombatSource(
        { ...encounter, moves: { ...encounter.moves, bomb: library.moves.bomb! } },
        new Map([['items', library]]),
        undefined,
        inventory,
      ).issues.some((issue) => issue.message.includes('conflicts')),
    ).toBe(true)
    expect(
      validateProject({
        ...documents(),
        'rules/state.json': {
          ...rules,
          state: rules.state.filter((field) => field.path[0] !== 'enabled'),
        },
      }).some((issue) => issue.code === 'invalid_item_use'),
    ).toBe(true)
  })
  it('preserves use extensions and supports localization without replacing item state', () => {
    const previous = inventory.itemTypes.potion!

    const project = {
      revision: 'one',
      documents: {
        ...documents(),
        'inventory/items.json': {
          ...inventory,
          itemTypes: {
            ...inventory.itemTypes,
            potion: {
              ...previous,
              use: {
                ...previous.use,
                extension: 'use',
                ability: { ...previous.use!.ability, extension: 'ref' },
              },
            },
          },
        },
      },
    }

    const result = applyCommand(project, {
      type: 'inventory.setItemPresentation',
      itemType: 'potion',
      presentation: previous,
      use: previous.use!,
    })

    expect(
      object(object(result.project.documents['inventory/items.json']).itemTypes).potion,
    ).toMatchObject({ use: { extension: 'use', ability: { extension: 'ref' } } })

    const localized = localizeInventory(
      inventorySchema.parse({
        ...inventory,
        itemTypes: {
          ...inventory.itemTypes,
          potion: { ...previous, use: { ...previous.use, messageKeys: { used: 'used' } } },
        },
      }),
      { fallback: { used: 'Used {item}' }, messages: { used: 'Gebruikt {item}' } },
    )

    expect(localized.itemTypes.potion!.use!.messages.used).toBe('Gebruikt {item}')
    expect(localized.items).toEqual(inventory.items)
  })
})
