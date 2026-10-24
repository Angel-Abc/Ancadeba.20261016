import { createEngine, type IEngineHost } from '@ancadeba/game-runtime'
import type { ILogger, IResourceSource } from '@ancadeba/utilities'
import { describe, expect, it, vi } from 'vite-plus/test'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createInstance() {
  const resourceSource = {
    readText: vi.fn<IResourceSource['readText']>().mockResolvedValue('{"title":"Demo"}'),
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
  const engine = createEngine({ resourceSource, host, logger })
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

    read.resolve('{"title":"Loaded","settings":{"difficulty":2}}')
    await starting

    expect(resourceSource.readText).toHaveBeenCalledExactlyOnceWith('game.json')
    expect(host.mount).toHaveBeenCalledExactlyOnceWith({
      title: 'Loaded',
      settings: { difficulty: 2 },
    })
    expect(engine.state).toBe('running')
    expect(engine.game).toEqual({ title: 'Loaded', settings: { difficulty: 2 } })
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
    resourceSource.readText.mockResolvedValue('{"title":"Updated"}')

    await engine.start()

    expect(engine.game).toEqual({ title: 'Updated' })
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
      resourceSource.readText.mockResolvedValue('{"title":"New game"}')
      await engine.start()

      if (completion === 'resolve') read.resolve('{"title":"Old game"}')
      else read.reject(new Error('Old game failed'))
      await Promise.resolve()
      await Promise.resolve()

      expect(engine.state).toBe('running')
      expect(engine.game).toEqual({ title: 'New game' })
      expect(host.mount).toHaveBeenCalledExactlyOnceWith({ title: 'New game' })
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
    second.resourceSource.readText.mockResolvedValue('{"title":"Second"}')

    await Promise.all([first.engine.start(), second.engine.start()])
    first.engine.stop()

    expect(first.engine.state).toBe('stopped')
    expect(first.cleanup).toHaveBeenCalledTimes(1)
    expect(second.engine.state).toBe('running')
    expect(second.engine.game).toEqual({ title: 'Second' })
    expect(second.cleanup).not.toHaveBeenCalled()
    expect(second.host.mount).toHaveBeenCalledExactlyOnceWith({ title: 'Second' })
  })
})
