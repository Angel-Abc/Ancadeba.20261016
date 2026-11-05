import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  gameSchema,
  sceneSchema,
  inputSchema,
  inventorySchema,
  gameRulesSchema,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  assembleGameData,
  type ActionRequest,
  type EngineMessages,
  type GameActionHandler,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject } from '@ancadeba/editor-core'

const placement = { row: 1, column: 1, rowSpan: 1, columnSpan: 1 }

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'items',
  title: 'Items',
  version: '1',
  scenes: ['first', 'second'],
  'initial-scene': 'first',
  inventory: ['items'],
  input: 'controls',
})

const controls = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['one', 'two', 'three'],
  keyboard: { KeyQ: 'one', KeyR: 'two', KeyT: 'three' },
  contexts: { gameplay: { one: 'scene', two: 'inspect', three: 'use' } },
  'initial-context': 'gameplay',
})

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  itemTypes: {
    letter: {
      label: 'Letter',
      inspection: { action: 'inspect-letter', details: { source: 'game.state', path: ['clue'] } },
      actions: {
        use: { action: 'use-letter', enabledWhen: { source: 'game.state', path: ['enabled'] } },
      },
    },
    stone: { label: 'Stone', actions: { use: { action: 'use-stone' } } },
    bag: { label: 'Bag', container: true },
  },
  owners: { player: { label: 'Player' }, outside: { label: 'Outside' } },
  items: {
    bag: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
    letter: { itemType: 'letter', placement: { type: 'inside', container: 'bag' } },
    stone: { itemType: 'stone', placement: { type: 'carried', owner: 'player' } },
  },
})

const scenes = new Map(
  ['first', 'second'].map((id) => [
    id,
    sceneSchema.parse({
      'schema-version': '1.0.0',
      id,
      title: id,
      type: 'game',
      screen: { type: 'grid', grid: { rows: 2, columns: 1 } },
      components: [
        {
          id: 'items',
          type: 'inventory',
          label: 'Inventory',
          owners: ['player'],
          readOnly: true,
          placement,
        },
        {
          id: 'commands',
          type: 'action-bar',
          placement: { ...placement, row: 2 },
          slots: {
            '1': {
              label: 'Scene action',
              action: { type: 'request-action', action: 'scene' },
              inputBinding: { context: 'gameplay', input: 'scene' },
            },
            '4': {
              label: 'Inspect',
              action: { type: 'inventory-action', inventory: 'items', action: 'inspect' },
              inputBinding: { context: 'gameplay', input: 'inspect' },
            },
            '5': {
              label: 'Use',
              action: { type: 'inventory-action', inventory: 'items', action: 'use' },
              inputBinding: { context: 'gameplay', input: 'use' },
            },
          },
        },
      ],
    }),
  ]),
)

async function setup() {
  const game = assembleGameData(
    manifest,
    scenes,
    controls,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
  )

  const requests: ActionRequest[] = []

  const handler: GameActionHandler = (request) => {
    requests.push(request)

    return { status: 'applied' }
  }

  const engine = new Engine(
    { load: async () => game },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    {
      scheduler: { schedule: () => () => {} },
      clock: { now: () => 0 },
      createGameLifecycle: (data) =>
        new GameLifecycle(data, {
          createGameState: () => ({ enabled: true, clue: '' }),
          createSceneState: () => undefined,
        }),
      createGameRules: () => ({
        handlers: new Map(
          ['inspect-letter', 'use-letter', 'use-stone', 'scene', 'fallback'].map((id) => [
            id,
            handler,
          ]),
        ),
        inputBindings: (['pressed', 'released', 'cancelled'] as const).map((phase) => ({
          context: 'gameplay',
          input: 'inspect',
          action: 'fallback',
          phase,
        })),
      }),
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const scene = engine.lifecycle!.activeScene!
  const bar = engine.lifecycle!.currentGame!.actionBar!

  const flush = () => {
    for (let index = 0; index < 4; index++) engine.flushMessages()
  }

  const press = (code: string) => {
    engine.input!.pressKey(code)
    engine.input!.releaseKey(code)
    flush()
  }

  return { game, engine, scene, bar, requests, flush, press }
}

describe('inventory action-bar context', () => {
  it('adds applicable item commands alongside scene actions and targets the selected item', async () => {
    const { engine, scene, bar, requests, press, flush } = await setup()
    expect(bar.getSlot(scene, 'commands', '4')).toBeUndefined()
    expect(bar.getSlot(scene, 'commands', '1')!.label).toBe('Scene action')
    bar.selectInventoryItem(scene, 'items', 'letter')
    expect(bar.getSelectedItem(scene, 'items')).toBe('letter')
    expect(bar.isEnabled(scene, 'commands', '4')).toBe(true)
    expect(bar.isEnabled(scene, 'commands', '5')).toBe(true)
    press('KeyR')
    expect(requests[0]).toMatchObject({
      action: 'inspect-letter',
      payload: 'letter',
      origin: { type: 'input' },
    })
    bar.activate(scene, 'commands', '5')
    flush()
    expect(requests[1]).toMatchObject({
      action: 'use-letter',
      payload: 'letter',
      origin: { type: 'direct' },
    })
    bar.selectInventoryItem(scene, 'items', 'stone')
    expect(bar.getSlot(scene, 'commands', '4')).toBeUndefined()
    press('KeyT')
    press('KeyQ')
    expect(requests.slice(-2).map(({ action, payload }) => [action, payload])).toEqual([
      ['use-stone', 'stone'],
      ['scene', undefined],
    ])
    expect(engine.lifecycle!.activeScene).toBe(scene)
  })

  it('never retargets queued or held input when selection changes', async () => {
    const { engine, scene, bar, requests, flush, press } = await setup()
    bar.selectInventoryItem(scene, 'items', 'letter')
    engine.input!.pressKey('KeyT')
    bar.selectInventoryItem(scene, 'items', 'stone')
    flush()
    engine.input!.pressKey('KeyT')
    engine.input!.releaseKey('KeyT')
    flush()
    expect(requests).toEqual([])
    press('KeyT')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ action: 'use-stone', payload: 'stone' })
  })

  it('clears context when a containing item leaves the panel and when scenes change', async () => {
    const { engine, scene, bar, requests, flush } = await setup()
    let changes = 0

    const unsubscribe = bar.subscribeChanges(() => {
      changes++
    })

    bar.selectInventoryItem(scene, 'items', 'letter')
    engine.input!.pressKey('KeyR')
    engine.lifecycle!.currentGame!.inventory!.move('bag', { type: 'carried', owner: 'outside' })
    engine.input!.releaseKey('KeyR')
    flush()
    expect(requests).toEqual([])
    expect(bar.getSelectedItem(scene, 'items')).toBeUndefined()
    expect(bar.getSlot(scene, 'commands', '4')).toBeUndefined()
    bar.selectInventoryItem(scene, 'items', 'letter')
    expect(bar.getSelectedItem(scene, 'items')).toBeUndefined()
    bar.selectInventoryItem(scene, 'items', 'stone')
    engine.lifecycle!.enterScene('second')
    const second = engine.lifecycle!.activeScene!
    expect(bar.getSelectedItem(second, 'items')).toBeUndefined()
    expect(bar.getSlot(second, 'commands', '5')).toBeUndefined()
    expect(changes).toBe(4)
    unsubscribe()
  })

  it('preserves disabled command ownership and restores fallback routing after clearing selection', async () => {
    const { engine, scene, bar, requests, press } = await setup()
    bar.selectInventoryItem(scene, 'items', 'letter')
    // SAFETY: the paired lifecycle factory creates this boolean field.
    const state = engine.lifecycle!.currentGame!.state as { enabled: boolean }
    state.enabled = false
    expect(bar.isEnabled(scene, 'commands', '5')).toBe(false)
    press('KeyT')
    expect(requests).toEqual([])
    bar.selectInventoryItem(scene, 'items')
    press('KeyR')
    expect(requests.map(({ action }) => action)).toEqual(['fallback', 'fallback'])
  })

  it('validates panel references and protects authored item actions when editing rules', () => {
    const project = {
      revision: 'one',
      documents: {
        'game.json': { ...manifest, rules: ['items'] },
        'input/controls.json': controls,
        'inventory/items.json': inventory,
        ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
        'rules/items.json': {
          state: [
            { path: ['enabled'], value: true },
            { path: ['clue'], value: '' },
          ],
          actions: {
            'inspect-letter': [{ when: [], effects: [] }],
            'use-letter': [{ when: [], effects: [] }],
            'use-stone': [{ when: [], effects: [] }],
            scene: [{ when: [], effects: [] }],
          },
        },
      },
    }

    const change = applyCommand(project, {
      type: 'inventory.setItemActions',
      itemType: 'stone',
      actions: { read: { action: 'use-stone' } },
    })

    expect(inspectProject(change.project).inventory!.itemTypes.stone!.actions).toEqual({
      read: { action: 'use-stone' },
    })
    const currentRules = gameRulesSchema.parse(project.documents['rules/items.json'])
    const { 'use-stone': _removed, ...remainingActions } = currentRules.actions
    expect(() =>
      applyCommand(change.project, {
        type: 'game.updateRules',
        ruleId: 'items',
        rules: { ...currentRules, actions: remainingActions },
      }),
    ).toThrow('Unlink action')

    const component = scenes
      .get('first')!
      .components.find((component) => component.type === 'action-bar')!

    expect(() =>
      applyCommand(project, {
        type: 'scene.setActionBar',
        sceneId: 'first',
        component: {
          ...component,
          slots: {
            '1': {
              label: 'Inspect',
              action: { type: 'inventory-action', inventory: 'missing', action: 'inspect' },
            },
          },
        },
      }),
    ).toThrow('invalid project')
  })
})
