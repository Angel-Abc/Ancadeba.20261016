import { describe, expect, it, vi } from 'vite-plus/test'
import {
  Engine,
  type ActionRequest,
  type EngineHostSession,
  type EngineMessages,
  type GameActionHandler,
  type GameData,
  type IEngineHost,
  type IGameActions,
  type WorldScheduleId,
  type WorldTimePolicy,
} from '@ancadeba/game-runtime'
import { MessageBus, type ILogger } from '@ancadeba/utilities'

class TestTiming {
  now = 0
  readonly tasks: {
    run: () => void
    dueAt: number
    delay: number
    cancelled: boolean
    ran: boolean
  }[] = []
  readonly clock = { now: () => this.now }
  readonly scheduler = {
    schedule: (run: () => void, delay: number) => {
      const task = { run, delay, dueAt: this.now + delay, cancelled: false, ran: false }
      this.tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
  }

  get pending() {
    return this.tasks.filter((task) => !task.cancelled && !task.ran)
  }

  runNext(): void {
    const task = this.pending
      .filter((task) => task.dueAt <= this.now)
      .sort((a, b) => a.dueAt - b.dueAt)[0]
    if (!task) throw new Error('No due task')
    task.ran = true
    task.run()
  }

  drain(): void {
    let passes = 0
    while (this.pending.some((task) => task.dueAt <= this.now)) {
      if (++passes > 100) throw new Error('Tasks did not become idle')
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
}

function setup(
  options: {
    policy?: WorldTimePolicy
    handlers?: Record<string, GameActionHandler>
    host?: IEngineHost
    timing?: TestTiming
  } = {},
) {
  const timing = options.timing ?? new TestTiming()
  const capture = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
  const logger = {
    debug: () => '',
    info: () => '',
    warn: () => '',
    error: vi.fn(() => ''),
  } satisfies ILogger
  const mount = vi.fn<IEngineHost['mount']>(() => () => {})
  const engine = new Engine(
    { load: async () => game },
    {
      mount(data, session) {
        session.lifecycle.startGame()
        return (options.host ?? { mount }).mount(data, session)
      },
    },
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      clock: timing.clock,
      scheduler: timing.scheduler,
      createGameRules: () => ({
        handlers: new Map<string, GameActionHandler>([
          ['capture', capture],
          [
            'cost',
            (request) => ({ status: 'applied', worldTimeCostMs: request.payload as number }),
          ],
          ...Object.entries(options.handlers ?? {}),
        ]),
        worldTime: options.policy ?? { mode: 'action-driven' },
      }),
    },
  )
  return { engine, timing, capture, logger, mount }
}

async function start(options: Parameters<typeof setup>[0] = {}) {
  const instance = setup(options)
  await instance.engine.start()
  instance.timing.drain()
  return instance
}

function stop(instance: Awaited<ReturnType<typeof start>>): void {
  instance.engine.stop()
  instance.timing.drain()
}

describe('one-shot world schedules', () => {
  it('queues zero and past deadlines asynchronously without changing time or turns', async () => {
    const instance = await start()
    const { engine, timing, capture } = instance
    engine.actions!.request('cost', 10)
    timing.drain()
    const absolute = engine.actions!.scheduleWorldAt('capture', 5, 'past')
    const relative = engine.actions!.scheduleWorld('capture', 0, 'now')
    expect(absolute).toBe('world:1')
    expect(relative).toBe('world:2')
    expect(capture).not.toHaveBeenCalled()
    timing.drain()
    expect(capture.mock.calls.map(([request]) => request.payload)).toEqual(['past', 'now'])
    expect(capture.mock.calls[0]![0].origin).toEqual({
      type: 'world-time',
      scheduleId: absolute,
      dueAtWorldMs: 5,
      observedWorldMs: 10,
    })
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 10 })
    expect(timing.pending).toEqual([])
    stop(instance)
  })

  it('orders each newly due group by deadline and then registration order', async () => {
    const instance = await start()
    const { engine, timing, capture } = instance
    for (const [deadline, label] of [
      [200, 'late-first'],
      [100, 'early-first'],
      [200, 'late-second'],
      [100, 'early-second'],
    ] as const) {
      engine.actions!.scheduleWorldAt('capture', deadline, label)
    }
    expect(timing.pending).toEqual([])
    engine.actions!.request('cost', 300)
    timing.drain()
    expect(capture.mock.calls.map(([request]) => request.payload)).toEqual([
      'early-first',
      'early-second',
      'late-first',
      'late-second',
    ])
    expect(capture.mock.calls.every(([, context]) => context.progression.worldTimeMs === 300)).toBe(
      true,
    )
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(4)
    stop(instance)
  })

  it('appends due requests behind queued actions and uses the latest committed snapshot', async () => {
    const order: string[] = []
    const instance = await start({
      handlers: {
        marker: () => {
          order.push('queued')
          return { status: 'applied' }
        },
        effect: (_request, context) => {
          order.push(`effect:${context.progression.worldTimeMs}`)
          return { status: 'applied' }
        },
      },
    })
    const { engine, timing } = instance
    const observed: ActionRequest[] = []
    engine.messages!.subscribe('action.requested', (request) => {
      if (request.origin.type === 'world-time') observed.push(request)
    })
    engine.actions!.scheduleWorldAt('effect', 5)
    engine.actions!.scheduleWorldAt('effect', 15)
    engine.actions!.request('cost', 10)
    engine.actions!.request('cost', 10)
    engine.actions!.request('marker')
    timing.drain()
    expect(order).toEqual(['queued', 'effect:20', 'effect:20'])
    expect(
      observed.map((request) =>
        request.origin.type === 'world-time' ? request.origin.observedWorldMs : -1,
      ),
    ).toEqual([20, 20])
    stop(instance)
  })

  it('preserves fractional world deadlines and relative delays', async () => {
    const instance = await start()
    const { engine, timing, capture } = instance
    engine.actions!.request('cost', 2.5)
    timing.drain()
    engine.actions!.scheduleWorld('capture', 0.5)
    engine.actions!.request('cost', 0.25)
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    engine.actions!.request('cost', 0.25)
    timing.drain()
    expect(capture.mock.calls[0]![0].origin).toMatchObject({ dueAtWorldMs: 3, observedWorldMs: 3 })
    stop(instance)
  })

  it.each([-1, NaN, Infinity, -Infinity])(
    'rejects invalid world times %s without registering schedules',
    async (value) => {
      const instance = await start()
      const { engine, capture, timing } = instance
      expect(() => engine.actions!.scheduleWorld('capture', value)).toThrow(RangeError)
      expect(() => engine.actions!.scheduleWorldAt('capture', value)).toThrow(RangeError)
      expect(engine.actions!.scheduleWorldAt('capture', 0)).toBe('world:1')
      timing.drain()
      expect(capture).toHaveBeenCalledTimes(1)
      stop(instance)
    },
  )

  it('rejects a relative deadline that overflows without consuming a schedule ID', async () => {
    const instance = await start()
    const { engine, timing } = instance
    engine.actions!.request('cost', Number.MAX_VALUE)
    timing.drain()
    expect(() => engine.actions!.scheduleWorld('capture', Number.MAX_VALUE)).toThrow(RangeError)
    expect(engine.actions!.scheduleWorldAt('capture', 0)).toBe('world:1')
    timing.drain()
    stop(instance)
  })

  it('cancels only before the action request is published and keeps host IDs separate', async () => {
    const instance = await start()
    const { engine, timing, capture } = instance
    const pending = engine.actions!.scheduleWorldAt('capture', 5)!
    const host = engine.actions!.schedule('capture', 100)!
    expect(engine.actions!.cancelWorldScheduled('world:999')).toBe(false)
    expect(engine.actions!.cancelWorldScheduled(pending)).toBe(true)
    expect(engine.actions!.cancelWorldScheduled(pending)).toBe(false)
    expect(engine.actions!.cancelScheduled(host)).toBe(true)
    const queued = engine.actions!.scheduleWorldAt('capture', 0)!
    expect(engine.actions!.cancelWorldScheduled(queued)).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    stop(instance)
  })

  it('routes unknown and rejected world actions once without implicit retry', async () => {
    const instance = await start({
      handlers: {
        reject: () => ({ status: 'rejected', reason: 'Blocked' }),
        fail: () => {
          throw new Error('World action failed')
        },
      },
    })
    const { engine, timing } = instance
    const rejected = vi.fn()
    const failed = vi.fn()
    engine.messages!.subscribe('action.rejected', rejected)
    engine.messages!.subscribe('action.failed', failed)
    engine.actions!.scheduleWorldAt('missing', 0)
    engine.actions!.scheduleWorldAt('reject', 0)
    engine.actions!.scheduleWorldAt('fail', 0)
    timing.drain()
    expect(rejected).toHaveBeenCalledTimes(2)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(timing.pending).toEqual([])
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    stop(instance)
  })
})

describe('world deadlines and elapsed host wakeups', () => {
  it('permits cancellation after an alarm publishes but before it queues an action request', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    const id = engine.actions!.scheduleWorldAt('capture', 10)!
    timing.now = 10
    timing.runNext() // The timer wakeup is queued; no world action request exists yet.
    expect(engine.actions!.cancelWorldScheduled(id)).toBe(true)
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    expect(timing.pending.map((task) => task.dueAt)).toEqual([1000])
    stop(instance)
  })

  it('projects the next alarm from the elapsed anchor when cancelling between synchronizations', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    const first = engine.actions!.scheduleWorldAt('capture', 50)!
    engine.actions!.scheduleWorldAt('capture', 100)
    timing.now = 25
    expect(engine.actions!.cancelWorldScheduled(first)).toBe(true)
    expect(engine.actions!.progression.worldTimeMs).toBe(0)
    expect(timing.pending.map((task) => task.dueAt).sort((a, b) => a - b)).toEqual([100, 1000])
    timing.now = 100
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    stop(instance)
  })

  it.each(['elapsed', 'hybrid'] as const)(
    'wakes for a deadline before the normal pulse in %s mode',
    async (mode) => {
      const instance = await start({ policy: { mode, rate: 2 } })
      const { engine, timing, capture } = instance
      engine.actions!.scheduleWorldAt('capture', 200)
      expect(timing.pending.map((task) => task.dueAt).sort((a, b) => a - b)).toEqual([100, 1000])
      timing.now = 100
      timing.drain()
      expect(capture).toHaveBeenCalledTimes(1)
      expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 200 })
      expect(timing.pending.map((task) => task.dueAt)).toEqual([1000])
      stop(instance)
    },
  )

  it('synchronizes relative schedules at the call rather than using a stale snapshot', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 75, 'old')
    timing.now = 100
    expect(engine.actions!.progression.worldTimeMs).toBe(0)
    engine.actions!.scheduleWorld('capture', 50, 'new')
    timing.drain()
    expect(capture.mock.calls.map(([request]) => request.payload)).toEqual(['old'])
    expect(engine.actions!.progression.worldTimeMs).toBe(100)
    expect(timing.pending.map((task) => task.dueAt).sort((a, b) => a - b)).toEqual([150, 1000])
    timing.now = 150
    timing.drain()
    expect(capture.mock.calls[1]![0].origin).toMatchObject({
      dueAtWorldMs: 150,
      observedWorldMs: 150,
    })
    stop(instance)
  })

  it('replaces the nearest alarm on registration and cancellation and ignores stale callbacks', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 500)
    engine.actions!.scheduleWorldAt('capture', 2000)
    const earlier = engine.actions!.scheduleWorldAt('capture', 100)!
    const stale = timing.pending.find((task) => task.dueAt === 100)!
    expect(engine.actions!.cancelWorldScheduled(earlier)).toBe(true)
    expect(timing.pending.map((task) => task.dueAt).sort((a, b) => a - b)).toEqual([500, 1000])
    timing.now = 100
    stale.run()
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    timing.now = 500
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(timing.pending.map((task) => task.dueAt).sort((a, b) => a - b)).toEqual([1000, 2000])
    stop(instance)
  })

  it('retimes an alarm after an action cost and handles coincident pulse and deadline wakeups once', async () => {
    const instance = await start({ policy: { mode: 'hybrid' } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 2000)
    timing.now = 500
    engine.actions!.request('cost', 1000)
    timing.drain()
    expect(engine.actions!.progression.worldTimeMs).toBe(1500)
    expect(timing.pending.map((task) => task.dueAt)).toEqual([1000, 1000])
    timing.now = 1000
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]![0].origin).toMatchObject({
      dueAtWorldMs: 2000,
      observedWorldMs: 2000,
    })
    stop(instance)
  })

  it('removes an obsolete alarm after a time-cost jump passes the deadline', async () => {
    const instance = await start({ policy: { mode: 'hybrid' } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 500)
    const stale = timing.pending.find((task) => task.dueAt === 500)!
    engine.actions!.request('cost', 1000)
    timing.drain()
    expect(capture.mock.calls[0]![0].origin).toMatchObject({
      dueAtWorldMs: 500,
      observedWorldMs: 1000,
    })
    expect(timing.pending.map((task) => task.dueAt)).toEqual([1000])
    timing.now = 500
    stale.run()
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    stop(instance)
  })

  it('accounts for a late alarm at current world time without replaying missed time', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 100)
    timing.now = 5000
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]![0].origin).toMatchObject({
      dueAtWorldMs: 100,
      observedWorldMs: 5000,
    })
    expect(capture.mock.calls[0]![1].progression.worldTimeMs).toBe(5000)
    stop(instance)
  })

  it('rearms early host callbacks and rounds fractional host delays upward', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 100.5)
    const early = timing.pending.find((task) => task.dueAt === 101)!
    expect(early.delay).toBe(101)
    timing.now = 50
    early.run()
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    timing.now = 101
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]![0].origin).toMatchObject({
      dueAtWorldMs: 100.5,
      observedWorldMs: 101,
    })
    stop(instance)
  })

  it('does not spin when conversion of a tiny world interval underflows', async () => {
    const instance = await start({ policy: { mode: 'elapsed', rate: Number.MAX_VALUE } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', Number.MIN_VALUE)
    expect(timing.pending.map((task) => task.dueAt).sort((a, b) => a - b)).toEqual([1, 1000])
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    timing.now = 1
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    stop(instance)
  })

  it('chunks deadlines beyond the maximum host timer delay', async () => {
    const max = 2_147_483_647
    const instance = await start({ policy: { mode: 'elapsed', pulseMs: max } })
    const { engine, timing, capture } = instance
    const deadline = max * 2 + 10
    engine.actions!.scheduleWorldAt('capture', deadline)
    expect(timing.pending.every((task) => task.delay === max)).toBe(true)
    for (const now of [max, max * 2]) {
      timing.now = now
      timing.drain()
      expect(capture).not.toHaveBeenCalled()
      expect(timing.pending.every((task) => task.delay >= 1 && task.delay <= max)).toBe(true)
    }
    timing.now = deadline
    timing.drain()
    expect(capture.mock.calls[0]![0].origin).toMatchObject({
      dueAtWorldMs: deadline,
      observedWorldMs: deadline,
    })
    stop(instance)
  })

  it('clamps an infinite host projection caused by a finite world deadline and tiny rate', async () => {
    const max = 2_147_483_647
    const instance = await start({
      policy: { mode: 'elapsed', rate: Number.MIN_VALUE, pulseMs: max },
    })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 1)
    expect(timing.pending.every((task) => task.delay === max)).toBe(true)
    timing.now = max
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    expect(timing.pending.every((task) => task.delay === max)).toBe(true)
    stop(instance)
  })
})

describe('world schedule action boundaries and lifecycle', () => {
  it('anchors a relative schedule inside a handler before that action commits its cost', async () => {
    const order: string[] = []
    const instance = await start({
      handlers: {
        source: (_request, context) => {
          context.actions.scheduleWorld('effect', 500)
          return { status: 'applied', worldTimeCostMs: 1000 }
        },
        effect: (_request, context) => {
          order.push(`effect:${context.progression.worldTimeMs}`)
          return { status: 'applied' }
        },
      },
    })
    const { engine, timing } = instance
    engine.messages!.subscribe('action.applied', ({ request }) => {
      if (request.action === 'source') order.push('source:applied')
    })
    engine.actions!.request('source')
    timing.drain()
    expect(order).toEqual(['source:applied', 'effect:1000'])
    stop(instance)
  })

  it('defers zero-delay schedules inside handlers and supports later cost-triggered cascades', async () => {
    const order: string[] = []
    const instance = await start({
      handlers: {
        source: (_request, context) => {
          order.push('source')
          context.actions.scheduleWorld('first', 0)
          context.actions.scheduleWorldAt('second', 10)
          return { status: 'applied' }
        },
        first: () => {
          order.push('first')
          return { status: 'applied', worldTimeCostMs: 10 }
        },
        second: () => {
          order.push('second')
          return { status: 'applied' }
        },
      },
    })
    const { engine, timing } = instance
    engine.actions!.request('source')
    timing.runNext()
    expect(order).toEqual(['source'])
    timing.runNext()
    expect(order).toEqual(['source', 'first'])
    timing.drain()
    expect(order).toEqual(['source', 'first', 'second'])
    stop(instance)
  })

  it('creates no due schedules from rejected or failed action costs', async () => {
    const instance = await start({
      handlers: {
        reject: () => ({ status: 'rejected', reason: 'Blocked' }),
        fail: () => {
          throw new Error('Failed')
        },
      },
    })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 10)
    engine.actions!.request('reject')
    engine.actions!.request('fail')
    timing.now = 1000
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    expect(engine.actions!.progression.worldTimeMs).toBe(0)
    expect(timing.pending).toEqual([])
    engine.actions!.request('cost', 10)
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    stop(instance)
  })

  it.each(['reject', 'fail'])(
    'can still make schedules due through elapsed time before a %s action',
    async (action) => {
      const instance = await start({
        policy: { mode: 'hybrid' },
        handlers: {
          reject: () => ({ status: 'rejected', reason: 'Blocked' }),
          fail: () => {
            throw new Error('Failed')
          },
        },
      })
      const { engine, timing, capture } = instance
      engine.actions!.scheduleWorldAt('capture', 10)
      timing.now = 20
      engine.actions!.request(action)
      timing.drain()
      expect(capture).toHaveBeenCalledTimes(1)
      expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 20 })
      stop(instance)
    },
  )

  it('does not use action costs to reach deadlines in elapsed-only mode', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    engine.actions!.scheduleWorldAt('capture', 100)
    engine.actions!.request('cost', 1000)
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    expect(engine.actions!.progression.worldTimeMs).toBe(0)
    timing.now = 100
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    stop(instance)
  })

  it('defers mounting-time schedules until running and excludes mounting time', async () => {
    const timing = new TestTiming()
    let session: EngineHostSession | undefined
    const instance = setup({
      timing,
      policy: { mode: 'elapsed' },
      host: {
        mount: (_game, services) => {
          session = services
          services.actions!.scheduleWorld('capture', 0, 'start')
          services.actions!.scheduleWorld('capture', 20, 'later')
          timing.now = 1000
          return () => {}
        },
      },
    })
    await instance.engine.start()
    expect(instance.capture).not.toHaveBeenCalled()
    expect(session!.actions).toBe(instance.engine.actions)
    timing.drain()
    expect(instance.capture.mock.calls.map(([request]) => request.payload)).toEqual(['start'])
    timing.now = 1020
    timing.drain()
    expect(instance.capture.mock.calls.map(([request]) => request.payload)).toEqual([
      'start',
      'later',
    ])
    expect(instance.engine.actions!.progression.worldTimeMs).toBe(20)
    stop(instance)
  })

  it('disposes pending schedules when mounting fails', async () => {
    let retained: IGameActions | undefined
    const instance = setup({
      policy: { mode: 'elapsed' },
      host: {
        mount: (_game, session) => {
          retained = session.actions
          session.actions!.scheduleWorld('capture', 0)
          session.actions!.scheduleWorld('capture', 10)
          throw new Error('Mount failed')
        },
      },
    })
    await expect(instance.engine.start()).rejects.toThrow('Mount failed')
    instance.timing.drain()
    expect(instance.capture).not.toHaveBeenCalled()
    expect(retained!.scheduleWorld('capture', 0)).toBeUndefined()
    expect(retained!.scheduleWorldAt('capture', 0)).toBeUndefined()
    expect(instance.timing.pending).toEqual([])
  })

  it('drops later due requests if a scheduled handler stops the engine', async () => {
    const instance = await start({
      handlers: {
        halt: () => {
          instance.engine.stop()
          return { status: 'applied', worldTimeCostMs: 50 }
        },
      },
    })
    const { engine, timing, capture } = instance
    const actions = engine.actions!
    actions.scheduleWorldAt('halt', 5)
    actions.scheduleWorldAt('capture', 5)
    actions.request('cost', 10)
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    expect(actions.progression).toEqual({ turn: 0, worldTimeMs: 10 })
    expect(engine.state).toBe('stopped')
    expect(timing.pending).toEqual([])
  })

  it('cancels owned wakeups on stop and isolates a restarted session from stale callbacks', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    const { engine, timing, capture } = instance
    const old = engine.actions!
    const id = old.scheduleWorldAt('capture', 10)!
    const stale = timing.pending.find((task) => task.dueAt === 10)!
    engine.stop()
    expect(old.scheduleWorld('capture', -1)).toBeUndefined()
    expect(old.scheduleWorldAt('capture', -1)).toBeUndefined()
    expect(old.cancelWorldScheduled(id)).toBe(false)
    await engine.start()
    expect(engine.actions!.scheduleWorldAt('capture', 20)).toBe('world:1')
    timing.now = 10
    stale.run()
    timing.drain()
    expect(capture).not.toHaveBeenCalled()
    timing.now = 20
    timing.drain()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]![0].origin).toMatchObject({ dueAtWorldMs: 20 })
    stop(instance)
  })

  it('isolates pending world schedules between simultaneous engines', async () => {
    const first = await start()
    const second = await start()
    const firstId: WorldScheduleId = first.engine.actions!.scheduleWorldAt('capture', 10)!
    const secondId = second.engine.actions!.scheduleWorldAt('capture', 10)!
    expect(firstId).toBe(secondId)
    first.engine.actions!.cancelWorldScheduled(firstId)
    for (const instance of [first, second]) {
      instance.engine.actions!.request('cost', 10)
      instance.timing.drain()
    }
    expect(first.capture).not.toHaveBeenCalled()
    expect(second.capture).toHaveBeenCalledTimes(1)
    stop(first)
    stop(second)
  })
})
