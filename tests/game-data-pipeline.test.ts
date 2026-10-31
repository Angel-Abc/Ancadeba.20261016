import { readFile } from 'node:fs/promises'
import {
  gameSchema,
  sceneSchema,
  type GameDefinition,
  type SceneDefinition,
} from '@ancadeba/schemas'
import {
  assembleGameData,
  Engine,
  GameLoader,
  type EngineMessages,
  type IEngineHost,
} from '@ancadeba/game-runtime'
import {
  JsonResourceLoader,
  MessageBus,
  type ILogger,
  type IResourceSource,
} from '@ancadeba/utilities'
import { describe, expect, it, vi } from 'vite-plus/test'

const definition: GameDefinition = {
  'schema-version': '1.0.0',
  id: 'basic-game',
  title: 'Basic Game',
  description: 'A basic game example',
  version: '1.0.0',
  scenes: ['start-screen'],
}
const scene: SceneDefinition = {
  'schema-version': '1.0.0',
  id: 'start-screen',
  title: 'Start Screen',
  description: 'The start screen of the game',
  type: 'stand-alone',
  screen: { type: 'grid', grid: { rows: 20, columns: 20 } },
  components: [],
}
const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
const runtime = { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } }

function createPipeline(
  files: Record<string, unknown> = {
    'game.json': definition,
    'scenes/start-screen.json': scene,
  },
) {
  const source = {
    readText: vi.fn<IResourceSource['readText']>(async (path) => {
      if (!(path in files)) throw new Error(`Missing resource: ${path}`)
      return JSON.stringify(files[path])
    }),
    readBytes: vi.fn<IResourceSource['readBytes']>(),
  }
  const loader = new GameLoader(new JsonResourceLoader(source, logger))
  const host = { mount: vi.fn<IEngineHost['mount']>(() => () => {}) }
  const engine = new Engine(loader, host, logger, () => new MessageBus<EngineMessages>(), runtime)
  return { source, loader, host, engine }
}

describe('game data pipeline', () => {
  it('loads the actual basic example into game data without a renderer', async () => {
    const source: IResourceSource = {
      readText: (path) =>
        readFile(new URL(`../sample-games/basic/${path}`, import.meta.url), 'utf8'),
      readBytes: async (path) =>
        new Uint8Array(await readFile(new URL(`../sample-games/basic/${path}`, import.meta.url))),
    }
    const game = await new GameLoader(new JsonResourceLoader(source, logger)).load()

    expect(game).toEqual({
      id: 'basic-game',
      title: 'Basic Game',
      description: 'A basic game example',
      version: '1.0.0',
      input: {
        virtualKeys: ['north', 'confirm'],
        keyboard: { KeyW: 'north', ArrowUp: 'north', Enter: 'confirm' },
        contexts: {
          gameplay: { north: 'moveNorth', confirm: 'interact' },
          menu: { north: 'selectPrevious', confirm: 'accept' },
        },
        initialContext: 'gameplay',
      },
      scenes: new Map([
        [
          'start-screen',
          {
            id: 'start-screen',
            title: 'Start Screen',
            description: 'The start screen of the game',
            type: 'stand-alone',
            screen: { type: 'grid', grid: { rows: 20, columns: 20 } },
            components: [],
          },
        ],
      ]),
    })
  })

  it('assembles scenes in manifest order without sharing mutable definition objects', () => {
    const first = sceneSchema.parse(scene)
    const second = sceneSchema.parse({ ...scene, id: 'second' })
    const game = assembleGameData(
      { ...definition, scenes: ['second', 'start-screen'] },
      new Map([
        ['start-screen', first],
        ['second', second],
      ]),
    )

    expect([...game.scenes.keys()]).toEqual(['second', 'start-screen'])
    first.screen.grid.rows = 1
    first.title = 'Changed'
    expect(game.scenes.get('start-screen')?.screen.grid.rows).toBe(20)
    expect(game.scenes.get('start-screen')?.title).toBe('Start Screen')
  })

  it('supports an empty scene collection without selecting an initial scene', async () => {
    const { loader, source } = createPipeline({ 'game.json': { ...definition, scenes: [] } })
    expect((await loader.load()).scenes.size).toBe(0)
    expect(source.readText).toHaveBeenCalledExactlyOnceWith('game.json')
  })

  it.each<[string, unknown]>([
    ['empty manifest', {}],
    ['unsupported version', { ...definition, 'schema-version': '2.0.0' }],
    ['empty title', { ...definition, title: ' ' }],
    ['invalid ID', { ...definition, id: '' }],
    ['invalid version', { ...definition, version: 123 }],
    ['duplicate references', { ...definition, scenes: ['start-screen', 'start-screen'] }],
    ...['../escape', 'a/b', 'a\\b', '%2e%2e', 'https:remote', '.', '..', ''].map(
      (id): [string, unknown] => [`unsafe scene reference ${id}`, { ...definition, scenes: [id] }],
    ),
  ])('rejects %s before reading any scene files', async (_reason, game) => {
    const { loader, source } = createPipeline({ 'game.json': game })
    await expect(loader.load()).rejects.toThrow('game.json')
    expect(source.readText).toHaveBeenCalledExactlyOnceWith('game.json')
  })

  it.each([
    ['unsupported version', { ...scene, 'schema-version': '2.0.0' }],
    ['unsupported scene type', { ...scene, type: 'other' }],
    ['unsupported screen type', { ...scene, screen: { type: 'canvas' } }],
    ['zero rows', { ...scene, screen: { type: 'grid', grid: { rows: 0, columns: 20 } } }],
    [
      'fractional columns',
      { ...scene, screen: { type: 'grid', grid: { rows: 20, columns: 1.5 } } },
    ],
    ['negative columns', { ...scene, screen: { type: 'grid', grid: { rows: 20, columns: -1 } } }],
    ['missing grid', { ...scene, screen: { type: 'grid' } }],
    ['unsupported components', { ...scene, components: [{ type: 'button' }] }],
  ])('rejects a scene with %s and never mounts partial data', async (_reason, invalidScene) => {
    const { engine, host } = createPipeline({
      'game.json': definition,
      'scenes/start-screen.json': invalidScene,
    })
    await expect(engine.start()).rejects.toThrow('scenes/start-screen.json')
    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()
    expect(host.mount).not.toHaveBeenCalled()
  })

  it('rejects a missing scene and a filename/ID mismatch', async () => {
    await expect(createPipeline({ 'game.json': definition }).loader.load()).rejects.toThrow(
      'scenes/start-screen.json',
    )
    const { loader } = createPipeline({
      'game.json': definition,
      'scenes/start-screen.json': { ...scene, id: 'other' },
    })
    await expect(loader.load()).rejects.toThrow('expected start-screen')
  })

  it('rejects malformed scene JSON', async () => {
    const { loader, source } = createPipeline()
    source.readText.mockImplementation(async (path) =>
      path === 'game.json' ? JSON.stringify(definition) : '{broken',
    )
    await expect(loader.load()).rejects.toBeInstanceOf(SyntaxError)
  })

  it('requires all scenes before mounting and publishing the assembled game', async () => {
    const { engine, host, source } = createPipeline()
    let finish!: (text: string) => void
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    source.readText.mockImplementation(async (path) =>
      path === 'game.json' ? JSON.stringify(definition) : pending,
    )
    const starting = engine.start()
    const started = vi.fn()
    engine.messages?.subscribe('engine.started', started)
    await vi.waitFor(() => expect(source.readText).toHaveBeenCalledWith('scenes/start-screen.json'))
    expect(engine.state).toBe('starting')
    expect(host.mount).not.toHaveBeenCalled()
    expect(engine.game).toBeUndefined()
    finish(JSON.stringify(scene))
    await starting
    engine.flushMessages()
    expect(engine.game?.scenes.get('start-screen')?.screen.grid.rows).toBe(20)
    expect(host.mount).toHaveBeenCalledExactlyOnceWith(engine.game, {
      input: undefined,
      messages: expect.anything(),
      timers: expect.anything(),
      actions: undefined,
      lifecycle: expect.anything(),
    })
    expect(started).toHaveBeenCalledExactlyOnceWith({ game: engine.game })
    engine.stop()
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a pending scene that completes with %s after restarting',
    async (completion) => {
      const { engine, source, host } = createPipeline()
      let finish!: (text: string) => void
      let fail!: (error: Error) => void
      const pending = new Promise<string>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      source.readText
        .mockImplementationOnce(async () => JSON.stringify(definition))
        .mockImplementationOnce(() => pending)
      const first = engine.start()
      await vi.waitFor(() =>
        expect(source.readText).toHaveBeenCalledWith('scenes/start-screen.json'),
      )
      engine.stop()
      await first
      await engine.start()
      const current = engine.game
      if (completion === 'resolve') finish(JSON.stringify({ ...scene, title: 'Stale' }))
      else fail(new Error('Stale scene failed'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(engine.game).toBe(current)
      expect(engine.game?.scenes.get('start-screen')?.title).toBe('Start Screen')
      expect(host.mount).toHaveBeenCalledTimes(1)
      engine.stop()
    },
  )

  it('checks cross-file relationships when assembling validated definitions directly', () => {
    expect(() => assembleGameData(definition, new Map())).toThrow('Missing scene definition')
    expect(() =>
      assembleGameData(
        { ...definition, scenes: ['start-screen', 'start-screen'] },
        new Map([['start-screen', scene]]),
      ),
    ).toThrow('Duplicate scene reference')
    expect(() =>
      assembleGameData(
        definition,
        new Map([
          ['start-screen', scene],
          ['extra', { ...scene, id: 'extra' }],
        ]),
      ),
    ).toThrow('unreferenced')
    expect(gameSchema.parse(definition).scenes).toEqual(['start-screen'])
  })
})
