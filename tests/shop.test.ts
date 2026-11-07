import { describe, it, expect, vi, onTestFinished } from 'vite-plus/test'
import {
  gameSchema,
  sceneSchema,
  inventorySchema,
  inputSchema,
  gameRulesSchema,
  shopComponentSchema,
  localizeDefinitions,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  MapTradeState,
  assembleGameData,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, object, validateProject, inspectProject } from '@ancadeba/editor-core'

const placement = { row: 1, column: 1 }

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  itemTypes: {
    coat: { label: '<b>Coat</b>', equipmentSlots: ['body'] },
    bag: { label: 'Bag', container: true },
  },
  owners: {
    player: { label: 'Player', equipmentSlots: { body: 'Body' } },
    merchant: { label: 'Merchant' },
    other: { label: 'Other' },
  },
  items: {
    stock: { itemType: 'coat', placement: { type: 'carried', owner: 'merchant' } },
    second: { itemType: 'coat', placement: { type: 'carried', owner: 'merchant' } },
    owned: { itemType: 'coat', placement: { type: 'carried', owner: 'player' } },
    worn: { itemType: 'coat', placement: { type: 'equipped', owner: 'player', slot: 'body' } },
    bag: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
    nested: { itemType: 'coat', placement: { type: 'inside', container: 'bag' } },
  },
})

const rules = gameRulesSchema.parse({
  state: [
    { path: ['gold'], value: 20 },
    { path: ['merchantGold'], value: 10 },
    { path: ['price'], value: 7 },
  ],
  actions: {},
})

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['buy', 'sell'],
  keyboard: { KeyQ: 'buy', Digit1: 'buy', KeyW: 'sell' },
  contexts: { trading: { buy: 'buy', sell: 'sell' }, menu: { buy: 'accept' } },
  'initial-context': 'trading',
})

const shop = shopComponentSchema.parse({
  id: 'shop',
  type: 'shop',
  placement,
  playerInventory: 'player-items',
  merchantInventory: 'merchant-items',
  playerBalance: { source: 'game.state', path: ['gold'] },
  merchantFunds: { type: 'finite', balance: { source: 'game.state', path: ['merchantGold'] } },
  prices: {
    coat: { buy: { source: 'game.state', path: ['price'] }, sell: 4 },
    bag: { buy: 2, sell: 1 },
  },
  feedbackTarget: 'narrative',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'trades',
  title: 'Trades',
  version: '1',
  inventory: ['items'],
  rules: ['rules'],
  input: 'keys',
  scenes: ['shop', 'other'],
  'initial-scene': 'shop',
})

const scene = sceneSchema.parse({
  'schema-version': '1.0.0',
  id: 'shop',
  title: 'Shop',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 5, columns: 5 } },
  components: [
    { id: 'player-items', type: 'inventory', owners: ['player'], readOnly: true, placement },
    { id: 'merchant-items', type: 'inventory', owners: ['merchant'], readOnly: true, placement },
    { id: 'narrative', type: 'text', text: 'A shop.', placement },
    shop,
    {
      id: 'commands',
      type: 'action-bar',
      placement,
      slots: {
        '1': {
          label: 'Buy',
          action: { type: 'shop-action', shop: 'shop', operation: 'buy' },
          inputBinding: { context: 'trading', input: 'buy' },
        },
        '2': {
          label: 'Sell',
          action: { type: 'shop-action', shop: 'shop', operation: 'sell' },
          inputBinding: { context: 'trading', input: 'sell' },
        },
      },
    },
  ],
})

function project() {
  return {
    revision: 'one',
    documents: {
      'game.json': manifest,
      'inventory/items.json': inventory,
      'rules/rules.json': rules,
      'input/keys.json': input,
      'scenes/shop.json': scene,
      'scenes/other.json': { ...scene, id: 'other' },
    },
  }
}

async function setup(options: { unlimited?: boolean; adapter?: boolean; free?: boolean } = {}) {
  const shopDefinition = {
    ...shop,
    ...(options.unlimited ? { merchantFunds: { type: 'unlimited' as const } } : {}),
    ...(options.free ? { prices: { coat: { buy: 0, sell: 0 } } } : {}),
  }

  const scenes = new Map(
    ['shop', 'other'].map((id) => [
      id,
      sceneSchema.parse({
        ...scene,
        id,
        components: scene.components.map((component) =>
          component.type === 'shop' ? shopDefinition : component,
        ),
      }),
    ]),
  )

  const data = assembleGameData(
    manifest,
    scenes,
    input,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['rules', rules]]),
  )

  const fallback = vi.fn(() => ({ status: 'applied' as const }))

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
          createGameState: () =>
            new Map<string, unknown>(rules.state.map((field) => [field.path[0]!, field.value])),
          createSceneState: () => undefined,
        }),
      createTradeState: (game) =>
        game.state instanceof Map && options.adapter !== false
          ? new MapTradeState(
              game.state,
              rules.state.map((field) => field.path),
            )
          : undefined,
      createGameRules: () => ({
        handlers: new Map([
          ['fallback', fallback],
          ['changed', () => ({ status: 'applied' as const })],
        ]),
        inputBindings: (['pressed', 'released', 'cancelled'] as const).flatMap((phase) =>
          ['buy', 'sell'].map((input) => ({
            context: 'trading',
            input,
            phase,
            action: 'fallback',
          })),
        ),
      }),
    },
  )

  await engine.start()
  onTestFinished(() => engine.stop())
  const active = () => engine.lifecycle!.activeScene!
  const game = () => engine.lifecycle!.currentGame!

  const state = () => {
    const value = game().state

    if (!(value instanceof Map)) throw new Error('Expected Map state')

    return value
  }

  const select = (item: string, side: 'player' | 'merchant' = 'merchant') =>
    game().inventorySelection!.select(active(), `${side}-items`, item)

  const flush = () => {
    for (let i = 0; i < 5; i++) engine.flushMessages()
  }

  const press = (code = 'KeyQ') => {
    engine.input!.pressKey(code)
    engine.input!.releaseKey(code)
    flush()
  }

  const quote = () => game().trading!.quote(active(), 'shop')

  const trade = (operation: 'buy' | 'sell' = 'buy') =>
    game().trading!.trade(active(), 'shop', operation)

  return { engine, game, active, state, select, flush, press, quote, trade, fallback }
}

describe('shops and atomic trading', () => {
  it('disables selling a reserved item and leaves currency and ownership unchanged', async () => {
    const { game, active, state, select, trade, quote } = await setup()
    const token = { encounter: 'paused-fight' }
    expect(game().inventory!.reserveItem!('owned', token)).toBeUndefined()
    select('owned', 'player')
    expect(quote()?.reason).toBe('reserved')
    expect(game().trading!.checkTrade(active(), 'shop', 'sell')).toBe('reserved')
    expect(trade('sell')).toMatchObject({ status: 'rejected', reason: 'reserved' })
    expect(state().get('gold')).toBe(20)
    expect(game().inventory!.snapshot.find((item) => item.id === 'owned')!.placement).toEqual({
      type: 'carried',
      owner: 'player',
    })
    game().inventory!.releaseItems!(token)
    expect(quote()?.reason).toBeUndefined()
  })
  it('commits ownership and both balances before notifying, and clears only the source selection', async () => {
    const { game, active, state, select, trade, quote } = await setup()
    select('owned', 'player')
    select('stock')
    expect(game().inventorySelection!.get(active(), 'player-items')).toBeUndefined()
    expect(quote()).toMatchObject({ amount: 7, reason: undefined })
    const observations: unknown[] = []

    const observe = () =>
      observations.push([
        state().get('gold'),
        state().get('merchantGold'),
        game().inventory!.snapshot.find((item) => item.id === 'stock')!.placement,
      ])

    game().inventory!.subscribeChanges(observe)
    game().bindings!.subscribeChanges(observe)
    game().trading!.subscribeChanges(observe)
    expect(trade()).toEqual({ status: 'applied' })
    expect(observations).toEqual(
      Array.from({ length: 3 }, () => [13, 17, { type: 'carried', owner: 'player' }]),
    )
    expect(quote()).toBeUndefined()
    expect(game().trading!.feedback(active(), 'shop')).toBe('Bought <b>Coat</b> for 7 Gold.')
    expect(game().actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
  })

  it('sells nested items individually, makes them stock, and supports repurchasing the same instance', async () => {
    const { game, state, select, trade } = await setup()
    const item = game().inventory!.snapshot.find((item) => item.id === 'nested')!
    select('nested', 'player')
    expect(trade('sell').status).toBe('applied')
    expect(state().get('gold')).toBe(24)
    expect(state().get('merchantGold')).toBe(6)
    select('nested')
    expect(trade().status).toBe('applied')
    expect(game().inventory!.snapshot.find((entry) => entry.id === item.id)).toEqual({
      ...item,
      placement: { type: 'carried', owner: 'player' },
    })
  })

  it('supports free trades and unlimited merchant funds without writing a merchant balance', async () => {
    const free = await setup({ free: true })
    free.state().set('gold', 0)
    free.select('stock')
    expect(free.trade().status).toBe('applied')
    expect(free.state().get('gold')).toBe(0)
    const unlimited = await setup({ unlimited: true })
    unlimited.state().set('merchantGold', 0)
    unlimited.select('owned', 'player')
    expect(unlimited.trade('sell').status).toBe('applied')
    expect(unlimited.state().get('merchantGold')).toBe(0)
    expect(unlimited.state().get('gold')).toBe(24)
  })

  it('rejects insufficient funds and overflow without changing either participant', async () => {
    const { state, game, select, trade } = await setup()
    const before = game().inventory!.snapshot
    state().set('gold', 6)
    select('stock')
    expect(trade()).toMatchObject({ reason: 'insufficientPlayerFunds' })
    state().set('merchantGold', 3)
    select('owned', 'player')
    expect(trade('sell')).toMatchObject({ reason: 'insufficientMerchantFunds' })
    state().set('merchantGold', 10)
    state().set('gold', Number.MAX_SAFE_INTEGER)
    expect(trade('sell')).toMatchObject({ reason: 'invalidAmount' })
    state().set('merchantGold', Number.MAX_SAFE_INTEGER)
    select('stock')
    expect(trade()).toMatchObject({ reason: 'invalidAmount' })
    expect(game().inventory!.snapshot).toEqual(before)
  })

  it.each([-1, 1.5, NaN, Infinity, '7', true, undefined])(
    'rejects invalid runtime price %s without coercion or fallback',
    async (value) => {
      const { state, game, select, trade } = await setup()
      state().set('price', value)
      select('stock')
      const before = game().inventory!.snapshot
      expect(trade()).toMatchObject({ reason: 'invalidAmount' })
      expect(state().get('gold')).toBe(20)
      expect(game().inventory!.snapshot).toEqual(before)
    },
  )

  it.each([-1, 2.5, NaN, Infinity, '20', undefined])(
    'rejects invalid runtime balances %s',
    async (value) => {
      const { state, select, trade } = await setup()
      state().set('gold', value)
      select('stock')
      expect(trade()).toMatchObject({ reason: 'invalidAmount' })
      expect(state().get('merchantGold')).toBe(10)
    },
  )

  it('requires an adapter, owned stock, unequipped items, and empty containers', async () => {
    const { game, active, select, trade } = await setup()
    select('worn', 'player')
    expect(trade('sell')).toMatchObject({ reason: 'equipped' })
    select('bag', 'player')
    expect(trade('sell')).toMatchObject({ reason: 'containerNotEmpty' })
    expect(game().trading!.quoteItem(active(), 'shop', 'owned', 'buy')!.reason).toBe('wrongOwner')
    game().inventory!.move('nested', { type: 'carried', owner: 'player' })
    expect(trade('sell').status).toBe('applied')
    const unsupported = await setup({ adapter: false })
    unsupported.select('stock')
    expect(unsupported.quote()!.reason).toBe('unsupportedState')
  })

  it('retains the complete commit after observer failures and notifies the other services once', async () => {
    const { game, active, state, select, trade } = await setup()
    select('stock')
    game().inventory!.subscribeChanges(() => {
      throw new Error('observer')
    })
    const inventoryChanged = vi.fn()
    const bindingsChanged = vi.fn()
    const tradeChanged = vi.fn()
    game().inventory!.subscribeChanges(inventoryChanged)
    game().bindings!.subscribeChanges(bindingsChanged)
    game().trading!.subscribeChanges(tradeChanged)
    expect(() => trade()).toThrow('Trade committed')
    expect(state().get('gold')).toBe(13)
    expect(game().inventory!.snapshot.find((item) => item.id === 'stock')!.placement).toEqual({
      type: 'carried',
      owner: 'player',
    })
    expect(inventoryChanged).toHaveBeenCalledTimes(1)
    expect(bindingsChanged).toHaveBeenCalledTimes(1)
    expect(tradeChanged).toHaveBeenCalledTimes(1)
    expect(game().trading!.feedback(active(), 'shop')).toContain('Bought')
  })

  it.each(['selection', 'price', 'ownership', 'scene', 'restart'])(
    'discards queued commands after changing %s and consumes held phases',
    async (change) => {
      const { engine, game, active, state, select, flush, fallback } = await setup()
      select('stock')
      engine.input!.pressKey('KeyQ')

      if (change === 'selection') select('second')

      if (change === 'price') state().set('price', 8)

      if (change === 'ownership')
        game().inventory!.move('stock', { type: 'carried', owner: 'other' })

      if (change === 'scene') engine.lifecycle!.enterScene('other')

      if (change === 'restart') {
        engine.lifecycle!.startGame()
        engine.lifecycle!.enterScene('shop')
      }

      flush()
      engine.input!.releaseKey('KeyQ')
      flush()
      expect(state().get('gold')).toBe(20)
      expect(fallback).not.toHaveBeenCalled()
      expect(game().actionBar!.getSlot(active(), 'commands', '1')).toBeDefined()
    },
  )

  it('claims disabled shortcuts, cancels on context changes, and revalidates balances at execution', async () => {
    const { engine, state, select, press, flush, fallback, game, active } = await setup()
    press()
    select('stock')
    engine.input!.pressKey('KeyQ')
    state().set('gold', 0)
    flush()
    engine.input!.setContext('menu')
    flush()
    engine.input!.releaseKey('KeyQ')
    engine.input!.setContext('trading')
    expect(fallback).not.toHaveBeenCalled()
    expect(game().actionBar!.isEnabled(active(), 'commands', '1')).toBe(false)
    state().set('gold', 20)
    press('Digit1')
    expect(state().get('gold')).toBe(13)
    engine.lifecycle!.enterScene('other')
    expect(state().get('gold')).toBe(13)
    engine.lifecycle!.startGame()
    engine.lifecycle!.enterScene('shop')
    expect(state().get('gold')).toBe(20)
  })
})

describe('shop authoring and localization', () => {
  it('stages only declared numeric Map fields, detects stale preparation, and snapshots write requests', () => {
    const child = new Map<string, unknown>([['gold', 10]])
    const root = new Map<string, unknown>([['player', child]])
    const adapter = new MapTradeState(root, [['player', 'gold']])
    expect(adapter.prepare([{ path: ['missing'], expected: 0, value: 1 }])).toBeUndefined()
    expect(adapter.prepare([{ path: ['player', 'gold'], expected: 9, value: 1 }])).toBeUndefined()
    expect(adapter.prepare([{ path: ['player', 'gold'], expected: 10, value: -1 }])).toBeUndefined()
    const request = { path: ['player', 'gold'], expected: 10, value: 8 }
    const prepared = adapter.prepare([request])!
    expect(child.get('gold')).toBe(10)
    child.set('gold', 11)
    expect(prepared.isCurrent()).toBe(false)
    child.set('gold', 10)
    request.value = 100
    request.path[1] = 'other'
    expect(prepared.isCurrent()).toBe(true)
    prepared.commit()
    expect(child.get('gold')).toBe(8)
    expect(child.has('other')).toBe(false)
  })
  it('validates single shops, distinct read-only participants, bindings, prices and references', () => {
    const initial = project()
    expect(validateProject(initial.documents)).toEqual([])
    expect(() =>
      sceneSchema.parse({
        ...scene,
        components: [...scene.components, { ...shop, id: 'second-shop' }],
      }),
    ).toThrow('one shop')
    expect(() => sceneSchema.parse({ ...scene, type: 'stand-alone' })).toThrow()
    expect(() =>
      shopComponentSchema.parse({
        ...shop,
        merchantFunds: { type: 'finite', balance: shop.playerBalance },
      }),
    ).toThrow('distinct')
    expect(() =>
      applyCommand(initial, {
        type: 'scene.upsertShop',
        sceneId: 'shop',
        component: { ...shop, prices: { absent: { buy: 2 } } },
      }),
    ).toThrow('invalid project')
    expect(() =>
      applyCommand(initial, {
        type: 'game.updateRules',
        ruleId: 'rules',
        rules: { ...rules, state: rules.state.filter((field) => field.path[0] !== 'gold') },
      }),
    ).toThrow('invalid project')
    expect(() =>
      applyCommand(initial, { type: 'scene.removeShop', sceneId: 'shop', componentId: 'shop' }),
    ).toThrow('invalid project')
  })

  it('preserves extensions in shop prices, balance bindings, and linked panels', () => {
    const initial = project()

    const extended = {
      ...initial,
      documents: {
        ...initial.documents,
        'scenes/shop.json': {
          ...scene,
          components: scene.components.map((component) =>
            component.type === 'shop'
              ? {
                  ...component,
                  extension: true,
                  playerBalance: { ...shop.playerBalance, extension: 'binding' },
                  prices: {
                    coat: { ...shop.prices.coat, extension: 'price' },
                    bag: shop.prices.bag,
                  },
                }
              : component.type === 'inventory'
                ? { ...component, extension: 'panel' }
                : component,
          ),
        },
      },
    }

    const updated = applyCommand(extended, {
      type: 'scene.upsertShop',
      sceneId: 'shop',
      component: { ...shop, label: 'Updated' },
      panels: scene.components.filter((component) => component.type === 'inventory'),
    })

    const components = object(updated.project.documents['scenes/shop.json']).components
    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'shop',
          extension: true,
          playerBalance: expect.objectContaining({ extension: 'binding' }),
          prices: expect.objectContaining({
            coat: expect.objectContaining({ extension: 'price' }),
          }),
        }),
        expect.objectContaining({ type: 'inventory', extension: 'panel' }),
      ]),
    )
    expect(inspectProject(updated.project).diagnostics).toEqual([])
  })

  it('localizes shop labels, currency, and literal feedback templates', () => {
    const localizedScene = sceneSchema.parse({
      ...scene,
      components: scene.components.map((component) =>
        component.type === 'shop'
          ? {
              ...shop,
              labelKey: 'shop',
              currencyKey: 'currency',
              messageKeys: { bought: 'bought' },
            }
          : component,
      ),
    })

    const localized = localizeDefinitions(
      { ...manifest, languages: { default: 'en', available: ['en', 'nl'] } },
      new Map([['shop', localizedScene]]),
      {
        fallback: { shop: 'Shop', currency: 'Gold', bought: 'Bought {item}.' },
        messages: { shop: 'Winkel', currency: 'Goud', bought: '<b>{item}</b> gekocht.' },
      },
    )

    expect(
      localized.scenes.get('shop')!.components.find((component) => component.type === 'shop'),
    ).toMatchObject({
      label: 'Winkel',
      currency: 'Goud',
      messages: { bought: '<b>{item}</b> gekocht.' },
    })
  })
})
