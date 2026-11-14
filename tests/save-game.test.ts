import { readFile } from 'node:fs/promises'
import {
  Engine,
  GameLoader,
  maxGameSaveBytes,
  type EngineMessages,
  type GameSaveLocation,
  type GameSaveSlotId,
  type GameSaveStore,
} from '@ancadeba/game-runtime'
import { gameSaveSchema, gameSchema, sceneSchema, mapDefinitionSchema } from '@ancadeba/schemas'
import { JsonResourceLoader, MessageBus, type ILogger } from '@ancadeba/utilities'
import { BrowserGameSaveStore } from '@ancadeba/ui-components'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'

class MemorySaves implements GameSaveStore {
  readonly slots = new Map<string, string>()
  read(id: string, slot: GameSaveLocation = '1') {
    return this.slots.get(`${id}:${slot}`)
  }
  write(id: string, save: string, slot: GameSaveLocation = '1') {
    this.slots.set(`${id}:${slot}`, save)
  }
  remove(id: string, slot: GameSaveSlotId = '1') {
    this.slots.delete(`${id}:${slot}`)
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

  return { engine, start, advance, logError, tasks }
}

describe('persistent player progress', () => {
  it.each(['1', '2', '3', '4', '5'] as const)(
    'deletes only manual slot %s and keeps the active game, autosave and other slots intact',
    async (selected) => {
      const store = new MemorySaves()
      const { engine, start, advance } = await launch(store)
      const current = start()
      const scene = engine.lifecycle!.activeScene
      const saves = engine.saves!
      expect(saves.canDelete).toBe(false)

      for (const slot of ['1', '2', '3', '4', '5'] as const) {
        saves.selectSlot(slot)
        expect(saves.save(`Save ${slot}`)).toBe(true)
      }

      advance(500)
      const before = new Map(store.slots)
      saves.selectSlot(selected)

      const changed = vi.fn(() => {
        expect(saves.delete()).toBe(false)
      })

      const unsubscribe = saves.subscribe(changed)
      expect(saves.canDelete).toBe(true)
      expect(saves.delete()).toBe(true)
      unsubscribe()
      expect(changed).toHaveBeenCalledTimes(1)
      expect(saves.status).toBe('deleted')
      expect(saves.error).toBeUndefined()
      expect(saves.canDelete).toBe(false)
      expect(saves.canLoad).toBe(false)
      expect(saves.selectedSlot).toBe(selected)
      expect(saves.slots.find(({ id }) => id === selected)).toMatchObject({
        occupied: false,
        name: '',
      })
      expect(engine.lifecycle!.currentGame).toBe(current)
      expect(engine.lifecycle!.activeScene).toBe(scene)
      before.delete(`basic-game:${selected}`)
      expect(store.slots).toEqual(before)
      advance(30_000)
      advance(500)
      expect(store.read('basic-game', selected)).toBeUndefined()
      const second = await launch(store)
      second.engine.saves!.selectSlot(selected)
      expect(second.engine.saves!.canLoad).toBe(false)
      expect(saves.save('Replacement')).toBe(true)
      expect(saves.slots.find(({ id }) => id === selected)?.name).toBe('Replacement')
      engine.stop()
      expect(saves.delete()).toBe(false)
      expect(saves.canDelete).toBe(false)
      expect(store.read('basic-game', selected)).toBeDefined()
    },
  )

  it('clears damaged and incompatible slots from the menu without loading them', async () => {
    const store = new MemorySaves()
    const { engine } = await launch(store)
    const saves = engine.saves!

    for (const text of ['{', JSON.stringify({ 'save-version': 999, gameId: 'other' })]) {
      store.write('basic-game', text)
      expect(saves.canDelete).toBe(true)
      expect(saves.delete()).toBe(true)
      expect(store.read('basic-game')).toBeUndefined()
      expect(engine.lifecycle!.currentGame).toBeUndefined()
      expect(engine.lifecycle!.activeScene!.data.id).toBe('start-screen')
    }
  })

  it.each(['blocked', 'unsupported'] as const)(
    'reports %s deletion without removing saved or current progress',
    async (failure) => {
      const store = new MemorySaves()

      const { engine, start, advance } = await launch({
        read: (id, slot) => store.read(id, slot),
        write: (id, text, slot) => store.write(id, text, slot),
        ...(failure === 'blocked'
          ? {
              remove: () => {
                throw new Error('Blocked')
              },
            }
          : {}),
      })

      const current = start()
      const saves = engine.saves!
      saves.save('Keep me')
      advance(500)
      const before = new Map(store.slots)
      expect(saves.canDelete).toBe(failure === 'blocked')
      expect(saves.delete()).toBe(false)
      expect(saves.status).toBe('error')
      expect(saves.error).toBe(failure === 'blocked' ? 'storage' : 'delete-unavailable')
      expect(saves.autosaveStatus).toBe('saved')
      expect(store.slots).toEqual(before)
      expect(engine.lifecycle!.currentGame).toBe(current)
    },
  )

  it('autosaves progress independently of all five manual slots and resumes after restart', async () => {
    const store = new MemorySaves()
    const { engine, start, advance } = await launch(store)
    advance(60_000)
    expect(store.read('basic-game', 'autosave')).toBeUndefined()
    start()
    const saves = engine.saves!
    const manual = new Map<string, string>()

    for (const slot of ['1', '2', '3', '4', '5'] as const) {
      saves.selectSlot(slot)
      expect(saves.save(`Manual ${slot}`)).toBe(true)
      manual.set(slot, store.read('basic-game', slot)!)
    }

    saves.selectSlot('3')
    const before = vi.fn()
    saves.subscribe(before)
    advance(499)
    expect(saves.canLoadAutosave).toBe(false)
    advance(1)
    expect(saves.canLoadAutosave).toBe(true)
    expect(saves.autosaveStatus).toBe('saved')
    expect(saves.status).toBe('idle')
    expect(saves.selectedSlot).toBe('3')
    engine.actions!.request('walk-east')
    advance()
    advance(500)
    const snapshot = gameSaveSchema.parse(JSON.parse(store.read('basic-game', 'autosave')!))
    expect(snapshot.scene).toBe('gallery')
    expect(snapshot.slotName).toBeUndefined()

    for (const slot of ['1', '2', '3', '4', '5'] as const)
      expect(store.read('basic-game', slot)).toBe(manual.get(slot))
    expect(before).toHaveBeenCalled()
    engine.stop()
    const second = await launch(store)
    expect(second.engine.saves!.canLoad).toBe(true)
    expect(second.engine.saves!.canLoadAutosave).toBe(true)
    second.engine.saves!.selectSlot('4')
    expect(second.engine.saves!.loadAutosave()).toBe(true)
    expect(second.engine.saves!.selectedSlot).toBe('4')
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('gallery')
    expect(store.read('basic-game', '4')).toBe(manual.get('4'))
  })

  it('autosaves completed movement and keeps the last checkpoint while a step is pending', async () => {
    const store = new MemorySaves()

    const mapData = mapDefinitionSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../sample-games/square-map/maps/coast.json', import.meta.url),
          'utf8',
        ),
      ),
    )

    const { engine, start, advance } = await launch(
      store,
      {
        'maps/coast.json': {
          ...mapData,
          terrain: Object.fromEntries(
            Object.entries(mapData.terrain).map(([id, terrain]) => [
              id,
              { ...terrain, movementCostMs: 1000 },
            ]),
          ),
        },
      },
      'square-map',
    )

    const game = start('coast')
    advance(500)

    const original = store.read(engine.game!.id, 'autosave')!
    const scene = engine.lifecycle!.activeScene!
    const movement = game.mapMovement!
    const map = scene.data.components.find((component) => component.type === 'map-view')!

    const direction = (['north', 'east', 'south', 'west'] as const).find((direction) =>
      movement.canMove(scene, map.id, direction),
    )!

    expect(movement.move(scene, map.id, direction)).toBe(true)
    advance(500)
    expect(movement.isMoving(scene, map.id)).toBe(true)
    expect(store.read(engine.game!.id, 'autosave')).toBe(original)
    expect(engine.saves!.autosaveError).toBeUndefined()
    advance(500)
    advance(500)
    const saved = gameSaveSchema.parse(JSON.parse(store.read(engine.game!.id, 'autosave')!))
    expect(saved.maps[map.id]).toEqual(movement.getPosition(scene, map.id))
    expect(store.read(engine.game!.id)).toBeUndefined()
  })

  it('keeps manual feedback and previous checkpoints on autosave errors and recovers', async () => {
    const store = new MemorySaves()
    let full = false

    const { engine, start, advance } = await launch({
      read: (id, slot) => store.read(id, slot),
      write: (id, text, slot) => {
        if (full && slot === 'autosave') throw new Error('Quota exceeded')
        store.write(id, text, slot)
      },
    })

    start()
    const saves = engine.saves!
    saves.save('Manual')
    advance(500)
    const original = store.read('basic-game', 'autosave')
    full = true
    engine.actions!.request('walk-east')
    advance()
    advance(500)
    expect(saves.autosaveStatus).toBe('error')
    expect(saves.autosaveError).toBe('storage')
    expect(saves.status).toBe('saved')
    expect(saves.error).toBeUndefined()
    expect(store.read('basic-game', 'autosave')).toBe(original)
    full = false
    advance(30_000)
    advance(500)
    expect(saves.autosaveStatus).toBe('saved')
    expect(saves.autosaveError).toBeUndefined()
    expect(gameSaveSchema.parse(JSON.parse(store.read('basic-game', 'autosave')!)).scene).toBe(
      'gallery',
    )
    expect(gameSaveSchema.parse(JSON.parse(store.read('basic-game')!)).scene).toBe('standard')
  })

  it('validates autosaves before loading and cancels old checkpoints on replacement and stop', async () => {
    const store = new MemorySaves()
    const { engine, start, advance, tasks } = await launch(store)
    const original = start()
    const saves = engine.saves!
    advance(500)
    const good = store.read('basic-game', 'autosave')!
    store.write('basic-game', '{', 'autosave')
    expect(saves.loadAutosave()).toBe(false)
    expect(saves.error).toBe('invalid-save')
    expect(engine.lifecycle!.currentGame).toBe(original)
    const incompatible = gameSaveSchema.parse(JSON.parse(good))
    incompatible.gameVersion = 'other'
    store.write('basic-game', JSON.stringify(incompatible), 'autosave')
    expect(saves.loadAutosave()).toBe(false)
    expect(saves.error).toBe('incompatible-save')
    store.write('basic-game', good, 'autosave')
    engine.actions!.request('walk-east')
    advance()
    start()
    advance(500)
    expect(gameSaveSchema.parse(JSON.parse(store.read('basic-game', 'autosave')!)).scene).toBe(
      'standard',
    )
    const checkpoint = store.read('basic-game', 'autosave')
    engine.actions!.request('walk-east')
    advance()
    const pending = [...tasks].map(({ callback }) => callback)
    engine.stop()

    for (const callback of pending) callback()
    advance(60_000)
    expect(store.read('basic-game', 'autosave')).toBe(checkpoint)
    expect(saves.loadAutosave()).toBe(false)
    expect(saves.canLoadAutosave).toBe(false)
  })

  it('periodically checkpoints changes without runtime notifications and leaves ended games alone', async () => {
    const store = new MemorySaves()
    const { engine, start, advance } = await launch(store)
    start()
    advance(500)
    engine.game!.localization!.select('nl')
    advance(30_000)
    advance(500)
    expect(gameSaveSchema.parse(JSON.parse(store.read('basic-game', 'autosave')!)).language).toBe(
      'nl',
    )
    const original = store.read('basic-game', 'autosave')
    engine.lifecycle!.endGame()
    advance(60_000)
    expect(store.read('basic-game', 'autosave')).toBe(original)
    // A new playthrough must enter a gameplay scene before it has a resume point.
    engine.lifecycle!.startGame()
    advance(60_000)
    expect(store.read('basic-game', 'autosave')).toBe(original)
  })

  it('keeps five named slots independent across new games and engine restarts', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    first.start()
    const saves = first.engine.saves!
    expect(saves.selectedSlot).toBe('1')
    expect(saves.slots).toHaveLength(5)
    expect(saves.selectSlot('6')).toBe(false)
    expect(saves.save('  Harbour  ')).toBe(true)
    const original = store.read('basic-game')
    expect(saves.slots[0]).toMatchObject({ name: 'Harbour', occupied: true })
    expect(saves.selectSlot('2')).toBe(true)
    expect(saves.canLoad).toBe(false)
    first.engine.lifecycle!.currentGame!.actions!.request('walk-east')
    expect(saves.save('Gallery')).toBe(true)
    expect(store.read('basic-game')).toBe(original)
    expect(saves.load()).toBe(true)
    expect(first.engine.lifecycle!.activeScene!.data.id).toBe('gallery')
    first.start()
    expect(saves.slots.filter(({ occupied }) => occupied)).toHaveLength(2)
    first.engine.stop()
    const second = await launch(store)
    expect(second.engine.saves!.load()).toBe(true)
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('standard')
    second.engine.saves!.selectSlot('2')
    expect(second.engine.saves!.load()).toBe(true)
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('gallery')
  })

  it('round-trips a portable file into a new store without loading or running candidate actions', async () => {
    const first = await launch(new MemorySaves())
    const game = first.start()
    game.leveling!.grantXp('player', 5)
    first.engine.game!.localization!.select('nl')
    expect(first.engine.saves!.save('Museum')).toBe(true)
    // Export contains the selected snapshot, not subsequent unsaved progress.
    game.actions!.request('walk-east')
    first.advance()
    const file = first.engine.saves!.exportFile()!
    expect(file.fileName).toBe('basic-game-slot-1.save.json')
    expect(gameSaveSchema.parse(JSON.parse(file.text)).scene).toBe('standard')
    const store = new MemorySaves()
    const second = await launch(store)
    const current = second.start()
    const scene = second.engine.lifecycle!.activeScene
    const saves = second.engine.saves!
    saves.selectSlot('5')
    current.actions!.request('walk-east')
    const changed = vi.fn()
    second.engine.lifecycle!.subscribeSceneChanges(changed)
    expect(saves.importFile(file.text)).toBe(true)
    expect(saves.status).toBe('imported')
    expect(changed).not.toHaveBeenCalled()
    expect(second.engine.lifecycle!.currentGame).toBe(current)
    expect(second.engine.lifecycle!.activeScene).toBe(scene)
    expect(second.engine.game!.language).toBe('en')
    expect(current.leveling!.snapshot('player')?.xp).toBe(0)
    expect(store.read('basic-game')).toBeUndefined()
    expect(saves.slots[4]?.name).toBe('Museum')
    second.advance()
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('gallery')
    expect(saves.load()).toBe(true)
    second.advance()
    expect(second.engine.lifecycle!.activeScene!.data.id).toBe('standard')
    expect(second.engine.game!.language).toBe('nl')
    expect(second.engine.lifecycle!.currentGame!.leveling!.snapshot('player')?.xp).toBe(5)
    expect(saves.save()).toBe(true)
    expect(saves.slots[4]?.name).toBe('Museum')
  })

  it('imports from the main menu and reports empty exports and invalid names', async () => {
    const store = new MemorySaves()
    const { engine, start } = await launch(store)
    const saves = engine.saves!
    expect(saves.canImport).toBe(true)
    expect(saves.exportFile()).toBeUndefined()
    expect(saves.error).toBe('unavailable')
    start()
    expect(saves.save('Original')).toBe(true)
    const original = store.read('basic-game')!
    expect(saves.save('x'.repeat(81))).toBe(false)
    expect(saves.error).toBe('invalid-name')
    expect(store.read('basic-game')).toBe(original)
    engine.lifecycle!.endGame()
    engine.lifecycle!.enterScene('start-screen')
    saves.selectSlot('3')
    expect(saves.importFile(original)).toBe(true)
    expect(engine.lifecycle!.currentGame).toBeUndefined()
    expect(engine.lifecycle!.activeScene!.data.id).toBe('start-screen')
    expect(saves.load()).toBe(true)
  })

  it('bounds UTF-8 file size before parsing and preserves saved and live progress', async () => {
    const store = new MemorySaves()
    const { engine, start } = await launch(store)
    const current = start()
    engine.saves!.save()
    const original = store.read('basic-game')
    // Under the limit in UTF-16 code units, over it in UTF-8 bytes.
    expect(engine.saves!.importFile('é'.repeat(maxGameSaveBytes / 2 + 1))).toBe(false)
    expect(engine.saves!.error).toBe('too-large')
    expect(store.read('basic-game')).toBe(original)
    expect(engine.lifecycle!.currentGame).toBe(current)
    const saves = engine.saves!
    engine.stop()
    expect(saves.importFile(original!)).toBe(false)
    expect(saves.exportFile()).toBeUndefined()
    expect(saves.selectSlot('2')).toBe(false)
  })

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

  describe.each(['manual', 'autosave'] as const)(
    '%s loading with observer failures',
    (location) => {
      async function savedGame() {
        const store = new MemorySaves()
        const launched = await launch(store)
        const { engine, start, advance, logError } = launched
        const old = start()
        const scene = engine.lifecycle!.activeScene!
        old.actions!.request('take-letter')
        advance()
        old.nearby!.select(scene, 'nearby', 'curator')
        old.inventorySelection!.select(scene, 'items', 'folded-letter')
        old.dialogue!.request(scene, 'nearby', { type: 'start' })
        advance()
        old.dialogue!.request(scene, 'nearby', { type: 'choose', position: 1 })
        advance()
        engine.game!.localization!.select('nl')
        const text = old.dialogue!.text(scene, 'nearby')
        const inventory = old.inventory!.snapshot
        const progression = old.actions!.progression
        const saves = engine.saves!
        saves.selectSlot('3')
        expect(saves.save('Before observer failure')).toBe(true)
        advance(500)
        const manual = store.read('basic-game', '3')!
        const autosave = store.read('basic-game', 'autosave')!
        expect(autosave).toBeDefined()
        engine.game!.localization!.select('en')
        engine.input!.setContext('menu')
        logError.mockClear()

        const load = () => (location === 'manual' ? saves.load() : saves.loadAutosave())

        const restored = () => {
          const current = engine.lifecycle!.currentGame!
          const active = engine.lifecycle!.activeScene!
          expect(old.disposed).toBe(true)
          expect(current).not.toBe(old)
          expect(active.data.id).toBe('standard')
          expect(active.type === 'game' && active.game).toBe(current)
          expect(current.inventory!.snapshot).toEqual(inventory)
          expect(current.actions!.progression).toEqual(progression)
          expect(current.quests!.snapshot('harbour-survey')!.status).toBe('active')
          expect(current.nearby!.getSelection(active, 'nearby')?.entry).toBe('curator')
          expect(current.inventorySelection!.get(active, 'items')?.item).toBe('folded-letter')
          expect(current.dialogue!.text(active, 'nearby')).toBe(text)
          expect(engine.game!.language).toBe('nl')
          expect(engine.input!.context).toBe('gameplay')
          expect(saves.status).toBe('loaded')
          expect(saves.error).toBeUndefined()
          expect(saves.selectedSlot).toBe('3')
          expect(store.read('basic-game', '3')).toBe(manual)
          expect(store.read('basic-game', 'autosave')).toBe(autosave)
        }

        return { ...launched, old, saves, store, load, restored }
      }

      it.each(['exit', 'entry', 'both'] as const)(
        'finishes every restore step after a scene observer throws during %s',
        async (phase) => {
          const { engine, load, restored, logError } = await savedGame()
          const failure = new Error('Scene observer failed')
          const events: (string | undefined)[] = []

          const unsubscribe = engine.lifecycle!.subscribeSceneChanges(({ current }) => {
            events.push(current?.data.id)

            if (phase === 'both' || (phase === 'exit' ? !current : current)) throw failure
          })

          const result = load()
          unsubscribe()
          expect(result).toBe(true)
          restored()
          expect(events).toEqual([undefined, 'standard'])
          expect(logError).toHaveBeenCalledTimes(phase === 'both' ? 2 : 1)
          expect(logError).toHaveBeenCalledWith(
            'GameSaves',
            'Save observer failed',
            expect.any(AggregateError),
          )
        },
      )

      it('finishes loading from a retained menu when entering the saved scene notifies a failing observer', async () => {
        const { engine, load, restored, logError } = await savedGame()
        engine.lifecycle!.enterScene('start-screen')

        const unsubscribe = engine.lifecycle!.subscribeSceneChanges(() => {
          throw new Error('Scene entry observer failed')
        })

        const result = load()
        unsubscribe()
        expect(result).toBe(true)
        restored()
        expect(logError).toHaveBeenCalledTimes(1)
      })

      it('completes later restoration steps when their observers throw after committing', async () => {
        const { engine, load, restored, logError } = await savedGame()
        const notified = new Set<string>()

        const fail = (step: string) => () => {
          notified.add(step)
          throw new Error(`${step} observer failed`)
        }

        const language = engine.game!.localization!.subscribe(fail('language'))
        const input = engine.input!.subscribeContextChanges(fail('input'))

        const scene = engine.lifecycle!.subscribeSceneChanges(({ current }) => {
          if (current?.type !== 'game') return
          current.game.nearby!.subscribeChanges(fail('nearby'))
          current.game.inventorySelection!.subscribe(fail('inventory'))
          current.game.dialogue!.subscribeChanges(fail('dialogue'))
          current.game.bindings!.subscribeChanges(fail('bindings'))
        })

        const result = load()
        language()
        input()
        scene()
        expect(result).toBe(true)
        restored()
        expect(notified).toEqual(
          new Set(['language', 'nearby', 'inventory', 'dialogue', 'bindings', 'input']),
        )
        expect(logError).toHaveBeenCalledWith(
          'GameSaves',
          'Save observer failed',
          expect.any(AggregateError),
        )
      })

      it.each(['stop', 'dispose', 'replace', 'change-scene'] as const)(
        'stops restoring a candidate when an observer requests %s',
        async (operation) => {
          const { engine, load, saves, old } = await savedGame()
          const lifecycle = engine.lifecycle!
          const input = engine.input!

          const unsubscribe = lifecycle.subscribeSceneChanges(({ current }) => {
            if (operation === 'dispose' && !current) lifecycle.dispose()

            if (current?.type !== 'game') return

            if (operation === 'stop') engine.stop()

            if (
              (operation === 'replace' || operation === 'change-scene') &&
              current.data.id === 'standard'
            )
              current.game.bindings!.subscribeChanges(() => {
                if (operation === 'replace') lifecycle.startGame()
                lifecycle.enterScene('gallery')
              })
          })

          const result = load()
          unsubscribe()
          expect(result).toBe(false)
          expect(saves.error).toBe('unavailable')
          expect(old.disposed).toBe(true)
          expect(input.context).toBe('menu')

          if (operation === 'stop') expect(engine.state).toBe('stopped')

          if (operation === 'dispose') expect(lifecycle.disposed).toBe(true)

          if (operation === 'replace' || operation === 'change-scene')
            expect(lifecycle.activeScene?.data.id).toBe('gallery')
        },
      )

      it('rejects invalid candidate state before notifying scene observers or replacing progress', async () => {
        const { engine, load, store, saves, old } = await savedGame()
        const slot = location === 'manual' ? '3' : 'autosave'
        const save = gameSaveSchema.parse(JSON.parse(store.read('basic-game', slot)!))
        save.state[0]!.value = false
        store.write('basic-game', JSON.stringify(save), slot)
        const active = engine.lifecycle!.activeScene

        const observer = vi.fn(() => {
          throw new Error('Must not notify')
        })

        const unsubscribe = engine.lifecycle!.subscribeSceneChanges(observer)
        const result = load()
        unsubscribe()
        expect(result).toBe(false)
        expect(saves.error).toBe('invalid-save')
        expect(engine.lifecycle!.currentGame).toBe(old)
        expect(engine.lifecycle!.activeScene).toBe(active)
        expect(old.disposed).toBe(false)
        expect(observer).not.toHaveBeenCalled()
      })
    },
  )

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

    const damaged =
      failure === 'bad-json'
        ? '{'
        : JSON.stringify(failure === 'unsupported-save' ? { ...save, 'save-version': 999 } : save)

    const original = store.read('basic-game')
    expect(engine.saves!.importFile(damaged)).toBe(false)
    expect(store.read('basic-game')).toBe(original)
    store.write('basic-game', damaged)
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
    const original = store.read('basic-game')
    expect(engine.saves!.importFile(JSON.stringify(save))).toBe(false)
    expect(engine.saves!.error).toBe('invalid-save')
    expect(store.read('basic-game')).toBe(original)
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
      removeItem: (key: string) => {
        slots.delete(key)
      },
    }

    const first = new BrowserGameSaveStore(() => storage, 'first')
    const second = new BrowserGameSaveStore(() => storage, 'second')
    first.write('game', 'progress')
    first.write('game', 'second progress', '2')
    first.write('game', 'automatic progress', 'autosave')
    expect(first.read('game')).toBe('progress')
    expect(first.read('game', '2')).toBe('second progress')
    expect(first.read('game', 'autosave')).toBe('automatic progress')
    expect(second.read('game', 'autosave')).toBeUndefined()
    expect(second.read('game', '2')).toBeUndefined()
    expect(first.read('game', '3')).toBeUndefined()
    expect(slots.get('ancadeba.save.first.game')).toBe('progress')
    expect(second.read('game')).toBeUndefined()
    expect(first.read('other')).toBeUndefined()
    second.write('game', 'other namespace', '2')
    first.write('other', 'other game', '2')
    first.remove('game', '2')
    expect(first.read('game', '2')).toBeUndefined()
    expect(first.read('game')).toBe('progress')
    expect(first.read('game', 'autosave')).toBe('automatic progress')
    expect(first.read('other', '2')).toBe('other game')
    expect(second.read('game', '2')).toBe('other namespace')
    first.remove('game')
    expect(first.read('game')).toBeUndefined()
    expect(first.read('game', 'autosave')).toBe('automatic progress')

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
    expect(engine.saves!.delete()).toBe(false)
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
      removeItem: (key) => {
        slots.delete(key)
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
    expect(engine.saves!.importFile(original!)).toBe(false)
    expect(engine.saves!.error).toBe('storage')
    expect(store.read('basic-game')).toBe(original)
    expect(engine.saves!.load()).toBe(true)
  })
})
