import {
  Engine,
  GameLoader,
  type EngineMessages,
  type IEngine,
  type IEngineHost,
} from '@ancadeba/game-runtime'
import {
  JsonResourceLoader,
  MessageBus,
  type ILogger,
  type IMessageBus,
  type IResourceSource,
} from '@ancadeba/utilities'
import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'

const runtime = { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } }

function gameDefinition(title: string) {
  return {
    'schema-version': '1.0.0' as const,
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    scenes: [] as string[],
  }
}

function gameData(title: string) {
  return {
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    scenes: new Map(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createInstance(options: { createMessageBus?: () => IMessageBus<EngineMessages> } = {}) {
  const resourceSource = {
    readText: vi
      .fn<IResourceSource['readText']>()
      .mockResolvedValue(JSON.stringify(gameDefinition('Demo'))),
    readBytes: vi.fn<IResourceSource['readBytes']>(),
  } satisfies IResourceSource
  const cleanup = vi.fn<() => void>()
  const host = {
    mount: vi.fn<IEngineHost['mount']>().mockReturnValue(cleanup),
  } satisfies IEngineHost
  const logger = {
    debug: vi.fn<ILogger['debug']>(() => ''),
    info: vi.fn<ILogger['info']>(() => ''),
    warn: vi.fn<ILogger['warn']>(() => ''),
    error: vi.fn<ILogger['error']>(() => ''),
  } satisfies ILogger
  const engine = new Engine(
    new GameLoader(new JsonResourceLoader(resourceSource, logger)),
    host,
    logger,
    options.createMessageBus ?? (() => new MessageBus<EngineMessages>()),
    runtime,
  )
  return { engine, resourceSource, host, cleanup, logger }
}

describe('engine lifecycle', () => {
  it('creates a stopped instance without loading or mounting a game', () => {
    const { engine, resourceSource, host } = createInstance()

    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()
    expect(resourceSource.readText).not.toHaveBeenCalled()
    expect(host.mount).not.toHaveBeenCalled()
  })

  it('waits for game.json before mounting and exposes the validated game', async () => {
    const { engine, resourceSource, host } = createInstance()
    const read = deferred<string>()
    resourceSource.readText.mockReturnValue(read.promise)

    const starting = engine.start()
    expect(engine.state).toBe('starting')
    expect(engine.game).toBeUndefined()
    expect(host.mount).not.toHaveBeenCalled()

    read.resolve(JSON.stringify(gameDefinition('Loaded')))
    await starting

    expect(resourceSource.readText).toHaveBeenCalledExactlyOnceWith('game.json')
    expect(host.mount).toHaveBeenCalledExactlyOnceWith(gameData('Loaded'), {
      input: undefined,
      messages: expect.anything(),
      timers: expect.anything(),
      actions: expect.anything(),
      lifecycle: expect.anything(),
    })
    expect(engine.state).toBe('running')
    expect(engine.game).toEqual(gameData('Loaded'))
  })

  it('shares concurrent starts and keeps repeated starts from mounting twice', async () => {
    const { engine, resourceSource, host } = createInstance()
    const starting = engine.start()

    expect(engine.start()).toBe(starting)
    await starting
    await engine.start()

    expect(resourceSource.readText).toHaveBeenCalledTimes(1)
    expect(host.mount).toHaveBeenCalledTimes(1)
  })

  it('cleans up once and releases game state when stopped repeatedly', async () => {
    const { engine, cleanup } = createInstance()
    engine.stop()
    await engine.start()

    engine.stop()
    engine.stop()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()
  })

  it('loads fresh game data when restarted', async () => {
    const { engine, resourceSource, host, cleanup } = createInstance()
    await engine.start()
    engine.stop()
    resourceSource.readText.mockResolvedValue(JSON.stringify(gameDefinition('Updated')))

    await engine.start()

    expect(engine.game).toEqual(gameData('Updated'))
    expect(host.mount).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
    engine.stop()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('returns to stopped after a loading failure and permits retrying', async () => {
    const { engine, resourceSource, host } = createInstance()
    const error = new Error('Game unavailable')
    resourceSource.readText.mockRejectedValueOnce(error)

    await expect(engine.start()).rejects.toBe(error)
    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()
    expect(host.mount).not.toHaveBeenCalled()

    await engine.start()
    expect(engine.state).toBe('running')
  })

  it.each(['invalid JSON', '[]', 'null'])('does not mount invalid game data %s', async (text) => {
    const { engine, resourceSource, host } = createInstance()
    resourceSource.readText.mockResolvedValue(text)

    await expect(engine.start()).rejects.toThrow()

    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()
    expect(host.mount).not.toHaveBeenCalled()
  })

  it('returns to stopped if the host cannot mount and permits retrying', async () => {
    const { engine, host } = createInstance()
    const error = new Error('Host unavailable')
    host.mount.mockImplementationOnce(() => {
      throw error
    })

    await expect(engine.start()).rejects.toBe(error)
    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()

    await engine.start()
    expect(engine.state).toBe('running')
  })

  it('can stop before a scheduled start reads any resources', async () => {
    const { engine, resourceSource, host } = createInstance()
    const starting = engine.start()
    engine.stop()

    await starting

    expect(engine.state).toBe('stopped')
    expect(resourceSource.readText).not.toHaveBeenCalled()
    expect(host.mount).not.toHaveBeenCalled()
  })

  it('settles a cancelled start without waiting for a pending resource read', async () => {
    const { engine, resourceSource, host } = createInstance()
    const read = deferred<string>()
    resourceSource.readText.mockReturnValue(read.promise)
    const starting = engine.start()
    await Promise.resolve()
    expect(resourceSource.readText).toHaveBeenCalledTimes(1)

    engine.stop()
    await starting

    expect(engine.state).toBe('stopped')
    expect(host.mount).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale read that completes with %s after restarting',
    async (completion) => {
      const { engine, resourceSource, host } = createInstance()
      const read = deferred<string>()
      resourceSource.readText.mockReturnValueOnce(read.promise)
      const starting = engine.start()
      await Promise.resolve()
      engine.stop()
      await starting
      resourceSource.readText.mockResolvedValue(JSON.stringify(gameDefinition('New game')))
      await engine.start()

      if (completion === 'resolve') read.resolve(JSON.stringify(gameDefinition('Old game')))
      else read.reject(new Error('Old game failed'))
      await Promise.resolve()
      await Promise.resolve()

      expect(engine.state).toBe('running')
      expect(engine.game).toEqual(gameData('New game'))
      expect(host.mount).toHaveBeenCalledExactlyOnceWith(gameData('New game'), {
        input: undefined,
        messages: expect.anything(),
        timers: expect.anything(),
        actions: expect.anything(),
        lifecycle: expect.anything(),
      })
    },
  )

  it('cleans up a mount that stops the engine before returning', async () => {
    const { engine, host, cleanup } = createInstance()
    host.mount.mockImplementation(() => {
      engine.stop()
      return cleanup
    })

    await engine.start()

    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('releases its state even if host cleanup fails', async () => {
    const { engine, cleanup } = createInstance()
    const error = new Error('Cleanup failed')
    cleanup.mockImplementationOnce(() => {
      throw error
    })
    await engine.start()

    expect(() => engine.stop()).toThrow(error)
    expect(engine.state).toBe('stopped')
    expect(engine.game).toBeUndefined()
    expect(() => engine.stop()).not.toThrow()
    await engine.start()
    expect(engine.state).toBe('running')
  })

  it('keeps resources, hosts, and state isolated between instances', async () => {
    const first = createInstance()
    const second = createInstance()
    second.resourceSource.readText.mockResolvedValue(JSON.stringify(gameDefinition('Second')))

    await Promise.all([first.engine.start(), second.engine.start()])
    first.engine.stop()

    expect(first.engine.state).toBe('stopped')
    expect(first.cleanup).toHaveBeenCalledTimes(1)
    expect(second.engine.state).toBe('running')
    expect(second.engine.game).toEqual(gameData('Second'))
    expect(second.cleanup).not.toHaveBeenCalled()
    expect(second.host.mount).toHaveBeenCalledExactlyOnceWith(gameData('Second'), {
      input: undefined,
      messages: expect.anything(),
      timers: expect.anything(),
      actions: expect.anything(),
      lifecycle: expect.anything(),
    })
  })
})

function observeLifecycle(engine: IEngine) {
  const messages = engine.messages
  if (!messages) throw new Error('Start a session before observing lifecycle events')

  const topics: (keyof EngineMessages)[] = []
  const started = vi.fn<(payload: EngineMessages['engine.started']) => void>()
  const failed = vi.fn<(payload: EngineMessages['engine.failed']) => void>()
  messages.subscribe('engine.starting', (payload) => {
    expectTypeOf(payload).toEqualTypeOf<undefined>()
    topics.push('engine.starting')
  })
  messages.subscribe('engine.started', (payload) => {
    expectTypeOf(payload).toEqualTypeOf<EngineMessages['engine.started']>()
    topics.push('engine.started')
    started(payload)
  })
  messages.subscribe('engine.failed', (payload) => {
    expectTypeOf(payload.error).toEqualTypeOf<unknown>()
    topics.push('engine.failed')
    failed(payload)
  })
  messages.subscribe('engine.stopped', (payload) => {
    expectTypeOf(payload).toEqualTypeOf<undefined>()
    topics.push('engine.stopped')
  })
  return { messages, topics, started, failed }
}

describe('engine session messaging', () => {
  it('has no bus until the first session and allows flushing before starting', () => {
    const createMessageBus = vi.fn(() => new MessageBus<EngineMessages>())
    const { engine } = createInstance({ createMessageBus })

    expect(engine.messages).toBeUndefined()
    expect(() => engine.flushMessages()).not.toThrow()
    engine.stop()
    expect(createMessageBus).not.toHaveBeenCalled()
  })

  it('queues typed lifecycle events until explicitly flushed, including after stopping', async () => {
    const { engine } = createInstance()
    const starting = engine.start()
    const { messages, topics, started } = observeLifecycle(engine)

    expect(engine.state).toBe('starting')
    expect(topics).toEqual([])
    engine.flushMessages()
    expect(topics).toEqual(['engine.starting'])
    await starting
    expect(topics).toEqual(['engine.starting'])

    const game = engine.game
    engine.flushMessages()
    expect(topics).toEqual(['engine.starting', 'engine.started'])
    expect(started).toHaveBeenCalledExactlyOnceWith({ game })
    expect(started.mock.calls[0]?.[0].game).toBe(game)

    engine.stop()
    expect(engine.messages).toBe(messages)
    expect(topics).toEqual(['engine.starting', 'engine.started'])
    engine.flushMessages()
    engine.flushMessages()
    expect(topics).toEqual(['engine.starting', 'engine.started', 'engine.stopped'])
  })

  it('keeps repeated starts and stops from duplicating lifecycle events or buses', async () => {
    const createMessageBus = vi.fn(() => new MessageBus<EngineMessages>())
    const { engine } = createInstance({ createMessageBus })
    const starting = engine.start()
    const { topics } = observeLifecycle(engine)

    expect(engine.start()).toBe(starting)
    await starting
    await engine.start()
    engine.stop()
    engine.stop()
    engine.flushMessages()

    expect(createMessageBus).toHaveBeenCalledTimes(1)
    expect(topics).toEqual(['engine.starting', 'engine.started', 'engine.stopped'])
  })

  it('creates a fresh injected bus on restart without carrying over events or subscriptions', async () => {
    const createMessageBus = vi.fn(() => new MessageBus<EngineMessages>())
    const { engine } = createInstance({ createMessageBus })
    const firstStart = engine.start()
    const first = observeLifecycle(engine)
    await firstStart
    engine.stop()

    const secondStart = engine.start()
    const second = observeLifecycle(engine)
    await secondStart
    engine.flushMessages()

    expect(createMessageBus).toHaveBeenCalledTimes(2)
    expect(second.messages).not.toBe(first.messages)
    expect(second.messages).not.toBe(createMessageBus.mock.results[1]?.value)
    expect(first.topics).toEqual([])
    expect(second.topics).toEqual(['engine.starting', 'engine.started'])

    // Retained references may still flush the old session, without touching the new one.
    first.messages.flush()
    expect(first.topics).toEqual(['engine.starting', 'engine.started', 'engine.stopped'])
    expect(second.topics).toEqual(['engine.starting', 'engine.started'])
  })

  it('isolates session buses between engine instances', async () => {
    const first = createInstance()
    const second = createInstance()
    const firstStart = first.engine.start()
    const firstEvents = observeLifecycle(first.engine)
    const secondStart = second.engine.start()
    const secondEvents = observeLifecycle(second.engine)
    await Promise.all([firstStart, secondStart])

    first.engine.stop()
    first.engine.flushMessages()

    expect(firstEvents.messages).not.toBe(secondEvents.messages)
    expect(firstEvents.topics).toEqual(['engine.starting', 'engine.started', 'engine.stopped'])
    expect(secondEvents.topics).toEqual([])
    second.engine.flushMessages()
    expect(secondEvents.topics).toEqual(['engine.starting', 'engine.started'])
  })

  it('queues failure and stopped events when startup fails, and allows a fresh retry', async () => {
    const { engine, resourceSource } = createInstance()
    const error = new Error('Game unavailable')
    resourceSource.readText.mockRejectedValueOnce(error)
    const starting = engine.start()
    const first = observeLifecycle(engine)

    await expect(starting).rejects.toBe(error)
    expect(engine.state).toBe('stopped')
    expect(engine.messages).toBe(first.messages)
    expect(first.topics).toEqual([])
    engine.flushMessages()
    expect(first.topics).toEqual(['engine.starting', 'engine.failed', 'engine.stopped'])
    expect(first.failed).toHaveBeenCalledExactlyOnceWith({ error })

    const retry = engine.start()
    const second = observeLifecycle(engine)
    await retry
    engine.flushMessages()
    expect(second.topics).toEqual(['engine.starting', 'engine.started'])
    expect(first.topics).toHaveLength(3)
  })

  it('reports a host mount failure without publishing a started event', async () => {
    const { engine, host } = createInstance()
    const error = new Error('Cannot mount')
    host.mount.mockImplementationOnce(() => {
      throw error
    })
    const starting = engine.start()
    const { topics, failed, started } = observeLifecycle(engine)

    await expect(starting).rejects.toBe(error)
    engine.flushMessages()

    expect(topics).toEqual(['engine.starting', 'engine.failed', 'engine.stopped'])
    expect(failed).toHaveBeenCalledExactlyOnceWith({ error })
    expect(started).not.toHaveBeenCalled()
  })

  it('queues failure and stopped events even when cleanup throws', async () => {
    const { engine, cleanup } = createInstance()
    const error = new Error('Cleanup failed')
    cleanup.mockImplementationOnce(() => {
      throw error
    })
    const starting = engine.start()
    const { topics, failed } = observeLifecycle(engine)
    await starting

    expect(() => engine.stop()).toThrow(error)
    engine.stop()
    engine.flushMessages()

    expect(engine.state).toBe('stopped')
    expect(topics).toEqual(['engine.starting', 'engine.started', 'engine.failed', 'engine.stopped'])
    expect(failed).toHaveBeenCalledExactlyOnceWith({ error })
  })

  it('queues stopped without started or failed when cancelled before resource loading', async () => {
    const { engine } = createInstance()
    const starting = engine.start()
    const { topics } = observeLifecycle(engine)
    engine.stop()
    await starting
    engine.flushMessages()

    expect(topics).toEqual(['engine.starting', 'engine.stopped'])
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a cancelled resource read that completes with %s after restart',
    async (completion) => {
      const { engine, resourceSource } = createInstance()
      const read = deferred<string>()
      resourceSource.readText.mockReturnValueOnce(read.promise)
      const starting = engine.start()
      const first = observeLifecycle(engine)
      await Promise.resolve()
      engine.stop()
      await starting
      const retry = engine.start()
      const second = observeLifecycle(engine)
      await retry

      if (completion === 'resolve') read.resolve(JSON.stringify(gameDefinition('Old game')))
      else read.reject(new Error('Old game failed'))
      await Promise.resolve()
      await Promise.resolve()
      engine.flushMessages()
      first.messages.flush()

      expect(first.topics).toEqual(['engine.starting', 'engine.stopped'])
      expect(second.topics).toEqual(['engine.starting', 'engine.started'])
    },
  )

  it('does not publish started when mounting stops the session reentrantly', async () => {
    const { engine, host } = createInstance()
    host.mount.mockImplementationOnce(() => {
      engine.stop()
      return () => {}
    })
    const starting = engine.start()
    const { topics } = observeLifecycle(engine)
    await starting
    engine.flushMessages()

    expect(topics).toEqual(['engine.starting', 'engine.stopped'])
  })

  it('defers a stopped event published by a subscriber until the next flush', async () => {
    const { engine } = createInstance()
    const starting = engine.start()
    const { topics } = observeLifecycle(engine)
    engine.messages?.subscribe('engine.started', () => {
      engine.stop()
      engine.flushMessages()
    })
    await starting

    engine.flushMessages()
    expect(engine.state).toBe('stopped')
    expect(topics).toEqual(['engine.starting', 'engine.started'])
    engine.flushMessages()
    expect(topics).toEqual(['engine.starting', 'engine.started', 'engine.stopped'])
  })

  it('keeps subscriber errors separate from startup and cleanup failures', async () => {
    const { engine, cleanup } = createInstance()
    const starting = engine.start()
    const { topics, failed } = observeLifecycle(engine)
    engine.messages?.subscribe('engine.started', () => {
      throw new Error('Subscriber failed')
    })

    await expect(starting).resolves.toBeUndefined()
    expect(() => engine.flushMessages()).toThrow(AggregateError)
    expect(engine.state).toBe('running')
    expect(failed).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()

    engine.stop()
    engine.flushMessages()
    expect(topics).toEqual(['engine.starting', 'engine.started', 'engine.stopped'])
  })
})
