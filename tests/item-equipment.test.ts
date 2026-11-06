import { readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import {
  gameSchema,
  inventorySchema,
  inputSchema,
  sceneSchema,
  localizeInventory,
  itemPresentationSchema,
} from '@ancadeba/schemas'
import {
  Engine,
  GameInventory,
  GameLoader,
  assembleGameData,
  selectedItemDetails,
  itemDetailsText,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus, JsonResourceLoader } from '@ancadeba/utilities'
import { applyCommand, inspectProject, object, validateProject } from '@ancadeba/editor-core'

const placement = { row: 1, column: 1 }

const definition = inventorySchema.parse({
  'schema-version': '1.0.0',
  itemTypes: {
    cloak: {
      label: 'Cloak',
      description: '<em>Warm</em>',
      equipmentSlots: ['body'],
      properties: [
        { id: 'value', label: 'Value', value: 4 },
        { id: 'effect', label: 'Effect', value: { source: 'game.state', path: ['missing'] } },
      ],
    },
    ring: { label: 'Ring', equipmentSlots: ['left', 'right'] },
    bag: { label: 'Bag', container: true, equipmentSlots: ['body'] },
  },
  owners: {
    player: {
      label: 'Player',
      equipmentSlots: { body: 'Body', left: 'Left hand', right: 'Right hand' },
    },
    other: { label: 'Other', equipmentSlots: { body: 'Body' } },
  },
  items: {
    bag: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
    cloak: { itemType: 'cloak', placement: { type: 'inside', container: 'bag' } },
    replacement: { itemType: 'cloak', placement: { type: 'carried', owner: 'player' } },
    other: { itemType: 'cloak', placement: { type: 'equipped', owner: 'other', slot: 'body' } },
    ring: { itemType: 'ring', placement: { type: 'carried', owner: 'player' } },
  },
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'equipment',
  title: 'Equipment',
  version: '1',
  inventory: ['items'],
  input: 'keys',
  scenes: ['first', 'second'],
  'initial-scene': 'first',
})

const controls = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['one', 'two'],
  keyboard: { KeyQ: 'one', Digit1: 'one', KeyW: 'two' },
  contexts: { equipment: { one: 'equip', two: 'unequip' } },
  'initial-context': 'equipment',
})

const scenes = new Map(
  ['first', 'second'].map((id) => [
    id,
    sceneSchema.parse({
      'schema-version': '1.0.0',
      id,
      title: id,
      type: 'game',
      screen: { type: 'grid', grid: { rows: 4, columns: 4 } },
      components: [
        {
          id: 'items',
          type: 'inventory',
          label: 'Items',
          placement,
          owners: ['player', 'other'],
          descriptionTarget: 'text',
        },
        { id: 'text', type: 'text', text: 'Room', placement },
        { id: 'details', type: 'item-details', inventory: 'items', placement },
        { id: 'equipment', type: 'equipment', inventory: 'items', owner: 'player', placement },
        {
          id: 'commands',
          type: 'action-bar',
          placement,
          slots: {
            '1': {
              label: 'Equip',
              action: { type: 'equipment-action', equipment: 'equipment', operation: 'equip' },
              inputBinding: { context: 'equipment', input: 'equip' },
            },
            '2': {
              label: 'Unequip',
              action: { type: 'equipment-action', equipment: 'equipment', operation: 'unequip' },
              inputBinding: { context: 'equipment', input: 'unequip' },
            },
          },
        },
      ],
    }),
  ]),
)

async function setup(withBar = true, readOnly = false) {
  const variants = new Map(
    [...scenes].map(([id, scene]) => [
      id,
      sceneSchema.parse({
        ...scene,
        components: scene.components
          .filter((component) => withBar || component.type !== 'action-bar')
          .map((component) =>
            component.type === 'equipment' ? { ...component, readOnly } : component,
          ),
      }),
    ]),
  )

  const data = assembleGameData(
    manifest,
    variants,
    controls,
    undefined,
    new Map(),
    new Map([['items', definition]]),
  )

  const fallback = vi.fn(() => ({ status: 'applied' as const }))

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    {
      scheduler: { schedule: () => () => {} },
      clock: { now: () => 0 },
      createGameRules: () => ({
        handlers: new Map([['fallback', fallback]]),
        inputBindings: (['pressed', 'released', 'cancelled'] as const).map((phase) => ({
          context: 'equipment',
          input: 'equip',
          phase,
          action: 'fallback',
        })),
      }),
    },
  )

  await engine.start()
  onTestFinished(() => engine.stop())
  const scene = engine.lifecycle!.activeScene!

  if (scene.type !== 'game') throw new Error('Expected game')
  const { game } = scene

  const flush = () => {
    for (let i = 0; i < 4; i++) engine.flushMessages()
  }

  const select = (item?: string) => game.inventorySelection!.select(scene, 'items', item)

  const press = (key: string) => {
    engine.input!.pressKey(key)
    engine.input!.releaseKey(key)
    flush()
  }

  return { engine, scene, game, flush, select, press, fallback }
}

describe('atomic equipment operations', () => {
  it('replaces equipment in one commit, preserves nested contents, and leaves legacy moves unchanged', () => {
    const inventory = new GameInventory(definition)
    inventory.equip('bag', 'player', 'body')
    const observations: unknown[] = []
    inventory.subscribeChanges(() => observations.push(inventory.snapshot))
    expect(
      inventory.checkMove('cloak', { type: 'equipped', owner: 'player', slot: 'body' }),
    ).toContain('occupied')
    expect(inventory.checkEquip('cloak', 'player', 'body')).toBeUndefined()
    expect(inventory.equip('cloak', 'player', 'body')).toEqual({ status: 'applied', changed: true })
    expect(observations).toHaveLength(1)
    expect(inventory.snapshot.find((item) => item.id === 'bag')!.placement).toEqual({
      type: 'carried',
      owner: 'player',
    })
    expect(inventory.snapshot.find((item) => item.id === 'cloak')!.placement).toEqual({
      type: 'equipped',
      owner: 'player',
      slot: 'body',
    })
    expect(inventory.equip('cloak', 'player', 'body')).toEqual({
      status: 'applied',
      changed: false,
    })
    expect(observations).toHaveLength(1)
  })

  it('rejects incompatible slots and cross-owner equipment without displacing anything', () => {
    const inventory = new GameInventory(definition)
    inventory.equip('cloak', 'player', 'body')
    const before = inventory.snapshot
    const changed = vi.fn()
    inventory.subscribeChanges(changed)

    for (const [item, owner, slot] of [
      ['ring', 'player', 'body'],
      ['other', 'player', 'body'],
      ['cloak', 'other', 'body'],
      ['missing', 'player', 'body'],
      ['replacement', 'player', 'absent'],
    ]) {
      expect(inventory.checkEquip(item!, owner!, slot!)).toBeDefined()
      expect(inventory.equip(item!, owner!, slot!).status).toBe('rejected')
      expect(inventory.snapshot).toEqual(before)
    }

    expect(changed).not.toHaveBeenCalled()
    inventory.dispose()
    expect(inventory.equip('cloak', 'player', 'body').status).toBe('rejected')
  })

  it('keeps the whole replacement committed when an observer fails and still notifies other observers', () => {
    const inventory = new GameInventory(definition)
    inventory.equip('cloak', 'player', 'body')
    inventory.subscribeChanges(() => {
      throw new Error('observer')
    })
    const changed = vi.fn()
    inventory.subscribeChanges(changed)
    expect(() => inventory.equip('replacement', 'player', 'body')).toThrow(AggregateError)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(inventory.snapshot.find((item) => item.id === 'cloak')!.placement).toEqual({
      type: 'carried',
      owner: 'player',
    })
    expect(inventory.snapshot.find((item) => item.id === 'replacement')!.placement).toEqual({
      type: 'equipped',
      owner: 'player',
      slot: 'body',
    })
  })
})

describe('shared item selection and equipment commands', () => {
  it('updates automatic destinations when an item is transferred into the equipment owner inventory', async () => {
    const { game, scene, select } = await setup()
    select('other')
    expect(game.equipment!.get(scene, 'equipment')!.slot).toBeUndefined()
    game.inventory!.move('other', { type: 'carried', owner: 'player' })
    expect(game.equipment!.get(scene, 'equipment')!.slot).toBe('body')
    expect(game.equipment!.isEnabled(scene, 'equipment', 'equip')).toBe(true)
  })

  it('updates localized details without replacing inventory, scene, or item selection', async () => {
    const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

    const loader = new GameLoader(
      new JsonResourceLoader(
        {
          readText: (path) =>
            readFile(new URL(`../sample-games/basic/${path}`, import.meta.url), 'utf8'),
          readBytes: async () => new Uint8Array(),
        },
        logger,
      ),
      ['en'],
    )

    const engine = new Engine(
      loader,
      { mount: () => () => {} },
      logger,
      () => new MessageBus<EngineMessages>(),
      { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } },
    )

    await engine.start()
    onTestFinished(() => engine.stop())
    const game = engine.lifecycle!.startGame()
    const scene = engine.lifecycle!.enterScene('standard')
    game.inventory!.move('folded-letter', { type: 'carried', owner: 'player' })
    game.inventorySelection!.select(scene, 'items', 'folded-letter')
    const selected = game.inventorySelection!.get(scene, 'items')
    const inventory = game.inventory
    expect(selectedItemDetails(scene, 'items')!.type.label).toBe('Folded letter')
    engine.game!.localization!.select('nl')
    expect(selectedItemDetails(scene, 'items')!.type.label).toBe('Gevouwen brief')
    expect(engine.lifecycle!.activeScene).toBe(scene)
    expect(game.inventory).toBe(inventory)
    expect(game.inventorySelection!.get(scene, 'items')).toBe(selected)
    expect(game.inventory!.snapshot.find((item) => item.id === 'folded-letter')!.placement).toEqual(
      { type: 'carried', owner: 'player' },
    )
  })
  it('resolves nested item details without an action bar, preserving literal text and missing-value diagnostics', async () => {
    const { select, scene, game } = await setup(false)
    select('cloak')
    const details = selectedItemDetails(scene, 'items')!
    expect(details.location).toBe('Inside Bag (Player)')
    expect(details.properties[1]!.issue).toBeDefined()
    expect(itemDetailsText(details)).toContain('<em>Warm</em>')
    expect(itemDetailsText(details)).toContain('Effect: —')
    const token = game.inventorySelection!.get(scene, 'items')
    game.inventory!.move('bag', { type: 'carried', owner: 'other' })
    expect(game.inventorySelection!.get(scene, 'items')).toBe(token)
    expect(selectedItemDetails(scene, 'items')!.location).toBe('Inside Bag (Other)')
    select()
    expect(selectedItemDetails(scene, 'items')).toBeUndefined()
  })

  it('auto-selects only one compatible destination and requires explicit multi-slot choice', async () => {
    const { select, game, scene, press } = await setup()
    select('cloak')
    expect(game.equipment!.get(scene, 'equipment')!.slot).toBe('body')
    select('ring')
    expect(game.equipment!.get(scene, 'equipment')!.slot).toBeUndefined()
    expect(game.actionBar!.isEnabled(scene, 'commands', '1')).toBe(false)
    game.equipment!.selectSlot(scene, 'equipment', 'right')
    press('KeyQ')
    expect(game.inventory!.snapshot.find((item) => item.id === 'ring')!.placement).toEqual({
      type: 'equipped',
      owner: 'player',
      slot: 'right',
    })
    expect(game.actions!.progression.worldTimeMs).toBe(0)
    press('KeyW')
    expect(game.inventory!.snapshot.find((item) => item.id === 'ring')!.placement).toEqual({
      type: 'carried',
      owner: 'player',
    })
  })

  it('shares action-bar delegates and claims disabled commands across all gesture phases', async () => {
    const { game, scene, press, fallback, engine, flush } = await setup()
    game.actionBar!.selectInventoryItem(scene, 'items', 'other')
    expect(game.inventorySelection!.get(scene, 'items')!.item).toBe('other')
    expect(game.actionBar!.isEnabled(scene, 'commands', '1')).toBe(false)
    press('KeyQ')
    engine.input!.pressKey('KeyQ')
    engine.input!.reset()
    engine.input!.releaseKey('KeyQ')
    flush()
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each(['selection', 'destination', 'scene', 'restart'])(
    'discards queued input after changing the %s and consumes the held terminal phase',
    async (change) => {
      const { game, scene, select, engine, flush, fallback } = await setup()
      select('ring')
      game.equipment!.selectSlot(scene, 'equipment', 'left')
      engine.input!.pressKey('KeyQ')

      if (change === 'selection') select('cloak')

      if (change === 'destination') game.equipment!.selectSlot(scene, 'equipment', 'right')

      if (change === 'scene') engine.lifecycle!.enterScene('second')

      if (change === 'restart') engine.lifecycle!.startGame()
      flush()
      engine.input!.releaseKey('KeyQ')
      flush()
      expect(
        engine.lifecycle!.currentGame!.inventory!.snapshot.find((item) => item.id === 'ring')!
          .placement.type,
      ).toBe('carried')
      expect(fallback).not.toHaveBeenCalled()
    },
  )

  it('supports click activation, multiple physical keys, and read-only inspection', async () => {
    const { game, scene, select, press } = await setup()
    select('cloak')
    game.actionBar!.activate(scene, 'commands', '1')
    select('replacement')
    press('Digit1')
    expect(game.inventory!.snapshot.find((item) => item.id === 'cloak')!.placement.type).toBe(
      'carried',
    )
    const readonly = await setup(true, true)
    readonly.select('cloak')
    expect(selectedItemDetails(readonly.scene, 'items')!.type.label).toBe('Cloak')
    expect(readonly.game.equipment!.isEnabled(readonly.scene, 'equipment', 'equip')).toBe(false)
    readonly.press('KeyQ')
    expect(
      readonly.game.inventory!.snapshot.find((item) => item.id === 'cloak')!.placement.type,
    ).toBe('inside')
  })
})

describe('item authoring and localization', () => {
  const project = () => ({
    revision: 'one',
    documents: {
      'game.json': manifest,
      'input/keys.json': controls,
      'inventory/items.json': {
        ...definition,
        itemTypes: {
          ...definition.itemTypes,
          cloak: {
            ...definition.itemTypes.cloak,
            extension: 'item',
            properties: definition.itemTypes.cloak!.properties.map((property) => ({
              ...property,
              extension: property.id,
            })),
          },
        },
      },
      ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
    },
  })

  it('localizes presentation without changing placements and falls back per key', () => {
    const source = inventorySchema.parse({
      ...definition,
      itemTypes: {
        ...definition.itemTypes,
        cloak: {
          ...definition.itemTypes.cloak,
          labelKey: 'name',
          descriptionKey: 'description',
          properties: [{ id: 'rarity', labelKey: 'rarity', value: '', valueKey: 'quality' }],
        },
      },
    })

    const localized = localizeInventory(source, {
      fallback: { name: 'Cloak', description: 'Warm', rarity: 'Rarity', quality: 'Common' },
      messages: { name: 'Mantel', rarity: 'Zeldzaamheid' },
    })

    expect(localized.itemTypes.cloak).toMatchObject({
      label: 'Mantel',
      description: 'Warm',
      properties: [{ label: 'Zeldzaamheid', value: 'Common' }],
    })
    expect(localized.items).toEqual(source.items)
    expect(() => localizeInventory(source)).toThrow('language')
    expect(() => localizeInventory(source, { fallback: {}, messages: {} })).toThrow('translation')
    expect(
      itemPresentationSchema.safeParse({
        label: 'Item',
        properties: [{ id: 'one', label: 'One', value: 1, valueKey: 'name' }],
      }).success,
    ).toBe(false)
  })

  it('preserves extension fields and actions when editing presentation and protects linked components and slots', () => {
    const initial = project()
    expect(validateProject(initial.documents)).toEqual([])

    const result = applyCommand(initial, {
      type: 'inventory.setItemPresentation',
      itemType: 'cloak',
      presentation: { ...definition.itemTypes.cloak!, description: 'Changed' },
    })

    const saved = object(object(result.project.documents['inventory/items.json']).itemTypes).cloak
    expect(saved).toMatchObject({
      extension: 'item',
      description: 'Changed',
      equipmentSlots: ['body'],
      properties: [
        expect.objectContaining({ extension: 'value' }),
        expect.objectContaining({ extension: 'effect' }),
      ],
    })
    expect(inspectProject(result.project).inventory!.itemTypes.cloak!.description).toBe('Changed')
    expect(() =>
      applyCommand(result.project, {
        type: 'scene.removeItemView',
        sceneId: 'first',
        componentId: 'equipment',
      }),
    ).toThrow('invalid project')
    expect(() =>
      applyCommand(result.project, {
        type: 'inventory.setEquipmentSlots',
        owner: 'other',
        slots: {},
      }),
    ).toThrow('invalid project')
    expect(() =>
      applyCommand(result.project, {
        type: 'scene.setInventoryDetails',
        sceneId: 'first',
        componentId: 'items',
        descriptionTarget: 'missing',
      }),
    ).toThrow('invalid project')
  })

  it('protects declared item property binding fields when updating rules', () => {
    const initial = project()

    const documents = {
      ...initial.documents,
      'game.json': { ...manifest, rules: ['values'] },
      'rules/values.json': { state: [{ path: ['missing'], value: 'Detail' }], actions: {} },
    }

    expect(() =>
      applyCommand(
        { ...initial, documents },
        { type: 'game.updateRules', ruleId: 'values', rules: { state: [], actions: {} } },
      ),
    ).toThrow('rule state field')
    expect(() =>
      applyCommand(
        { ...initial, documents },
        {
          type: 'game.updateRules',
          ruleId: 'values',
          rules: { state: [{ path: ['missing'], value: true }], actions: {} },
        },
      ),
    ).toThrow('text or numeric')
  })
})
