import { describe, expect, it, vi } from 'vite-plus/test'
import {
  Engine,
  type EngineMessages,
  type GameData,
  type IEngineHost,
  type IGameLoader,
  type EngineRuntimeServices,
} from '@ancadeba/game-runtime'
import { MessageBus, type ILogger } from '@ancadeba/utilities'

class TestTiming implements EngineRuntimeServices {
  now = 0
  readonly tasks: { run: () => void; dueAt: number; cancelled: boolean; ran: boolean }[] = []
  readonly clock = { now: () => this.now }
  readonly scheduler = {
    schedule: (run: () => void, delay: number) => {
      const task = { run, dueAt: this.now + delay, cancelled: false, ran: false }
      this.tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
  }

  runNext(): void {
    const task = this.tasks.find((task) => !task.ran && !task.cancelled && task.dueAt <= this.now)
    if (!task) throw new Error('No due task')
    task.ran = true
    task.run()
  }

  drain(): void {
    let passes = 0
    while (this.tasks.some((task) => !task.ran && !task.cancelled && task.dueAt <= this.now)) {
      if (++passes > 100) throw new Error('Dispatch did not become idle')
      this.runNext()
    }
  }
}

const game: GameData = {
  id: 'demo',
  title: 'Demo',
  description: '',
  version: '1',
  scenes: new Map(),
  input: {
    virtualKeys: ['north'],
    keyboard: { KeyW: 'north' },
    contexts: { gameplay: { north: 'moveNorth' } },
    initialContext: 'gameplay',
  },
}

function createInstance(
  options: { timing?: TestTiming; loader?: IGameLoader; host?: IEngineHost } = {},
) {
  const timing = options.timing ?? new TestTiming()
  const logger = {
    debug: () => '',
    info: () => '',
    warn: () => '',
    error: vi.fn(() => ''),
  } satisfies ILogger
  const engine = new Engine(
    options.loader ?? { load: async () => game },
    options.host ?? { mount: () => () => {} },
    logger,
    () => new MessageBus<EngineMessages>(),
    timing,
  )
  return { engine, timing, logger }
}

describe('automatic engine-session dispatch', () => {
  it('automatically delivers lifecycle and input messages without inline execution or idle polling', async () => {
    const { engine, timing } = createInstance()
    expect(engine.timers).toBeUndefined()
    const starting = engine.start()
    const startingHandler = vi.fn()
    const started = vi.fn()
    engine.messages!.subscribe('engine.starting', startingHandler)
    engine.messages!.subscribe('engine.started', started)
    expect(startingHandler).not.toHaveBeenCalled()
    expect(engine.timers).toBeUndefined()
    timing.runNext()
    expect(startingHandler).toHaveBeenCalledTimes(1)
    await starting
    expect(started).not.toHaveBeenCalled()
    timing.runNext()
    expect(started).toHaveBeenCalledExactlyOnceWith({ game })
    const input = vi.fn()
    engine.messages!.subscribe('input.virtual', input)
    engine.input!.pressKey('KeyW')
    engine.input!.releaseKey('KeyW')
    expect(input).not.toHaveBeenCalled()
    timing.runNext()
    expect(input.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
    const count = timing.tasks.length
    timing.drain()
    expect(timing.tasks).toHaveLength(count)
    engine.stop()
    timing.drain()
  })

  it('provides bus and timers during mounting and defers handler-generated messages', async () => {
    const timing = new TestTiming()
    const inputEvents: string[] = []
    const wakeup = vi.fn()
    const { engine } = createInstance({
      timing,
      host: {
        mount: (_game, session) => {
          session.messages.subscribe('input.virtual', (event) => {
            inputEvents.push(event.phase)
            if (event.phase === 'pressed') session.input!.releaseKey('KeyW')
          })
          session.messages.subscribe('timer.wakeup', wakeup)
          session.timers.schedule(0)
          return () => {}
        },
      },
    })
    await engine.start()
    timing.drain()
    expect(wakeup).toHaveBeenCalledExactlyOnceWith({ timerId: 1, dueAt: 0, observedAt: 0 })
    engine.input!.pressKey('KeyW')
    timing.runNext()
    expect(inputEvents).toEqual(['pressed'])
    timing.runNext()
    expect(inputEvents).toEqual(['pressed', 'released'])
    engine.stop()
    timing.drain()
  })

  it('finishes current subscribers when stopped in a handler and drops subsequent triggers in the batch', async () => {
    const { engine, timing } = createInstance()
    await engine.start()
    timing.drain()
    const calls: string[] = []
    const wakeup = vi.fn()
    engine.messages!.subscribe('input.virtual', (event) => {
      calls.push(`first:${event.phase}`)
      engine.stop()
    })
    engine.messages!.subscribe('input.virtual', (event) => calls.push(`second:${event.phase}`))
    engine.messages!.subscribe('timer.wakeup', wakeup)
    engine.messages!.subscribe('engine.stopped', () => calls.push('stopped'))
    engine.timers!.schedule(0)
    engine.input!.pressKey('KeyW')
    engine.input!.releaseKey('KeyW')
    timing.runNext() // Timer publishes into the pending input batch.
    timing.runNext()
    expect(calls).toEqual(['first:pressed', 'second:pressed'])
    expect(wakeup).not.toHaveBeenCalled()
    expect(engine.state).toBe('stopped')
    timing.runNext()
    expect(calls).toEqual(['first:pressed', 'second:pressed', 'stopped'])
  })

  it('applies stop filtering to explicit flushes and invalidates stale automatic tasks', async () => {
    const { engine, timing } = createInstance()
    await engine.start()
    timing.drain()
    const bus = engine.messages!
    const input = vi.fn()
    const wakeup = vi.fn()
    const stopped = vi.fn()
    bus.subscribe('input.virtual', input)
    bus.subscribe('timer.wakeup', wakeup)
    engine.timers!.schedule(0)
    timing.runNext()
    engine.input!.pressKey('KeyW')
    engine.stop()
    bus.subscribe('engine.stopped', stopped)
    bus.publish('input.virtual', { context: 'gameplay', input: 'ignored', phase: 'pressed' })
    engine.flushMessages()
    for (const task of timing.tasks) task.run()
    expect(input).not.toHaveBeenCalled()
    expect(wakeup).not.toHaveBeenCalled()
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('keeps terminal notifications on the old bus across an immediate restart', async () => {
    const { engine, timing } = createInstance()
    await engine.start()
    timing.drain()
    const oldBus = engine.messages!
    const oldTimers = engine.timers!
    const stopped = vi.fn(() => oldBus.publish('engine.stopped', undefined))
    oldBus.subscribe('engine.stopped', stopped)
    oldTimers.schedule(10)
    const oldTask = timing.tasks.at(-1)!
    engine.stop()
    const starting = engine.start()
    const started = vi.fn()
    const wakeup = vi.fn()
    engine.messages!.subscribe('engine.started', started)
    engine.messages!.subscribe('timer.wakeup', wakeup)
    await starting
    timing.now = 100
    oldTask.run()
    timing.drain()
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledTimes(1)
    expect(wakeup).not.toHaveBeenCalled()
    expect(engine.state).toBe('running')
    expect(oldTimers.schedule(0)).toBeUndefined()
    expect(oldTimers.cancel(1)).toBe(false)
    expect(engine.timers).not.toBe(oldTimers)
    engine.stop()
    timing.drain()
  })

  it('automatically delivers startup failure without changing rejection behavior', async () => {
    const failure = new Error('Load failed')
    const { engine, timing } = createInstance({
      loader: {
        load: async () => {
          throw failure
        },
      },
    })
    const starting = engine.start()
    const failed = vi.fn()
    const stopped = vi.fn()
    engine.messages!.subscribe('engine.failed', failed)
    engine.messages!.subscribe('engine.stopped', stopped)
    await expect(starting).rejects.toBe(failure)
    expect(failed).not.toHaveBeenCalled()
    timing.drain()
    expect(failed).toHaveBeenCalledExactlyOnceWith({ error: failure })
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(engine.timers).toBeUndefined()
  })

  it('handles cancellation during loading and ignores late completion after restart', async () => {
    let resolve!: (game: GameData) => void
    const pending = new Promise<GameData>((complete) => {
      resolve = complete
    })
    const loader = {
      load: vi.fn<IGameLoader['load']>().mockReturnValueOnce(pending).mockResolvedValue(game),
    }
    const { engine, timing } = createInstance({ loader })
    const first = engine.start()
    const stopped = vi.fn()
    const oldStarted = vi.fn()
    engine.messages!.subscribe('engine.stopped', stopped)
    engine.messages!.subscribe('engine.started', oldStarted)
    await Promise.resolve()
    engine.stop()
    await first
    await engine.start()
    resolve(game)
    await Promise.resolve()
    timing.drain()
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(oldStarted).not.toHaveBeenCalled()
    expect(engine.state).toBe('running')
    engine.stop()
    timing.drain()
  })

  it('logs automatic subscriber errors and keeps processing without engine failure events', async () => {
    const { engine, timing, logger } = createInstance()
    await engine.start()
    timing.drain()
    const failure = new Error('Subscriber failed')
    const failed = vi.fn()
    const received = vi.fn()
    engine.messages!.subscribe('engine.failed', failed)
    const unsubscribe = engine.messages!.subscribe('input.virtual', () => {
      throw failure
    })
    engine.messages!.subscribe('input.virtual', received)
    engine.input!.pressKey('KeyW')
    timing.runNext()
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Engine',
      'Message dispatch failed',
      expect.any(AggregateError),
    )
    expect(failed).not.toHaveBeenCalled()
    expect(received).toHaveBeenCalledTimes(1)
    expect(engine.state).toBe('running')
    unsubscribe()
    engine.input!.releaseKey('KeyW')
    timing.runNext()
    expect(received).toHaveBeenCalledTimes(2)
    engine.stop()
    timing.drain()
  })

  it('retains synchronous cleanup errors and delivers terminal notifications', async () => {
    const failure = new Error('Cleanup failed')
    const { engine, timing } = createInstance({
      host: {
        mount: () => () => {
          throw failure
        },
      },
    })
    await engine.start()
    timing.drain()
    const failed = vi.fn()
    const stopped = vi.fn()
    engine.messages!.subscribe('engine.failed', failed)
    engine.messages!.subscribe('engine.stopped', stopped)
    expect(() => engine.stop()).toThrow(failure)
    expect(engine.state).toBe('stopped')
    timing.drain()
    expect(failed).toHaveBeenCalledExactlyOnceWith({ error: failure })
    expect(stopped).toHaveBeenCalledTimes(1)
  })

  it('isolates timers and subscriptions between simultaneous engines', async () => {
    const timing = new TestTiming()
    const first = createInstance({ timing }).engine
    const second = createInstance({ timing }).engine
    await Promise.all([first.start(), second.start()])
    timing.drain()
    const firstWakeup = vi.fn()
    const secondWakeup = vi.fn()
    first.messages!.subscribe('timer.wakeup', firstWakeup)
    second.messages!.subscribe('timer.wakeup', secondWakeup)
    expect(first.timers!.schedule(5)).toBe(1)
    expect(second.timers!.schedule(5)).toBe(1)
    first.stop()
    timing.now = 5
    timing.drain()
    expect(firstWakeup).not.toHaveBeenCalled()
    expect(secondWakeup).toHaveBeenCalledExactlyOnceWith({ timerId: 1, dueAt: 5, observedAt: 5 })
    second.stop()
    timing.drain()
  })
})
