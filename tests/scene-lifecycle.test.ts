import { describe, expect, it, vi } from 'vite-plus/test'
import { gameSchema, sceneSchema, type SceneDefinition } from '@ancadeba/schemas'
import {
  assembleGameData,
  Engine,
  GameLifecycle,
  GameLoader,
  type EngineMessages,
  type GameData,
  type IEngineHost,
} from '@ancadeba/game-runtime'
import {
  JsonResourceLoader,
  MessageBus,
  type ILogger,
  type IResourceSource,
} from '@ancadeba/utilities'

// Keep this lifecycle fixture independent of the user's sample game.
const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'lifecycle-game',
  title: 'Lifecycle Game',
  description: 'Two game scenes and one independent scene',
  version: '1.0.0',
  scenes: ['standard', 'inventory', 'settings'],
})
const definitions = new Map<string, SceneDefinition>(
  manifest.scenes.map((id) => [
    id,
    sceneSchema.parse({
      'schema-version': '1.0.0',
      id,
      title: id,
      description: '',
      type: id === 'settings' ? 'stand-alone' : 'game',
      screen: { type: 'grid', grid: { rows: 20, columns: 20 } },
      components: [],
    }),
  ]),
)

interface PlayState {
  score: number
  locations: Map<string, { doorOpen: boolean }>
}

interface LocalState {
  selected: number
}

const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
const timing = { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } }

function content(): GameData {
  return assembleGameData(manifest, definitions)
}

function createLifecycle(data = content()) {
  const factories = {
    createGameState: vi.fn((): PlayState => ({ score: 0, locations: new Map() })),
    createSceneState: vi.fn((): LocalState => ({ selected: 0 })),
    disposeGameState: vi.fn<(state: PlayState) => void>(),
    disposeSceneState: vi.fn<(state: LocalState) => void>(),
  }
  return { lifecycle: new GameLifecycle(data, factories), factories, data }
}

describe('game and scene lifetimes', () => {
  it('loads both game scenes and the stand-alone scene through the JSON pipeline', async () => {
    const files = new Map<string, unknown>([
      ['game.json', manifest],
      ...[...definitions].map(([id, definition]): [string, unknown] => [
        `scenes/${id}.json`,
        definition,
      ]),
    ])
    const source: IResourceSource = {
      readText: async (path) => {
        if (!files.has(path)) throw new Error(`Missing fixture: ${path}`)
        return JSON.stringify(files.get(path))
      },
      readBytes: async () => new Uint8Array(),
    }
    const data = await new GameLoader(new JsonResourceLoader(source, logger)).load()
    const { lifecycle } = createLifecycle(data)

    expect([...data.scenes.values()].map(({ id, type }) => [id, type])).toEqual([
      ['standard', 'game'],
      ['inventory', 'game'],
      ['settings', 'stand-alone'],
    ])
    expect(lifecycle.currentGame).toBeUndefined()
    expect(lifecycle.activeScene).toBeUndefined()
  })

  it('runs a stand-alone scene without creating or exposing a current game', () => {
    const { lifecycle, factories } = createLifecycle()
    const settings = lifecycle.enterScene('settings')

    expect(settings.type).toBe('stand-alone')
    expect(settings).not.toHaveProperty('game')
    expect(settings.state).toEqual({ selected: 0 })
    expect(lifecycle.currentGame).toBeUndefined()
    expect(factories.createGameState).not.toHaveBeenCalled()
    settings.state!.selected = 3
    lifecycle.leaveScene()
    expect(settings.disposed).toBe(true)
    expect(settings.state).toBeUndefined()
    expect(lifecycle.enterScene('settings').state).toEqual({ selected: 0 })
  })

  it('preserves the playthrough across two game scenes and an independent scene', () => {
    const { lifecycle, factories, data } = createLifecycle()
    const game = lifecycle.startGame()
    const standard = lifecycle.enterScene('standard')
    expect(standard.type).toBe('game')
    if (standard.type !== 'game') throw new Error('Expected a game scene')
    expect(standard.game).toBe(game)
    game.state!.score = 12
    game.state!.locations.set('village', { doorOpen: true })
    standard.state!.selected = 4
    const localState = standard.state

    const inventory = lifecycle.enterScene('inventory')
    expect(inventory.type).toBe('game')
    if (inventory.type !== 'game') throw new Error('Expected a game scene')
    expect(inventory.game).toBe(game)
    expect(inventory.game.state!.score).toBe(12)
    expect(inventory.state).toEqual({ selected: 0 })
    expect(standard.disposed).toBe(true)
    expect(standard.state).toBeUndefined()
    expect(factories.disposeSceneState).toHaveBeenCalledExactlyOnceWith(localState)

    const settings = lifecycle.enterScene('settings')
    expect(settings).not.toHaveProperty('game')
    expect(lifecycle.currentGame).toBe(game)
    expect(game.disposed).toBe(false)
    expect(inventory.disposed).toBe(true)

    const returned = lifecycle.enterScene('standard')
    expect(returned).not.toBe(standard)
    expect(returned.state).toEqual({ selected: 0 })
    expect(settings.disposed).toBe(true)
    expect(lifecycle.currentGame?.state?.locations.get('village')).toEqual({ doorOpen: true })
    expect(factories.createGameState).toHaveBeenCalledExactlyOnceWith(data)
    expect(game.data).toBe(data)
    expect(returned.data).toBe(data.scenes.get('standard'))
    expect(data).toEqual(content())
  })

  it('rejects invalid scene entry without discarding the existing scene or game', () => {
    const { lifecycle, factories } = createLifecycle()
    const settings = lifecycle.enterScene('settings')

    expect(() => lifecycle.enterScene('standard')).toThrow('requires a current game')
    expect(() => lifecycle.enterScene('inventory')).toThrow('requires a current game')
    expect(() => lifecycle.enterScene('missing')).toThrow('Unknown scene')
    expect(lifecycle.activeScene).toBe(settings)
    expect(settings.disposed).toBe(false)
    expect(factories.createSceneState).toHaveBeenCalledTimes(1)

    const game = lifecycle.startGame()
    expect(() => lifecycle.enterScene('missing')).toThrow('Unknown scene')
    expect(lifecycle.currentGame).toBe(game)
    expect(lifecycle.activeScene).toBe(settings)
  })

  it('keeps redundant entry and explicit scene exit from resetting the playthrough', () => {
    const { lifecycle, factories } = createLifecycle()
    const game = lifecycle.startGame()
    const scene = lifecycle.enterScene('standard')
    scene.state!.selected = 2

    expect(lifecycle.enterScene('standard')).toBe(scene)
    expect(scene.state?.selected).toBe(2)
    expect(factories.createSceneState).toHaveBeenCalledTimes(1)
    lifecycle.leaveScene()
    lifecycle.leaveScene()
    expect(lifecycle.activeScene).toBeUndefined()
    expect(lifecycle.currentGame).toBe(game)
    expect(scene.disposed).toBe(true)
    expect(factories.disposeSceneState).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh playthrough and disposes the previous game and its active scene', () => {
    const { lifecycle, factories, data } = createLifecycle()
    const previous = lifecycle.startGame()
    previous.state!.score = 12
    const previousState = previous.state
    const scene = lifecycle.enterScene('inventory')

    const next = lifecycle.startGame()

    expect(next).not.toBe(previous)
    expect(next.state).toEqual({ score: 0, locations: new Map() })
    expect(next.data).toBe(data)
    expect(previous.disposed).toBe(true)
    expect(previous.state).toBeUndefined()
    expect(scene.disposed).toBe(true)
    expect(lifecycle.activeScene).toBeUndefined()
    expect(factories.disposeGameState).toHaveBeenCalledExactlyOnceWith(previousState)
  })

  it('ends a game without unloading definitions and allows a fresh game afterward', () => {
    const { lifecycle, factories, data } = createLifecycle()
    const game = lifecycle.startGame()
    const scene = lifecycle.enterScene('standard')
    lifecycle.endGame()
    lifecycle.endGame()

    expect(lifecycle.currentGame).toBeUndefined()
    expect(lifecycle.activeScene).toBeUndefined()
    expect(game.disposed).toBe(true)
    expect(scene.disposed).toBe(true)
    expect(factories.disposeGameState).toHaveBeenCalledTimes(1)
    expect(factories.disposeSceneState).toHaveBeenCalledTimes(1)
    expect(() => lifecycle.enterScene('inventory')).toThrow('requires a current game')
    expect(lifecycle.startGame().data).toBe(data)
    expect(lifecycle.enterScene('inventory').disposed).toBe(false)
  })

  it('keeps a stand-alone scene alive when a game is started, replaced, or ended', () => {
    const { lifecycle } = createLifecycle()
    const settings = lifecycle.enterScene('settings')
    settings.state!.selected = 2
    const first = lifecycle.startGame()
    const second = lifecycle.startGame()
    lifecycle.endGame()

    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(true)
    expect(lifecycle.activeScene).toBe(settings)
    expect(settings.disposed).toBe(false)
    expect(settings.state?.selected).toBe(2)
  })

  it('preserves live contexts if a replacement state factory fails', () => {
    const { lifecycle, factories } = createLifecycle()
    const game = lifecycle.startGame()
    const scene = lifecycle.enterScene('standard')
    factories.createGameState.mockImplementationOnce(() => {
      throw new Error('Cannot create game state')
    })
    factories.createSceneState.mockImplementationOnce(() => {
      throw new Error('Cannot create scene state')
    })

    expect(() => lifecycle.startGame()).toThrow('Cannot create game state')
    expect(() => lifecycle.enterScene('inventory')).toThrow('Cannot create scene state')
    expect(lifecycle.currentGame).toBe(game)
    expect(lifecycle.activeScene).toBe(scene)
    expect(game.disposed).toBe(false)
    expect(scene.disposed).toBe(false)
  })

  it('releases both scopes even when cleanup fails, and permits a new game', () => {
    const sceneError = new Error('Scene cleanup failed')
    const gameError = new Error('Game cleanup failed')
    const { lifecycle, factories } = createLifecycle()
    factories.disposeSceneState.mockImplementationOnce(() => {
      throw sceneError
    })
    factories.disposeGameState.mockImplementationOnce(() => {
      throw gameError
    })
    const game = lifecycle.startGame()
    const scene = lifecycle.enterScene('standard')

    let failure: unknown
    try {
      lifecycle.endGame()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([sceneError, gameError])
    expect(lifecycle.currentGame).toBeUndefined()
    expect(lifecycle.activeScene).toBeUndefined()
    expect(game.disposed).toBe(true)
    expect(scene.disposed).toBe(true)
    expect(lifecycle.startGame().disposed).toBe(false)
  })

  it('disposes the whole lifecycle once and rejects use of a stale lifecycle', () => {
    const { lifecycle, factories } = createLifecycle()
    const game = lifecycle.startGame()
    const settings = lifecycle.enterScene('settings')
    lifecycle.dispose()
    lifecycle.dispose()

    expect(lifecycle.disposed).toBe(true)
    expect(game.state).toBeUndefined()
    expect(settings.state).toBeUndefined()
    expect(lifecycle.currentGame).toBeUndefined()
    expect(lifecycle.activeScene).toBeUndefined()
    expect(factories.disposeGameState).toHaveBeenCalledTimes(1)
    expect(factories.disposeSceneState).toHaveBeenCalledTimes(1)
    expect(() => lifecycle.startGame()).toThrow('disposed')
    expect(() => lifecycle.enterScene('settings')).toThrow('disposed')
    expect(() => lifecycle.leaveScene()).toThrow('disposed')
    expect(() => lifecycle.endGame()).toThrow('disposed')
  })

  it('prevents factories and cleanup from making overlapping transitions', () => {
    const { lifecycle, factories } = createLifecycle()
    factories.createGameState.mockImplementationOnce(() => {
      lifecycle.enterScene('settings')
      return { score: 0, locations: new Map() }
    })
    expect(() => lifecycle.startGame()).toThrow('already in progress')
    expect(lifecycle.currentGame).toBeUndefined()

    lifecycle.startGame()
    lifecycle.enterScene('standard')
    factories.disposeSceneState.mockImplementationOnce(() => lifecycle.startGame())
    expect(() => lifecycle.endGame()).toThrow('Lifecycle cleanup failed')
    expect(lifecycle.currentGame).toBeUndefined()
    expect(lifecycle.activeScene).toBeUndefined()
    expect(factories.disposeGameState).toHaveBeenCalledTimes(1)
  })
})

describe('engine-owned game lifecycle', () => {
  function createEngine(host?: IEngineHost) {
    const lifecycles: ReturnType<typeof createLifecycle>[] = []
    const cleanup = vi.fn()
    const mount = vi.fn<IEngineHost['mount']>(() => cleanup)
    const engine = new Engine(
      { load: async () => content() },
      host ?? { mount },
      logger,
      () => new MessageBus<EngineMessages>(),
      {
        ...timing,
        createGameLifecycle(data) {
          const created = createLifecycle(data)
          lifecycles.push(created)
          return created.lifecycle
        },
      },
    )
    return { engine, lifecycles, mount, cleanup }
  }

  it('shares the lifecycle with the host and recreates it on engine restart', async () => {
    const { engine, lifecycles, mount } = createEngine()
    expect(engine.lifecycle).toBeUndefined()
    const starting = engine.start()
    expect(engine.lifecycle).toBeUndefined()
    await starting
    const lifecycle = lifecycles[0]!.lifecycle
    expect(engine.lifecycle).toBe(lifecycle)
    expect(mount.mock.calls[0]?.[1].lifecycle).toBe(lifecycle)
    expect(lifecycle.currentGame).toBeUndefined()
    expect(lifecycle.activeScene).toBeUndefined()
    const game = lifecycle.startGame()
    lifecycle.enterScene('standard')
    lifecycle.enterScene('inventory')
    lifecycle.enterScene('settings')

    engine.stop()
    expect(engine.lifecycle).toBeUndefined()
    expect(lifecycle.disposed).toBe(true)
    expect(game.disposed).toBe(true)
    await engine.start()
    expect(engine.lifecycle).not.toBe(lifecycle)
    expect(engine.lifecycle?.currentGame).toBeUndefined()
    expect(engine.lifecycle?.activeScene).toBeUndefined()
    expect(engine.game?.scenes.size).toBe(3)
    engine.stop()
  })

  it('provides a default lifecycle without requiring application state factories', async () => {
    const engine = new Engine(
      { load: async () => content() },
      { mount: () => () => {} },
      logger,
      () => new MessageBus<EngineMessages>(),
      timing,
    )
    await engine.start()
    const lifecycle = engine.lifecycle!
    const game = lifecycle.startGame()
    lifecycle.enterScene('standard')
    lifecycle.enterScene('inventory')
    lifecycle.enterScene('settings')
    expect(lifecycle.currentGame).toBe(game)
    expect(game.disposed).toBe(false)
    expect(game.state).toBeUndefined()
    engine.stop()
    expect(game.disposed).toBe(true)
    expect(lifecycle.disposed).toBe(true)
  })

  it('completes disposal when a state factory stops the engine', async () => {
    const { engine, lifecycles, cleanup } = createEngine()
    await engine.start()
    const { lifecycle, factories } = lifecycles[0]!
    factories.createGameState.mockImplementationOnce(() => {
      engine.stop()
      return { score: 0, locations: new Map() }
    })

    const game = lifecycle.startGame()

    expect(engine.state).toBe('stopped')
    expect(engine.lifecycle).toBeUndefined()
    expect(lifecycle.disposed).toBe(true)
    expect(game.disposed).toBe(true)
    expect(game.state).toBeUndefined()
    expect(factories.disposeGameState).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('disposes a lifecycle returned after its factory stops the engine', async () => {
    const created = createLifecycle()
    const mount = vi.fn<IEngineHost['mount']>(() => () => {})
    const engine = new Engine(
      { load: async () => created.data },
      { mount },
      logger,
      () => new MessageBus<EngineMessages>(),
      {
        ...timing,
        createGameLifecycle() {
          created.lifecycle.startGame()
          created.lifecycle.enterScene('settings')
          engine.stop()
          return created.lifecycle
        },
      },
    )

    await engine.start()

    expect(engine.state).toBe('stopped')
    expect(mount).not.toHaveBeenCalled()
    expect(created.lifecycle.disposed).toBe(true)
    expect(created.factories.disposeGameState).toHaveBeenCalledTimes(1)
    expect(created.factories.disposeSceneState).toHaveBeenCalledTimes(1)
  })

  it('releases scene and game state even if mounting fails', async () => {
    const { engine, lifecycles } = createEngine({
      mount(_data, session) {
        session.lifecycle.startGame()
        session.lifecycle.enterScene('standard')
        throw new Error('Mount failed')
      },
    })
    await expect(engine.start()).rejects.toThrow('Mount failed')
    expect(engine.state).toBe('stopped')
    expect(engine.lifecycle).toBeUndefined()
    expect(lifecycles[0]?.lifecycle.disposed).toBe(true)
    expect(lifecycles[0]?.factories.disposeGameState).toHaveBeenCalledTimes(1)
    expect(lifecycles[0]?.factories.disposeSceneState).toHaveBeenCalledTimes(1)
  })

  it('still unmounts the host when lifecycle cleanup fails', async () => {
    const { engine, lifecycles, cleanup } = createEngine()
    await engine.start()
    const { lifecycle, factories } = lifecycles[0]!
    lifecycle.startGame()
    lifecycle.enterScene('settings')
    factories.disposeSceneState.mockImplementationOnce(() => {
      throw new Error('Cleanup failed')
    })

    expect(() => engine.stop()).toThrow('Lifecycle cleanup failed')
    expect(engine.state).toBe('stopped')
    expect(lifecycle.disposed).toBe(true)
    expect(factories.disposeGameState).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('reports both lifecycle and host cleanup errors after releasing the session', async () => {
    const { engine, lifecycles, cleanup } = createEngine()
    await engine.start()
    const { lifecycle, factories } = lifecycles[0]!
    lifecycle.startGame()
    const stateError = new Error('State cleanup failed')
    const hostError = new Error('Host cleanup failed')
    factories.disposeGameState.mockImplementationOnce(() => {
      throw stateError
    })
    cleanup.mockImplementationOnce(() => {
      throw hostError
    })

    let failure: unknown
    try {
      engine.stop()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors as unknown[]
    expect(errors[0]).toBeInstanceOf(AggregateError)
    expect((errors[0] as AggregateError).errors).toEqual([stateError])
    expect(errors[1]).toBe(hostError)
    expect(engine.state).toBe('stopped')
    expect(lifecycle.disposed).toBe(true)
    expect(() => engine.stop()).not.toThrow()
  })

  it('isolates playthrough and scene state between engine instances', async () => {
    const first = createEngine()
    const second = createEngine()
    await Promise.all([first.engine.start(), second.engine.start()])
    const firstLifecycle = first.lifecycles[0]!.lifecycle
    const secondLifecycle = second.lifecycles[0]!.lifecycle
    firstLifecycle.startGame().state!.score = 12
    secondLifecycle.startGame()
    firstLifecycle.enterScene('standard').state!.selected = 2
    secondLifecycle.enterScene('inventory')

    expect(secondLifecycle.currentGame?.state?.score).toBe(0)
    expect(secondLifecycle.activeScene?.state?.selected).toBe(0)
    first.engine.stop()
    expect(secondLifecycle.disposed).toBe(false)
    expect(secondLifecycle.currentGame?.disposed).toBe(false)
    expect(secondLifecycle.activeScene?.disposed).toBe(false)
    second.engine.stop()
  })
})
