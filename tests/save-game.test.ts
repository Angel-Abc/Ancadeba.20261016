import { readFile } from 'node:fs/promises'
import { Engine, GameLoader, type EngineMessages, type GameSaveStore } from '@ancadeba/game-runtime'
import { gameSaveSchema, gameSchema, sceneSchema } from '@ancadeba/schemas'
import { JsonResourceLoader, MessageBus, type ILogger } from '@ancadeba/utilities'
import { BrowserGameSaveStore } from '@ancadeba/ui-components'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'

class MemorySaves implements GameSaveStore {
  readonly slots = new Map<string, string>()
  read(id: string) {
    return this.slots.get(id)
  }
  write(id: string, save: string) {
    this.slots.set(id, save)
  }
}

async function launch(
  store: GameSaveStore,
  overrides: Readonly<Record<string, unknown>> = {},
  sample = 'basic',
) {
  let time = 0
  const tasks = new Set<{ callback: () => void; due: number }>()

  const logError = vi.fn<ILogger['error']>(() => '')

  const logger: ILogger = {
    debug: () => '',
    info: () => '',
    warn: () => '',
    error: logError,
  }

  const engine = new Engine(
    new GameLoader(
      new JsonResourceLoader(
        {
          readText: (path) =>
            Object.hasOwn(overrides, path)
              ? Promise.resolve(JSON.stringify(overrides[path]))
              : readFile(new URL(`../sample-games/${sample}/${path}`, import.meta.url), 'utf8'),
          readBytes: async (path) =>
            new Uint8Array(
              await readFile(new URL(`../sample-games/${sample}/${path}`, import.meta.url)),
            ),
        },
        logger,
      ),
    ),
    { mount: () => () => {} },
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      saveStore: store,
      clock: { now: () => time },
      scheduler: {
        schedule(callback, delay) {
          const task = { callback, due: time + delay }
          tasks.add(task)

          return () => {
            tasks.delete(task)
          }
        },
      },
    },
  )

  const advance = (milliseconds = 0) => {
    time += milliseconds

    for (let count = 0; count < 1000; count++) {
      const task = [...tasks].find((task) => task.due <= time)

      if (!task) return
      tasks.delete(task)
      task.callback()
    }

    throw new Error('Messages did not settle')
  }

  await engine.start()
  advance()
  onTestFinished(() => engine.stop())

  const start = (scene = 'standard') => {
    engine.lifecycle!.startGame()
    engine.lifecycle!.enterScene(scene)
    advance()

    return engine.lifecycle!.currentGame!
  }

  return { engine, start, advance, logError }
}

describe('persistent player progress', () => {
  it('saves visited scene positions from a menu and restores them in a new engine', async () => {
    const manifest = gameSchema.parse(
      JSON.parse(
        await readFile(new URL('../sample-games/square-map/game.json', import.meta.url), 'utf8'),
      ),
    )

    const coast = sceneSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../sample-games/square-map/scenes/coast.json', import.meta.url),
          'utf8',
        ),
      ),
    )

    const overrides = {
      'game.json': { ...manifest, scenes: [...manifest.scenes, 'inland', 'menu'] },
      'scenes/inland.json': { ...coast, id: 'inland' },
      'scenes/menu.json': {
        'schema-version': '1.0.0',
        id: 'menu',
        title: 'Menu',
        type: 'stand-alone',
        screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
        components: [],
      },
    }

    const store = new MemorySaves()
    const first = await launch(store, overrides, 'square-map')
    const game = first.start('coast')
    const movement = game.mapMovement!
    const positions: Record<string, { x: number; y: number }> = {}

    for (const id of ['coast', 'inland']) {
      const scene = first.engine.lifecycle!.enterScene(id)

      const direction = (['north', 'east', 'south', 'west'] as const).find((direction) =>
        movement.canMove(scene, 'coast-map', direction),
      )!

      expect(movement.move(scene, 'coast-map', direction)).toBe(true)
      first.advance(1000)
      positions[id] = { ...movement.getPosition(scene, 'coast-map')! }
    }

    first.engine.lifecycle!.enterScene('menu')
    expect(first.engine.saves!.save()).toBe(true)
    first.engine.stop()
    const second = await launch(store, overrides, 'square-map')
    expect(second.engine.saves!.load()).toBe(true)
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('inland')

    for (const id of ['inland', 'coast']) {
      const scene = second.engine.lifecycle!.enterScene(id)
      expect(
        second.engine.lifecycle!.currentGame!.mapMovement!.getPosition(scene, 'coast-map'),
      ).toEqual(positions[id])
    }
  })

  it('restores a new engine from durable storage, including queued actions, inventory, state, time, log and language', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    expect(first.engine.saves?.canLoad).toBe(false)
    expect(first.engine.saves?.canSave).toBe(false)
    const game = first.start()
    game.actions!.request('walk-east')
    // Saving immediately must include work still in the message queue.
    expect(first.engine.saves!.save()).toBe(true)
    expect(first.engine.lifecycle!.activeScene!.data.id).toBe('gallery')
    first.engine.game!.localization!.select('nl')
    game.leveling!.grantXp('player', 5)
    expect(first.engine.saves!.save()).toBe(true)
    const save = gameSaveSchema.parse(JSON.parse(store.read('basic-game')!))
    first.engine.stop()
    const second = await launch(store)
    expect(second.engine.saves!.canLoad).toBe(true)
    expect(second.engine.saves!.load()).toBe(true)
    second.advance()
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('gallery')
    expect(second.engine.game!.language).toBe('nl')
    const resumed = second.engine.lifecycle!.currentGame!
    expect(resumed.bindings!.read({ source: 'game.state', path: ['clock'] })).toEqual({
      status: 'resolved',
      value: '09:01',
    })
    expect(resumed.inventory!.snapshot).toEqual(
      Object.entries(save.inventory).map(([id, item]) => ({ ...item, id })),
    )
    expect(resumed.actions!.progression).toEqual(save.progression)
    expect(resumed.leveling!.snapshot('player')).toMatchObject({ level: 2, xp: 5 })
    expect(second.engine.saves!.save()).toBe(true)
    const again = gameSaveSchema.parse(JSON.parse(store.read('basic-game')!))
    expect(again.state).toEqual(save.state)
    expect(again.log).toEqual(save.log)
  })

  it('restores map position, rejects saving during movement, and keeps the previous slot intact', async () => {
    const store = new MemorySaves()
    const { engine, start, advance } = await launch(store, {}, 'square-map')
    start('coast')
    const scene = engine.lifecycle!.activeScene!
    const movement = scene.type === 'game' ? scene.game.mapMovement! : undefined
    expect(movement).toBeDefined()
    const map = scene.data.components.find((component) => component.type === 'map-view')!
    expect(engine.saves!.save()).toBe(true)
    const original = store.read(engine.game!.id)

    const direction = (['north', 'east', 'south', 'west'] as const).find((direction) =>
      movement!.canMove(scene, map.id, direction),
    )!

    expect(movement!.move(scene, map.id, direction)).toBe(true)
    expect(engine.saves!.save()).toBe(false)
    expect(engine.saves!.error).toBe('busy')
    expect(store.read(engine.game!.id)).toBe(original)
    advance(1000)
    const position = movement!.getPosition(scene, map.id)
    const progression = engine.lifecycle!.currentGame!.actions!.progression
    expect(progression.turn).toBe(1)
    expect(progression.worldTimeMs).toBeGreaterThan(0)
    expect(engine.saves!.save()).toBe(true)
    engine.lifecycle!.startGame()
    engine.lifecycle!.enterScene('coast')
    expect(engine.saves!.load()).toBe(true)
    const restored = engine.lifecycle!.activeScene!
    expect(engine.lifecycle!.currentGame!.actions!.progression).toEqual(progression)
    expect(
      restored.type === 'game' && restored.game.mapMovement!.getPosition(restored, map.id),
    ).toEqual(position)
    const legacy = gameSaveSchema.parse(JSON.parse(store.read(engine.game!.id)!))
    delete legacy.mapPositions
    store.write(engine.game!.id, JSON.stringify(legacy))
    engine.lifecycle!.startGame()
    engine.lifecycle!.enterScene('coast')
    expect(engine.saves!.load()).toBe(true)
    const legacyScene = engine.lifecycle!.activeScene!
    expect(engine.lifecycle!.currentGame!.actions!.progression).toEqual(progression)
    expect(engine.lifecycle!.currentGame!.mapMovement!.getPosition(legacyScene, map.id)).toEqual(
      position,
    )
  })

  it('rejects a step whose turn would overflow without publishing a new position', async () => {
    const store = new MemorySaves()
    const { engine, start, advance, logError } = await launch(store, {}, 'square-map')
    start('coast')
    expect(engine.saves!.save()).toBe(true)
    const saved = gameSaveSchema.parse(JSON.parse(store.read(engine.game!.id)!))
    saved.progression.turn = Number.MAX_SAFE_INTEGER
    store.write(engine.game!.id, JSON.stringify(saved))
    expect(engine.saves!.load()).toBe(true)
    const scene = engine.lifecycle!.activeScene!
    const game = engine.lifecycle!.currentGame!
    const movement = game.mapMovement!
    const position = movement.getPosition(scene, 'coast-map')

    const direction = (['north', 'east', 'south', 'west'] as const).find((direction) =>
      movement.canMove(scene, 'coast-map', direction),
    )!

    movement.move(scene, 'coast-map', direction)
    advance(1000)
    expect(movement.getPosition(scene, 'coast-map')).toEqual(position)
    expect(game.actions!.progression).toEqual(saved.progression)
    expect(logError).toHaveBeenCalledWith(
      'MapMovement',
      'Movement progression could not be prepared',
      expect.any(RangeError),
    )
  })

  it('restores quest stages and an active conversation without replaying its effects or rewards', async () => {
    const store = new MemorySaves()
    const { engine, start, advance } = await launch(store)
    const game = start()
    const scene = engine.lifecycle!.activeScene!
    game.nearby!.select(scene, 'nearby', 'curator')
    game.dialogue!.request(scene, 'nearby', { type: 'start' })
    advance()
    game.dialogue!.request(scene, 'nearby', { type: 'choose', position: 1 })
    advance()
    expect(game.quests!.snapshot('harbour-survey')!.status).toBe('active')
    const text = game.dialogue!.text(scene, 'nearby')
    expect(engine.saves!.save()).toBe(true)
    engine.lifecycle!.startGame()
    expect(engine.saves!.load()).toBe(true)
    advance()
    const restored = engine.lifecycle!.currentGame!
    expect(restored.quests!.snapshot('harbour-survey')!.status).toBe('active')
    expect(restored.dialogue!.text(engine.lifecycle!.activeScene!, 'nearby')).toBe(text)
    engine.lifecycle!.enterScene('old-harbour')
    advance()
    expect(restored.quests!.snapshot('harbour-survey')!.stage).toBe('report')
    engine.lifecycle!.enterScene('standard')
    advance()
    restored.quests!.request(engine.lifecycle!.activeScene!, 'harbour-survey', 'turn-in')
    advance()
    expect(restored.quests!.snapshot('harbour-survey')!.status).toBe('completed')
    const gold = restored.bindings!.read({ source: 'game.state', path: ['player', 'gold'] })
    expect(engine.saves!.save()).toBe(true)
    expect(engine.saves!.load()).toBe(true)
    advance()
    expect(engine.lifecycle!.currentGame!.quests!.snapshot('harbour-survey')!.status).toBe(
      'completed',
    )
    expect(
      engine.lifecycle!.currentGame!.bindings!.read({
        source: 'game.state',
        path: ['player', 'gold'],
      }),
    ).toEqual(gold)
  })

  it('preserves combat plans, RNG, cooldowns, health, locks and progression when continuing a saved encounter', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    const game = first.start('training')
    const scene = first.engine.lifecycle!.activeScene!
    const component = scene.data.components.find((component) => component.type === 'combat')!
    game.combat!.snapshot(scene, component.id)
    game.combat!.selectTarget(scene, component.id, 'sentinel')
    game.combat!.request(scene, component.id, { type: 'queue-move', move: 'poison-strike' })
    first.advance()
    const before = game.combat!.snapshot(scene, component.id)
    expect(before!.plan.length).toBeGreaterThan(0)
    expect(first.engine.saves!.save()).toBe(true)
    game.combat!.request(scene, component.id, { type: 'end-turn' })
    first.advance()
    const expected = game.combat!.snapshot(scene, component.id)
    const expectedProgression = game.actions!.progression
    const second = await launch(store)
    expect(second.engine.saves!.load()).toBe(true)
    second.advance()
    const restored = second.engine.lifecycle!.currentGame!
    const restoredScene = second.engine.lifecycle!.activeScene!
    expect(restored.combat!.snapshot(restoredScene, component.id)).toEqual(before)
    expect(restored.combatStats!.snapshot('player')!.lockedBy).toBe('training')
    restored.combat!.request(restoredScene, component.id, { type: 'end-turn' })
    second.advance()
    expect(restored.combat!.snapshot(restoredScene, component.id)).toEqual(expected)
    expect(restored.actions!.progression).toEqual(expectedProgression)
  })

  it('retains queued consumable reservations and consumes the restored item only once', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    const game = first.start('training')
    const scene = first.engine.lifecycle!.activeScene!
    game.combat!.selectTarget(scene, 'combat', 'sentinel')
    game.combat!.request(scene, 'combat', { type: 'queue-item', item: 'flame-scroll-one' })
    first.advance()
    expect(game.inventory!.isReserved!('flame-scroll-one')).toBe(true)
    expect(first.engine.saves!.save()).toBe(true)
    const second = await launch(store)
    expect(second.engine.saves!.load()).toBe(true)
    second.advance()
    const restored = second.engine.lifecycle!.currentGame!
    const restoredScene = second.engine.lifecycle!.activeScene!
    expect(restored.inventory!.isReserved!('flame-scroll-one')).toBe(true)
    restored.combat!.request(restoredScene, 'combat', { type: 'end-turn' })
    second.advance()
    expect(restored.inventory!.snapshot.some(({ id }) => id === 'flame-scroll-one')).toBe(false)
    expect(second.engine.saves!.save()).toBe(true)
    expect(second.engine.saves!.load()).toBe(true)
    second.advance()
    expect(
      second.engine.lifecycle!.currentGame!.inventory!.snapshot.some(
        ({ id }) => id === 'flame-scroll-one',
      ),
    ).toBe(false)
  })

  it('does not duplicate victory rewards, loot or level gains after repeated loads', async () => {
    const store = new MemorySaves()

    const rules = JSON.parse(
      await readFile(new URL('../sample-games/basic/rules/combat.json', import.meta.url), 'utf8'),
    )

    const overrides = {
      'rules/combat.json': {
        ...rules,
        state: rules.state.map((field: { path: string[]; value: number }) => ({
          ...field,
          value: field.path[0] === 'combat' ? 1 : field.value,
        })),
      },
    }

    const { engine, start, advance } = await launch(store, overrides)
    const game = start('training')
    const scene = engine.lifecycle!.activeScene!

    for (const target of ['sentinel', 'keeper']) {
      game.combat!.selectTarget(scene, 'combat', target)
      game.combat!.request(scene, 'combat', { type: 'queue-move', move: 'heavy' })
      advance()
      game.combat!.request(scene, 'combat', { type: 'end-turn' })
      advance()
    }

    expect(game.combat!.snapshot(scene, 'combat')!.outcome).toBe('victory')
    expect(game.combatRewards!.snapshot(scene, 'combat')!.delivered).toBe(true)
    game.combat!.request(scene, 'combat', { type: 'take-all-loot' })
    advance()
    expect(engine.saves!.save()).toBe(true)
    const saved = store.read('basic-game')
    const inventory = game.inventory!.snapshot
    const progression = game.leveling!.snapshot('player')
    const gold = game.bindings!.read({ source: 'game.state', path: ['player', 'gold'] })

    for (let count = 0; count < 2; count++) {
      expect(engine.saves!.load()).toBe(true)
      advance()
      const restored = engine.lifecycle!.currentGame!
      expect(restored.inventory!.snapshot).toEqual(inventory)
      expect(restored.leveling!.snapshot('player')).toEqual(progression)
      expect(restored.bindings!.read({ source: 'game.state', path: ['player', 'gold'] })).toEqual(
        gold,
      )
      expect(
        restored.combatRewards!.snapshot(engine.lifecycle!.activeScene!, 'combat')!.remaining,
      ).toEqual([])
      expect(store.read('basic-game')).toBe(saved)
    }
  })

  it('resumes from the main menu, discards old queued actions on load, and leaves saved progress intact on New Game', async () => {
    const store = new MemorySaves()
    const { engine, start, advance, logError } = await launch(store)
    const game = start()
    game.actions!.request('walk-east')
    advance()
    engine.lifecycle!.enterScene('start-screen')
    expect(engine.saves!.save()).toBe(true)
    const original = store.read('basic-game')
    start()
    expect(store.read('basic-game')).toBe(original)
    const old = engine.lifecycle!.currentGame!
    old.actions!.request('walk-east')

    const listener = vi.fn(() => {
      throw new Error('Observer failure')
    })

    const unsubscribe = engine.saves!.subscribe(listener)
    expect(engine.saves!.load()).toBe(true)
    unsubscribe()
    advance()
    expect(old.disposed).toBe(true)
    expect(engine.lifecycle!.activeScene!.data.id).toBe('gallery')
    expect(logError).toHaveBeenCalled()
    const saves = engine.saves!
    engine.stop()
    expect(saves.load()).toBe(false)
    expect(saves.save()).toBe(false)
  })

  it.each([
    'bad-json',
    'wrong-game',
    'wrong-version',
    'bad-state',
    'bad-inventory',
    'bad-scene',
    'bad-quest',
    'bad-map',
    'bad-map-scene',
    'bad-inactive-map',
    'bad-dialogue',
    'bad-combat',
    'unsupported-save',
  ] as const)('rejects %s without replacing current progress', async (failure) => {
    const store = new MemorySaves()
    const { engine, start } = await launch(store)
    const current = start()
    expect(engine.saves!.save()).toBe(true)
    const save = gameSaveSchema.parse(JSON.parse(store.read('basic-game')!))

    if (failure === 'wrong-game') save.gameId = 'other'

    if (failure === 'wrong-version') save.gameVersion = '2'

    if (failure === 'bad-state') save.state[0]!.value = false

    if (failure === 'bad-inventory')
      save.inventory['fake'] = {
        itemType: 'unknown',
        placement: { type: 'carried', owner: 'player' },
        colors: {},
      }

    if (failure === 'bad-scene') save.scene = 'start-screen'

    if (failure === 'bad-quest')
      save.quests.records['harbour-survey'] = { index: 999, completed: false }

    if (failure === 'bad-map') save.maps['missing'] = { x: 0, y: 0 }

    if (failure === 'bad-map-scene') save.mapPositions = { missing: { map: { x: 0, y: 0 } } }

    if (failure === 'bad-inactive-map') save.mapPositions = { gallery: { missing: { x: 0, y: 0 } } }

    if (failure === 'bad-dialogue')
      save.dialogue['missing'] = {
        dialogue: 'missing',
        node: 'missing',
        page: 0,
        version: 0,
        finished: false,
        transcript: [],
      }

    if (failure === 'bad-combat')
      save.combat['missing'] = {
        round: 1,
        seed: 1,
        started: false,
        guard: {},
        plan: [],
        enemies: {},
        statuses: {},
        cooldowns: {},
        escape: false,
        log: [],
      }
    store.write(
      'basic-game',
      failure === 'bad-json'
        ? '{'
        : JSON.stringify(failure === 'unsupported-save' ? { ...save, 'save-version': 999 } : save),
    )
    expect(engine.saves!.load()).toBe(false)
    expect(engine.lifecycle!.currentGame).toBe(current)
    expect(current.disposed).toBe(false)
    expect(engine.lifecycle!.activeScene!.data.id).toBe('standard')
  })

  it.each([
    { path: ['player', 'health'], value: -1 },
    { path: ['player', 'health'], value: 41 },
    { path: ['player', 'health'], value: 1.5 },
    { path: ['player', 'maximumHealth'], value: 0 },
    { path: ['player', 'maximumHealth'], value: Number.MAX_SAFE_INTEGER + 1 },
    { path: ['player', 'experience'], value: -1 },
    { path: ['player', 'experience'], value: 5 },
    { path: ['player', 'level'], value: 2 },
    { path: ['combat', 'sentinel'], value: -1 },
    { path: ['combat', 'sentinel'], value: 19 },
  ])('rejects invalid saved $path = $value before replacing progress', async ({ path, value }) => {
    const store = new MemorySaves()
    const { engine, start } = await launch(store)
    const current = start()
    const scene = engine.lifecycle!.activeScene
    expect(engine.saves!.save()).toBe(true)
    const save = gameSaveSchema.parse(JSON.parse(store.read('basic-game')!))
    const field = save.state.find((field) => JSON.stringify(field.path) === JSON.stringify(path))!
    field.value = value
    store.write('basic-game', JSON.stringify(save))

    expect(engine.saves!.load()).toBe(false)
    expect(engine.saves!.error).toBe('invalid-save')
    expect(engine.lifecycle!.currentGame).toBe(current)
    expect(engine.lifecycle!.activeScene).toBe(scene)
    expect(current.disposed).toBe(false)
    expect(current.combatStats!.snapshot('player')?.health).toBe(40)
    expect(engine.saves!.save()).toBe(true)
  })

  it('accepts zero health and valid leveled stats when loading', async () => {
    const store = new MemorySaves()
    const { engine, start } = await launch(store)
    const current = start()
    current.leveling!.grantXp('player', 5)
    expect(engine.saves!.save()).toBe(true)
    const save = gameSaveSchema.parse(JSON.parse(store.read('basic-game')!))
    save.state.find(
      (field) => JSON.stringify(field.path) === JSON.stringify(['player', 'health']),
    )!.value = 0
    store.write('basic-game', JSON.stringify(save))

    expect(engine.saves!.load()).toBe(true)
    expect(engine.lifecycle!.currentGame!.combatStats!.snapshot('player')?.health).toBe(0)
    expect(engine.lifecycle!.currentGame!.leveling!.snapshot('player')).toMatchObject({
      available: true,
      level: 2,
      xp: 5,
    })
  })

  it('validates saved health against restored equipment bonuses', async () => {
    const inventory = JSON.parse(
      await readFile(
        new URL('../sample-games/basic/inventory/museum.json', import.meta.url),
        'utf8',
      ),
    )

    inventory.itemTypes['health-charm'] = {
      label: 'Health charm',
      equipmentSlots: ['charm'],
      combatBonuses: { maximumHealth: 10 },
    }
    inventory.items['health-charm'] = {
      itemType: 'health-charm',
      placement: { type: 'equipped', owner: 'player', slot: 'charm' },
    }
    const store = new MemorySaves()
    const { engine, start } = await launch(store, { 'inventory/museum.json': inventory })
    start()
    expect(engine.saves!.save()).toBe(true)
    const save = gameSaveSchema.parse(JSON.parse(store.read('basic-game')!))
    save.state.find(
      (field) => JSON.stringify(field.path) === JSON.stringify(['player', 'health']),
    )!.value = 50
    store.write('basic-game', JSON.stringify(save))

    expect(engine.saves!.load()).toBe(true)
    expect(engine.lifecycle!.currentGame!.combatStats!.snapshot('player')).toMatchObject({
      health: 50,
      total: { maximumHealth: 50 },
    })
    expect(engine.lifecycle!.currentGame!.leveling!.snapshot('player')?.available).toBe(true)
  })

  it('rejects changed content even if the game version has not been bumped', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    first.start()
    expect(first.engine.saves!.save()).toBe(true)

    const rules = JSON.parse(
      await readFile(new URL('../sample-games/basic/rules/rules.json', import.meta.url), 'utf8'),
    )

    const second = await launch(store, {
      'rules/rules.json': { ...rules, clock: { path: ['clock'], startMinute: 100 } },
    })

    expect(second.engine.saves!.load()).toBe(false)
    expect(second.engine.saves!.error).toBe('incompatible-save')
    expect(second.engine.lifecycle!.currentGame).toBeUndefined()
  })

  it('loads saved progress after catalog and translation-key edits', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    const game = first.start()
    game.leveling!.grantXp('player', 5)
    first.engine.game!.localization!.select('nl')
    expect(first.engine.saves!.save()).toBe(true)

    const en = JSON.parse(
      await readFile(
        new URL('../sample-games/basic/languages/en/messages.json', import.meta.url),
        'utf8',
      ),
    )

    const nl = JSON.parse(
      await readFile(
        new URL('../sample-games/basic/languages/nl/messages.json', import.meta.url),
        'utf8',
      ),
    )

    const inventory = JSON.parse(
      await readFile(
        new URL('../sample-games/basic/inventory/museum.json', import.meta.url),
        'utf8',
      ),
    )

    en['inventory.owner.renamed'] = 'Explorer'
    nl['inventory.owner.renamed'] = 'Ontdekkingsreiziger'
    inventory.owners.player.labelKey = 'inventory.owner.renamed'

    const second = await launch(store, {
      'languages/en/messages.json': en,
      'languages/nl/messages.json': nl,
      'inventory/museum.json': inventory,
    })

    expect(second.engine.saves!.load()).toBe(true)
    expect(second.engine.game!.language).toBe('nl')
    expect(second.engine.game!.inventory!.owners.player!.label).toBe('Ontdekkingsreiziger')
    expect(second.engine.lifecycle!.currentGame!.leveling!.snapshot('player')).toMatchObject({
      level: 2,
      xp: 5,
    })
  })

  it('uses the current language when a saved language has been removed', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    first.start()
    first.engine.game!.localization!.select('nl')
    expect(first.engine.saves!.save()).toBe(true)

    const manifest = JSON.parse(
      await readFile(new URL('../sample-games/basic/game.json', import.meta.url), 'utf8'),
    )

    manifest.languages.available = ['en']
    const second = await launch(store, { 'game.json': manifest })

    expect(second.engine.saves!.load()).toBe(true)
    expect(second.engine.game!.language).toBe('en')
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('standard')
  })

  it('rejects obsolete full-content fingerprints without replacing current progress', async () => {
    const store = new MemorySaves()
    const { engine, start } = await launch(store)
    const current = start()
    expect(engine.saves!.save()).toBe(true)
    const save = gameSaveSchema.parse(JSON.parse(store.read('basic-game')!))
    save.contentVersion = '0123456789abcdef'
    store.write('basic-game', JSON.stringify(save))
    expect(engine.saves!.load()).toBe(false)
    expect(engine.saves!.error).toBe('incompatible-save')
    expect(engine.lifecycle!.currentGame).toBe(current)
    expect(current.disposed).toBe(false)
  })

  it('reports blocked storage and keeps separate games and preview namespaces isolated', async () => {
    const slots = new Map<string, string>()

    const storage = {
      getItem: (key: string) => slots.get(key) ?? null,
      setItem: (key: string, value: string) => {
        slots.set(key, value)
      },
    }

    const first = new BrowserGameSaveStore(() => storage, 'first')
    const second = new BrowserGameSaveStore(() => storage, 'second')
    first.write('game', 'progress')
    expect(second.read('game')).toBeUndefined()
    expect(first.read('other')).toBeUndefined()

    const { engine, start } = await launch(
      new BrowserGameSaveStore(() => {
        throw new Error('Blocked')
      }),
    )

    start()
    expect(engine.saves!.save()).toBe(false)
    expect(engine.saves!.error).toBe('storage')
    expect(engine.saves!.load()).toBe(false)
    expect(engine.saves!.error).toBe('storage')
  })

  it('preserves the previous save when browser quota is exhausted', async () => {
    const slots = new Map<string, string>()
    let full = false

    const store = new BrowserGameSaveStore(() => ({
      getItem: (key) => slots.get(key) ?? null,
      setItem: (key, value) => {
        if (full) throw new Error('Quota exceeded')
        slots.set(key, value)
      },
    }))

    const { engine, start } = await launch(store)
    start()
    expect(engine.saves!.save()).toBe(true)
    const original = store.read('basic-game')
    full = true
    expect(engine.saves!.save()).toBe(false)
    expect(engine.saves!.error).toBe('storage')
    expect(store.read('basic-game')).toBe(original)
    expect(engine.saves!.load()).toBe(true)
  })
})
