import { describe, it, expect, vi, onTestFinished } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatComponentSchema,
  gameSchema,
  sceneSchema,
  gameRulesSchema,
  inventorySchema,
  inputSchema,
  rewardItemId,
  localizeCombat,
} from '@ancadeba/schemas'
import {
  Engine,
  GameInventory,
  MapStateTransactions,
  assembleGameData,
  GameLifecycle,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, validateProject } from '@ancadeba/editor-core'

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  owners: { player: { label: 'Player' }, loot: { label: 'Loot' }, merchant: { label: 'Merchant' } },
  itemTypes: {
    token: { label: '<b>Token</b>', description: 'A prize' },
    bag: { label: 'Bag', container: true },
  },
  items: {},
})

const rules = gameRulesSchema.parse({
  state: [
    { path: ['health'], value: 30 },
    { path: ['enemy'], value: 10 },
    { path: ['gold'], value: 10 },
    { path: ['xp'], value: 0 },
  ],
  actions: {},
})

const encounter = combatDefinitionSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  label: 'Fight',
  seed: 1024,
  allowEscape: true,
  outcomes: { victory: 'other', escaped: 'other' },
  player: {
    id: 'player',
    label: 'Player',
    health: { source: 'game.state', path: ['health'] },
    maximumHealth: 30,
    ap: 3,
    moves: ['attack', 'guard'],
  },
  enemies: [
    {
      id: 'enemy',
      label: 'Enemy',
      health: { source: 'game.state', path: ['enemy'] },
      maximumHealth: 10,
      ap: 1,
      moves: ['nudge'],
      rotation: ['nudge'],
    },
  ],
  moves: {
    attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 10, max: 10 } },
    nudge: { type: 'attack', label: 'Nudge', apCost: 1, damage: { min: 0, max: 0 } },
    guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 1 },
  },
  rewards: {
    recipient: 'player',
    lootOwner: 'loot',
    numeric: [
      { id: 'gold', label: 'Gold', field: { source: 'game.state', path: ['gold'] }, amount: 7 },
      {
        id: 'bonus',
        label: 'Bonus gold',
        field: { source: 'game.state', path: ['gold'] },
        amount: 3,
      },
      { id: 'xp', label: 'XP', field: { source: 'game.state', path: ['xp'] }, amount: 5 },
    ],
    drops: [
      { id: 'prize', itemType: 'token' },
      { id: 'bonus', itemType: 'bag', chance: 5000 },
      { id: 'never', itemType: 'token', chance: 0 },
    ],
  },
})

const component = combatComponentSchema.parse({
  id: 'combat',
  type: 'combat',
  encounter: 'fight',
  textTarget: 'text',
  lootInventory: 'loot',
  placement: { row: 1, column: 1 },
})

const commands = {
  '1': { type: 'queue-move', move: 'attack' },
  '3': { type: 'queue-move', move: 'guard' },
  '8': { type: 'escape' },
  '9': { type: 'take-loot' },
  '10': { type: 'take-all-loot' },
  '11': { type: 'retry-rewards' },
  '14': { type: 'continue' },
  '15': { type: 'end-turn' },
}

const scene = sceneSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  title: 'Fight',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 12, columns: 12 } },
  components: [
    component,
    { id: 'text', type: 'text', text: 'Story', placement: { row: 1, column: 2 } },
    {
      id: 'loot',
      type: 'inventory',
      label: 'Loot',
      owners: ['loot'],
      readOnly: true,
      descriptionTarget: 'text',
      placement: { row: 1, column: 3 },
    },
    { id: 'details', type: 'item-details', inventory: 'loot', placement: { row: 1, column: 4 } },
    {
      id: 'bar',
      type: 'action-bar',
      placement: { row: 10, column: 1 },
      slots: Object.fromEntries(
        Object.entries(commands).map(([id, command]) => [
          id,
          {
            label: id,
            action: { type: 'combat-action', combat: 'combat', command },
            inputBinding: { context: 'play', input: `slot-${id}` },
          },
        ]),
      ),
    },
  ],
})

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': Array.from({ length: 15 }, (_, i) => `slot-${i + 1}`),
  keyboard: Object.fromEntries(
    'QWERTASDFGZXCVB'.split('').map((key, i) => [`Key${key}`, `slot-${i + 1}`]),
  ),
  contexts: {
    play: Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`slot-${i + 1}`, `slot-${i + 1}`]),
    ),
  },
  'initial-context': 'play',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'rewards',
  title: 'Rewards',
  version: '1',
  scenes: ['fight', 'other'],
  'initial-scene': 'fight',
  combat: ['fight'],
  rules: ['rules'],
  inventory: ['items'],
  input: 'keys',
})

const other = sceneSchema.parse({ ...scene, id: 'other', components: [] })

async function setup(
  options: {
    seed?: number
    chance?: number
    numericOnly?: boolean
    blockedState?: boolean
    zero?: boolean
    enemyDamage?: number
  } = {},
) {
  const definition = combatDefinitionSchema.parse({
    ...encounter,
    moves: {
      ...encounter.moves,
      nudge: {
        ...encounter.moves.nudge!,
        damage: { min: options.enemyDamage ?? 0, max: options.enemyDamage ?? 0 },
      },
    },
    seed: options.seed ?? encounter.seed,
    rewards: options.numericOnly
      ? {
          numeric: encounter.rewards!.numeric.map((entry) => ({
            ...entry,
            amount: options.zero ? 0 : entry.amount,
          })),
          drops: [],
        }
      : {
          ...encounter.rewards,
          drops: encounter.rewards!.drops.map((drop) =>
            drop.id === 'bonus' ? { ...drop, chance: options.chance ?? drop.chance } : drop,
          ),
        },
  })

  const activeScene = options.numericOnly
    ? sceneSchema.parse({
        ...scene,
        components: scene.components
          .filter((entry) => !['loot', 'details'].includes(entry.id))
          .map((entry) =>
            entry.type === 'combat' ? { ...entry, lootInventory: undefined } : entry,
          ),
      })
    : scene

  const data = assembleGameData(
    manifest,
    new Map([
      ['fight', activeScene],
      ['other', other],
    ]),
    input,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['rules', rules]]),
    new Map([['fight', definition]]),
  )

  let blocked = options.blockedState ?? false

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
          createGameState: () => new Map(rules.state.map((field) => [field.path[0]!, field.value])),
          createSceneState: () => undefined,
        }),
      createStateTransactions: (game) => {
        if (!(game.state instanceof Map)) return

        const adapter = new MapStateTransactions(
          game.state,
          rules.state.map((field) => field.path),
        )

        return {
          prepare: (writes) =>
            blocked && writes.some((write) => write.path[0] === 'gold')
              ? undefined
              : adapter.prepare(writes),
        }
      },
    },
  )

  await engine.start()
  onTestFinished(() => engine.stop())
  const game = () => engine.lifecycle!.currentGame!
  const active = () => engine.lifecycle!.activeScene!

  const flush = () => {
    for (let i = 0; i < 8; i++) engine.flushMessages()
  }

  const bar = (id: string) => {
    game().actionBar!.activate(active(), 'bar', id)
    flush()
  }

  const win = () => {
    bar('1')
    bar('15')
  }

  const rewards = () => game().combatRewards!.snapshot(active(), 'combat')!

  const state = () => {
    const value = game().state

    if (!(value instanceof Map)) throw new Error('Expected Map')

    return value
  }

  const select = (id = rewardItemId('fight', 'prize')) =>
    game().inventorySelection!.select(active(), 'loot', id)

  return {
    engine,
    game,
    active,
    flush,
    bar,
    win,
    rewards,
    state,
    select,
    definition,
    unblock: () => {
      blocked = false
    },
  }
}

describe('combat rewards and loot', () => {
  it('automatically credits grouped numeric fields and creates finite loot once, with complete observer snapshots', async () => {
    const t = await setup({ chance: 10000 })
    const seen: unknown[] = []
    t.game().inventory!.subscribeChanges(() =>
      seen.push([
        t.state().get('gold'),
        t.state().get('xp'),
        t.game().combat!.snapshot(t.active(), 'combat')!.outcome,
        t.rewards().delivered,
        t.game().inventory!.snapshot.length,
      ]),
    )
    t.win()
    expect(seen).toEqual([[20, 5, 'victory', true, 2]])
    expect(t.rewards().items).toEqual([
      rewardItemId('fight', 'prize'),
      rewardItemId('fight', 'bonus'),
    ])
    expect(t.game().combat!.text(t.active(), 'combat')).toContain('Gold: +7')
    t.bar('15')
    t.bar('11')
    t.engine.lifecycle!.enterScene('other')
    t.engine.lifecycle!.enterScene('fight')
    expect(t.state().get('gold')).toBe(20)
    expect(t.game().inventory!.snapshot).toHaveLength(2)
  })
  it('collects selected loot and all remaining loot without advancing time or losing identity', async () => {
    const t = await setup({ chance: 10000 })
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '10')).toBe(false)
    t.win()
    const items = t.game().inventory!.snapshot
    t.select()
    const turn = t.game().actions!.progression
    t.bar('9')
    expect(t.game().inventorySelection!.get(t.active(), 'loot')).toBeUndefined()
    expect(t.rewards().remaining).toEqual([rewardItemId('fight', 'bonus')])
    t.bar('10')
    expect(t.rewards().remaining).toEqual([])
    expect(t.game().inventory!.snapshot).toEqual(
      items.map((item) => ({ ...item, placement: { type: 'carried', owner: 'player' } })),
    )
    expect(t.game().actions!.progression).toEqual(turn)
    expect(t.game().combat!.text(t.active(), 'combat')).toContain('Collected: Bag')
    expect(t.game().actionBar!.isEnabled(t.active(), 'bar', '10')).toBe(false)
  })
  it.each([-1, 1.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER])(
    'retains victory and the whole reward bundle when a numeric field is invalid: %s',
    async (gold) => {
      const t = await setup({ chance: 10000 })
      t.state().set('gold', gold)
      t.win()
      expect(t.game().combat!.snapshot(t.active(), 'combat')!.outcome).toBe('victory')
      expect(t.rewards()).toMatchObject({ delivered: false, issue: 'rewardInvalidAmount' })
      expect(t.state().get('xp')).toBe(0)
      expect(t.game().inventory!.snapshot).toHaveLength(0)
      const rolled = t.rewards().items
      t.state().set('gold', 0)
      t.bar('11')
      expect(t.rewards().items).toEqual(rolled)
      expect(t.rewards().delivered).toBe(true)
      expect(t.state().get('gold')).toBe(10)
      t.bar('11')
      expect(t.state().get('gold')).toBe(10)
    },
  )
  it('supports numeric-only rewards without loot owners and retries unavailable state adapters', async () => {
    const t = await setup({ blockedState: true, numericOnly: true })
    t.win()
    expect(t.rewards().issue).toBe('rewardUnavailable')
    t.unblock()
    t.bar('11')
    expect(t.state().get('gold')).toBe(20)
    expect(t.rewards().items).toEqual([])
  })
  it('rolls from a separate deterministic stream unaffected by combat draws and handles chance boundaries', async () => {
    const first = await setup()
    const second = await setup()
    second.bar('3')
    second.bar('15')
    first.win()
    second.win()
    expect(first.rewards().items).toEqual(second.rewards().items)
    const none = await setup({ chance: 0 })
    none.win()
    const all = await setup({ chance: 10000 })
    all.win()
    expect(none.rewards().items).toHaveLength(1)
    expect(all.rewards().items).toHaveLength(2)
    const rolls = []

    for (const seed of [1, 10000, 5000, 1000000, 2000000000]) {
      const t = await setup({ seed })
      t.win()
      rolls.push(t.rewards().items.length)
    }

    expect(new Set(rolls).size).toBe(2)
  })
  it('retries inventory creation failure without partial balances and keeps committed observer failures', async () => {
    const t = await setup({ chance: 10000 })
    const creation = vi.spyOn(t.game().inventory!, 'prepareCreate').mockReturnValue(undefined)
    t.win()
    expect(t.rewards().issue).toBe('rewardInventory')
    expect(t.state().get('gold')).toBe(10)
    creation.mockRestore()
    t.game().inventory!.subscribeChanges(() => {
      throw new Error('observer')
    })
    expect(() => t.bar('11')).toThrow()
    expect(t.rewards().delivered).toBe(true)
    expect(t.state().get('gold')).toBe(20)
    expect(t.game().inventory!.snapshot).toHaveLength(2)
    t.bar('11')
    expect(t.state().get('gold')).toBe(20)
  })
  it.each(['selection', 'ownership', 'scene', 'restart', 'collected'])(
    'discards stale queued loot after %s changes and consumes held phases',
    async (change) => {
      const t = await setup({ chance: 10000 })
      t.win()
      t.select()
      const before = t.rewards().remaining
      t.engine.input!.pressKey('KeyF')

      if (change === 'selection') t.select(rewardItemId('fight', 'bonus'))

      if (change === 'ownership')
        t.game().inventory!.move(rewardItemId('fight', 'prize'), {
          type: 'carried',
          owner: 'merchant',
        })

      if (change === 'scene') {
        t.engine.lifecycle!.enterScene('other')
        t.engine.lifecycle!.enterScene('fight')
      }

      if (change === 'restart') {
        t.engine.lifecycle!.startGame()
        t.engine.lifecycle!.enterScene('fight')
      }

      if (change === 'collected')
        t.game().combat!.request(t.active(), 'combat', { type: 'take-all-loot' })
      t.flush()
      t.engine.input!.releaseKey('KeyF')
      t.flush()

      if (change === 'restart') expect(t.rewards()).toBeUndefined()
      else if (change === 'ownership')
        expect(t.rewards().remaining).toEqual([rewardItemId('fight', 'bonus')])
      else if (change === 'collected') expect(t.rewards().remaining).toEqual([])
      else expect(t.rewards().remaining).toEqual(before)
    },
  )
  it('preserves unclaimed loot across Continue and clears all rewards on New Game', async () => {
    const t = await setup()
    t.win()
    const snapshot = t.rewards()
    t.bar('14')
    expect(t.active().data.id).toBe('other')
    t.engine.lifecycle!.enterScene('fight')
    expect(t.rewards()).toEqual(snapshot)
    t.engine.lifecycle!.startGame()
    t.engine.lifecycle!.enterScene('fight')
    expect(t.rewards()).toBeUndefined()
    expect(t.game().inventory!.snapshot).toHaveLength(0)
    expect(t.state().get('gold')).toBe(10)
  })
  it('delivers zero rewards and grants nothing after a resolved defeat', async () => {
    const zero = await setup({ zero: true, numericOnly: true })
    zero.win()
    expect(zero.rewards().delivered).toBe(true)
    expect(zero.state().get('gold')).toBe(10)
    expect(zero.state().get('xp')).toBe(0)
    const defeat = await setup({ enemyDamage: 30 })
    defeat.bar('15')
    expect(defeat.game().combat!.snapshot(defeat.active(), 'combat')!.outcome).toBe('defeat')
    expect(defeat.rewards()).toBeUndefined()
    expect(defeat.state().get('gold')).toBe(10)
  })
  it('collects only generated items owned by this encounter and publishes Take All once', async () => {
    const t = await setup({ chance: 10000 })
    t.win()

    const foreign = {
      id: 'foreign',
      itemType: 'token',
      colors: {},
      placement: { type: 'carried' as const, owner: 'loot' },
    }

    const creation = t.game().inventory!.prepareCreate!([foreign])!
    creation.commit()
    creation.notify()
    const observed = vi.fn(() => expect(t.rewards().remaining).toEqual([]))
    t.game().inventory!.subscribeChanges(observed)
    t.bar('10')
    expect(observed).toHaveBeenCalledTimes(1)
    expect(t.game().inventory!.snapshot.find((item) => item.id === 'foreign')!.placement).toEqual(
      foreign.placement,
    )
  })
  it('grants nothing on escape or externally completed encounters', async () => {
    const t = await setup()
    t.bar('8')
    t.bar('15')
    expect(t.rewards()).toBeUndefined()
    expect(t.state().get('gold')).toBe(10)
    const external = await setup()
    external.state().set('enemy', 0)
    expect(external.game().combat!.snapshot(external.active(), 'combat')!.outcome).toBe('victory')
    expect(external.rewards()).toBeUndefined()
  })
})

describe('staged inventory batches', () => {
  it('rejects collisions, invalid types, duplicate IDs, invalid placements and stale batches without changing inventory', () => {
    const store = new GameInventory(inventory)

    const item = {
      id: 'created',
      itemType: 'token',
      placement: { type: 'carried' as const, owner: 'loot' },
      colors: {},
    }

    expect(store.prepareCreate([item, item])).toBeUndefined()
    expect(store.prepareCreate([{ ...item, id: '__proto__' }])).toBeUndefined()
    expect(store.prepareCreate([{ ...item, itemType: 'missing' }])).toBeUndefined()
    const pending = store.prepareCreate([item])!
    pending.commit()
    pending.notify()
    expect(store.prepareCreate([item])).toBeUndefined()

    const stale = store.prepareTransfers([
      { item: item.id, destination: { type: 'carried', owner: 'player' } },
    ])!

    store.move(item.id, { type: 'carried', owner: 'merchant' })
    expect(stale.isCurrent()).toBe(false)
    stale.commit()
    expect(store.snapshot[0]!.placement).toEqual({ type: 'carried', owner: 'merchant' })
    expect(
      store.prepareTransfers([
        { item: item.id, destination: { type: 'carried', owner: 'missing' } },
      ]),
    ).toBeUndefined()
  })
})

describe('reward project validation and localization', () => {
  const project = () => ({
    revision: 'one',
    documents: {
      'game.json': manifest,
      'scenes/fight.json': scene,
      'scenes/other.json': other,
      'combat/fight.json': encounter,
      'inventory/items.json': inventory,
      'input/keys.json': input,
      'rules/rules.json': rules,
    },
  })

  it('validates all references and preserves extension metadata through encounter editing', () => {
    const p = project()
    expect(validateProject(p.documents)).toEqual([])
    expect(() =>
      applyCommand(p, {
        type: 'game.upsertCombat',
        encounter: { ...encounter, rewards: { ...encounter.rewards!, recipient: 'missing' } },
      }),
    ).toThrow()
    expect(() =>
      applyCommand(p, {
        type: 'scene.setCombat',
        sceneId: 'fight',
        component: { ...component, lootInventory: 'details' },
      }),
    ).toThrow()
    expect(() =>
      applyCommand(p, {
        type: 'game.updateRules',
        ruleId: 'rules',
        rules: { ...rules, state: rules.state.filter((field) => field.path[0] !== 'gold') },
      }),
    ).toThrow()

    const extended = {
      ...p,
      documents: {
        ...p.documents,
        'combat/fight.json': {
          ...encounter,
          rewards: {
            ...encounter.rewards,
            extension: 'bundle',
            numeric: encounter.rewards!.numeric.map((entry) => ({
              ...entry,
              extension: 'numeric',
              field: { ...entry.field, extension: 'field' },
            })),
            drops: encounter.rewards!.drops.map((drop) => ({ ...drop, extension: 'drop' })),
          },
        },
      },
    }

    const result = applyCommand(extended, { type: 'game.upsertCombat', encounter })
    expect(result.project.documents['combat/fight.json']).toMatchObject({
      rewards: {
        extension: 'bundle',
        numeric: [
          expect.objectContaining({
            extension: 'numeric',
            field: expect.objectContaining({ extension: 'field' }),
          }),
          expect.anything(),
          expect.anything(),
        ],
        drops: [
          expect.objectContaining({ extension: 'drop' }),
          expect.anything(),
          expect.anything(),
        ],
      },
    })
  })
  it('localizes reward labels and receipts without changing drop rules', () => {
    const translated = localizeCombat(
      {
        ...encounter,
        rewards: {
          ...encounter.rewards!,
          numeric: encounter.rewards!.numeric.map((entry) => ({ ...entry, labelKey: 'reward' })),
        },
        messageKeys: { rewardsDelivered: 'received' },
      },
      {
        fallback: { reward: 'Gold', received: 'Received' },
        messages: { reward: '<b>Goud</b>', received: 'Ontvangen' },
      },
    )

    expect(translated.rewards!.numeric[0]!.label).toBe('<b>Goud</b>')
    expect(translated.messages.rewardsDelivered).toBe('Ontvangen')
    expect(translated.rewards!.drops).toEqual(encounter.rewards!.drops)
    expect(() =>
      combatDefinitionSchema.parse({
        ...encounter,
        rewards: { ...encounter.rewards, drops: [{ id: 'bad', itemType: 'token', chance: 10001 }] },
      }),
    ).toThrow()
  })
})
