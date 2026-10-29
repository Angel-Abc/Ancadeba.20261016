import { describe, expect, it, vi } from 'vite-plus/test'
import {
  Engine,
  type ActionOutcome,
  type EngineHostSession,
  type EngineMessages,
  type EngineRuntimeServices,
  type GameActionHandler,
  type GameData,
  type GameRules,
  type GameRulesFactory,
  type IEngineHost,
  type IGameActions,
  type IGameLoader,
  type InputActionBinding,
  type WorldTimePolicy,
} from '@ancadeba/game-runtime'
import { MessageBus, type ILogger } from '@ancadeba/utilities'

class TestTiming {
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

  get pending() {
    return this.tasks.filter((task) => !task.ran && !task.cancelled)
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
  input: {
    virtualKeys: ['north'],
    keyboard: { KeyW: 'north' },
    contexts: { gameplay: { north: 'moveNorth' }, menu: { north: 'selectPrevious' } },
    initialContext: 'gameplay',
  },
}

function rules(
  handlers: Record<string, GameActionHandler>,
  inputBindings: readonly InputActionBinding[] = [],
  worldTime?: WorldTimePolicy,
): GameRules {
  return {
    handlers: new Map(Object.entries(handlers)),
    inputBindings,
    ...(worldTime ? { worldTime } : {}),
  }
}

function setup(
  options: {
    rules?: GameRules
    factory?: GameRulesFactory
    timing?: TestTiming
    host?: IEngineHost
    loader?: IGameLoader
  } = {},
) {
  const timing = options.timing ?? new TestTiming()
  const logger = {
    debug: () => '',
    info: () => '',
    warn: () => '',
    error: vi.fn(() => ''),
  } satisfies ILogger
  const runtime: EngineRuntimeServices = {
    clock: timing.clock,
    scheduler: timing.scheduler,
    ...(options.factory
      ? { createGameRules: options.factory }
      : options.rules
        ? { createGameRules: () => options.rules! }
        : {}),
  }
  const mount = vi.fn<IEngineHost['mount']>(() => () => {})
  const engine = new Engine(
    options.loader ?? { load: async () => game },
    options.host ?? { mount },
    logger,
    () => new MessageBus<EngineMessages>(),
    runtime,
  )
  return { engine, timing, logger, mount }
}

async function start(options: Parameters<typeof setup>[0] = {}) {
  const instance = setup(options)
  await instance.engine.start()
  instance.timing.drain()
  return instance
}

function observe(engine: Engine) {
  const applied = vi.fn<(event: EngineMessages['action.applied']) => void>()
  const rejected = vi.fn<(event: EngineMessages['action.rejected']) => void>()
  const failed = vi.fn<(event: EngineMessages['action.failed']) => void>()
  const turns = vi.fn<(event: EngineMessages['turn.advanced']) => void>()
  const world = vi.fn<(event: EngineMessages['world-time.advanced']) => void>()
  engine.messages!.subscribe('action.applied', applied)
  engine.messages!.subscribe('action.rejected', rejected)
  engine.messages!.subscribe('action.failed', failed)
  engine.messages!.subscribe('turn.advanced', turns)
  engine.messages!.subscribe('world-time.advanced', world)
  return { applied, rejected, failed, turns, world }
}

describe('game action routing', () => {
  it('defaults to empty action-driven rules, rejects unknown actions, and stays idle', async () => {
    const { engine, timing } = await start()
    const events = observe(engine)
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    expect(engine.actions!.request('unknown')).toBe(1)
    timing.drain()
    expect(events.rejected).toHaveBeenCalledExactlyOnceWith({
      request: { id: 1, action: 'unknown', payload: undefined, origin: { type: 'direct' } },
      reason: 'Unknown action: unknown',
      progression: { turn: 0, worldTimeMs: 0 },
    })
    expect(events.failed).not.toHaveBeenCalled()
    expect(timing.pending).toEqual([])
    engine.stop()
    timing.drain()
  })

  it('routes pressed inputs using captured context and ignores unmatched inputs and phases', async () => {
    const walk = vi.fn<GameActionHandler>(() => ({ status: 'applied', advanceTurn: true }))
    const menu = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const { engine, timing } = await start({
      rules: rules({ walk, menu }, [
        { context: 'gameplay', input: 'moveNorth', action: 'walk' },
        { context: 'menu', input: 'selectPrevious', action: 'menu' },
      ]),
    })
    engine.input!.pressKey('KeyW')
    engine.input!.pressKey('KeyW')
    engine.input!.setContext('menu')
    timing.runNext() // Input delivery only queues the action.
    expect(walk).not.toHaveBeenCalled()
    timing.drain()
    expect(walk).toHaveBeenCalledTimes(1)
    expect(walk.mock.calls[0]![0].origin).toEqual({
      type: 'input',
      event: { context: 'gameplay', input: 'moveNorth', phase: 'pressed' },
    })
    expect(menu).not.toHaveBeenCalled()
    engine.input!.releaseKey('KeyW')
    engine.input!.pressKey('KeyW')
    engine.input!.releaseKey('KeyW')
    engine.messages!.publish('input.virtual', {
      context: 'menu',
      input: 'unmatched',
      phase: 'pressed',
    })
    timing.drain()
    expect(menu).toHaveBeenCalledTimes(1)
    expect(engine.actions!.progression.turn).toBe(1)
    engine.stop()
    timing.drain()
  })

  it('supports explicit release and cancellation bindings', async () => {
    const handler = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const { engine, timing } = await start({
      rules: rules({ stop: handler }, [
        { context: 'gameplay', input: 'moveNorth', phase: 'released', action: 'stop' },
        { context: 'gameplay', input: 'moveNorth', phase: 'cancelled', action: 'stop' },
      ]),
    })
    engine.input!.pressKey('KeyW')
    engine.input!.releaseKey('KeyW')
    engine.input!.pressKey('KeyW')
    engine.input!.reset()
    timing.drain()
    expect(
      handler.mock.calls.map(([request]) =>
        request.origin.type === 'input' ? request.origin.event.phase : '',
      ),
    ).toEqual(['released', 'cancelled'])
    engine.stop()
    timing.drain()
  })

  it('processes requests serially and defers handler-generated followups and outcomes', async () => {
    const seen: number[] = []
    const { engine, timing } = await start({
      rules: rules({
        first: (_request, context) => {
          seen.push(context.progression.turn)
          context.actions.request('next')
          return { status: 'applied', advanceTurn: true }
        },
        next: (_request, context) => {
          seen.push(context.progression.turn)
          return { status: 'applied', advanceTurn: true }
        },
      }),
    })
    const events = observe(engine)
    const payload = { target: 'north' }
    engine.actions!.request('first', payload)
    expect(seen).toEqual([])
    timing.runNext()
    expect(seen).toEqual([0])
    expect(events.applied).not.toHaveBeenCalled()
    timing.runNext()
    expect(seen).toEqual([0, 1])
    timing.drain()
    expect(events.applied.mock.calls.map(([event]) => event.progression.turn)).toEqual([1, 2])
    expect(events.applied.mock.calls[0]![0].request.payload).toBe(payload)
    expect(events.applied.mock.calls.map(([event]) => event.request.id)).toEqual([1, 2])
    engine.stop()
    timing.drain()
  })

  it('routes owned timers once and leaves unrelated timers alone', async () => {
    const handler = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const { engine, timing } = await start({ rules: rules({ weather: handler }) })
    const unrelated = engine.timers!.schedule(0)!
    const payload = { rain: true }
    const owned = engine.actions!.schedule('weather', 0, payload)!
    expect(engine.actions!.cancelScheduled(unrelated)).toBe(false)
    timing.drain()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toEqual({
      id: 1,
      action: 'weather',
      payload,
      origin: { type: 'timer', event: { timerId: owned, dueAt: 0, observedAt: 0 } },
    })
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    engine.stop()
    timing.drain()
  })

  it('cancels pending actions but cannot retract a published timer wakeup', async () => {
    const handler = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const { engine, timing } = await start({ rules: rules({ weather: handler }) })
    const cancelled = engine.actions!.schedule('weather', 50)!
    const due = engine.actions!.schedule('weather', 0)!
    expect(engine.actions!.cancelScheduled(cancelled)).toBe(true)
    expect(engine.actions!.cancelScheduled(cancelled)).toBe(false)
    timing.runNext() // Publish the zero-delay timer wakeup, without delivering it yet.
    expect(engine.actions!.cancelScheduled(due)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    timing.now = 100
    timing.drain()
    expect(handler).toHaveBeenCalledTimes(1)
    engine.stop()
    timing.drain()
  })
})

describe('independent action progression', () => {
  it('advances turns and action time independently and emits only actual changes', async () => {
    const { engine, timing } = await start({
      rules: rules({
        free: () => ({ status: 'applied' }),
        turn: () => ({ status: 'applied', advanceTurn: true }),
        time: () => ({ status: 'applied', worldTimeCostMs: 2.5 }),
        both: () => ({ status: 'applied', advanceTurn: true, worldTimeCostMs: 10 }),
      }),
    })
    const events = observe(engine)
    for (const action of ['free', 'turn', 'time', 'both']) engine.actions!.request(action)
    timing.drain()
    expect(events.applied.mock.calls.map(([event]) => event.progression)).toEqual([
      { turn: 0, worldTimeMs: 0 },
      { turn: 1, worldTimeMs: 0 },
      { turn: 1, worldTimeMs: 2.5 },
      { turn: 2, worldTimeMs: 12.5 },
    ])
    expect(events.turns).toHaveBeenCalledTimes(2)
    expect(events.world).toHaveBeenCalledTimes(2)
    const old = events.applied.mock.calls[0]![0].progression
    expect(Object.isFrozen(old)).toBe(true)
    expect(() => {
      ;(old as { turn: number }).turn = 99
    }).toThrow(TypeError)
    expect(engine.actions!.progression).toEqual({ turn: 2, worldTimeMs: 12.5 })
    engine.stop()
    timing.drain()
  })

  it.each([
    ['action-driven', 50, 50],
    ['elapsed', 100, 200],
    ['hybrid', 150, 250],
  ] as const)(
    'supports %s progression without coupling world time to turns',
    async (mode, first, second) => {
      const { engine, timing } = await start({
        rules: rules(
          {
            move: () => ({ status: 'applied', advanceTurn: true, worldTimeCostMs: 50 }),
            free: () => ({ status: 'applied' }),
          },
          [],
          { mode },
        ),
      })
      timing.now = 100
      engine.actions!.request('move')
      timing.drain()
      expect(engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: first })
      timing.now = 200
      engine.actions!.request('free')
      timing.drain()
      expect(engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: second })
      engine.stop()
      timing.drain()
    },
  )

  it('adds hybrid costs without resetting the elapsed anchor or accounting for intervals twice', async () => {
    const { engine, timing } = await start({
      rules: rules({ jump: () => ({ status: 'applied', worldTimeCostMs: 250 }) }, [], {
        mode: 'hybrid',
      }),
    })
    timing.now = 100
    engine.actions!.request('jump')
    timing.drain()
    expect(engine.actions!.progression.worldTimeMs).toBe(350)
    timing.now = 1000
    timing.drain()
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 1250 })
    engine.stop()
    timing.drain()
  })

  it('samples processing time and exposes the latest synchronized snapshot', async () => {
    const handler = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const { engine, timing } = await start({
      rules: rules({ inspect: handler }, [], { mode: 'elapsed', rate: 2 }),
    })
    timing.now = 10
    engine.actions!.request('inspect')
    timing.now = 40
    expect(engine.actions!.progression.worldTimeMs).toBe(0)
    timing.drain()
    expect(handler.mock.calls[0]![1].progression.worldTimeMs).toBe(80)
    expect(engine.actions!.progression.worldTimeMs).toBe(80)
    engine.stop()
    timing.drain()
  })

  it('accounts for delayed pulses once, applies custom rates, and schedules from the current time', async () => {
    const { engine, timing } = await start({
      rules: rules({}, [], { mode: 'elapsed', rate: 2, pulseMs: 25 }),
    })
    const events = observe(engine)
    timing.now = 125
    timing.drain()
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 250 })
    expect(events.world).toHaveBeenCalledTimes(1)
    expect(events.applied).not.toHaveBeenCalled()
    expect(events.turns).not.toHaveBeenCalled()
    expect(timing.pending.map((task) => task.dueAt)).toEqual([150])
    engine.stop()
    timing.drain()
    expect(timing.pending).toEqual([])
  })

  it('starts elapsed accounting after loading and mounting rather than during startup', async () => {
    const timing = new TestTiming()
    const { engine } = setup({
      timing,
      rules: rules({}, [], { mode: 'elapsed' }),
      loader: {
        load: async () => {
          timing.now = 1000
          return game
        },
      },
      host: {
        mount: () => {
          timing.now = 2000
          return () => {}
        },
      },
    })
    await engine.start()
    timing.drain()
    expect(engine.actions!.progression.worldTimeMs).toBe(0)
    timing.now = 3000
    timing.drain()
    expect(engine.actions!.progression.worldTimeMs).toBe(1000)
    engine.stop()
    timing.drain()
  })

  it('keeps elapsed time passing on rejection without applying a turn or action cost', async () => {
    const { engine, timing } = await start({
      rules: rules({ blocked: () => ({ status: 'rejected', reason: 'Blocked' }) }, [], {
        mode: 'hybrid',
      }),
    })
    const events = observe(engine)
    timing.now = 200
    engine.actions!.request('blocked')
    timing.drain()
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 200 })
    expect(events.rejected.mock.calls[0]![0].reason).toBe('Blocked')
    expect(events.turns).not.toHaveBeenCalled()
    expect(events.world).toHaveBeenCalledTimes(1)
    engine.stop()
    timing.drain()
  })
})

describe('action failures and lifecycle', () => {
  it.each([
    null,
    undefined,
    {},
    { status: 'unknown' },
    { status: 'rejected' },
    { status: 'rejected', reason: '' },
    { status: 'applied', advanceTurn: 1 },
    { status: 'applied', advanceTurn: null },
    { status: 'applied', worldTimeCostMs: -1 },
    { status: 'applied', worldTimeCostMs: NaN },
    { status: 'applied', worldTimeCostMs: Infinity },
    { status: 'applied', worldTimeCostMs: null },
  ])('fails invalid outcomes without committing progression: %#', async (invalid) => {
    const { engine, timing, logger } = await start({
      rules: rules({
        invalid: () => invalid as ActionOutcome,
        valid: () => ({ status: 'applied', advanceTurn: true }),
      }),
    })
    const events = observe(engine)
    engine.actions!.request('invalid')
    timing.drain()
    expect(events.failed).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    expect(engine.state).toBe('running')
    engine.actions!.request('valid')
    timing.drain()
    expect(engine.actions!.progression.turn).toBe(1)
    engine.stop()
    timing.drain()
  })

  it('reports exceptions and rejected promises as failures while preserving elapsed progression', async () => {
    const failure = new Error('Handler failed')
    const { engine, timing, logger } = await start({
      rules: rules(
        {
          throws: () => {
            throw failure
          },
          async: () =>
            Promise.reject(new Error('Unexpected async rejection')) as unknown as ActionOutcome,
        },
        [],
        { mode: 'hybrid' },
      ),
    })
    const events = observe(engine)
    const engineFailed = vi.fn()
    engine.messages!.subscribe('engine.failed', engineFailed)
    timing.now = 50
    engine.actions!.request('throws')
    engine.actions!.request('async')
    timing.drain()
    await Promise.resolve()
    expect(events.failed).toHaveBeenCalledTimes(2)
    expect(events.failed.mock.calls[0]![0].error).toBe(failure)
    expect((events.failed.mock.calls[1]![0].error as Error).message).toContain('synchronous')
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(engineFailed).not.toHaveBeenCalled()
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 50 })
    engine.stop()
    timing.drain()
  })

  it.each([
    rules({ known: () => ({ status: 'applied' }) }, [
      { context: 'gameplay', input: 'moveNorth', action: 'missing' },
    ]),
    rules({ known: () => ({ status: 'applied' }) }, [
      { context: 'gameplay', input: 'moveNorth', action: 'known' },
      { context: 'gameplay', input: 'moveNorth', phase: 'pressed', action: 'known' },
    ]),
    rules({ known: () => ({ status: 'applied' }) }, [
      { context: '', input: 'moveNorth', action: 'known' },
    ]),
    rules({ '': () => ({ status: 'applied' }) }),
    rules({}, [], { mode: 'invalid' } as unknown as WorldTimePolicy),
    rules({}, [], { mode: 'elapsed', rate: 0 }),
    rules({}, [], { mode: 'elapsed', rate: Infinity }),
    rules({}, [], { mode: 'elapsed', pulseMs: 0 }),
    rules({}, [], { mode: 'elapsed', pulseMs: 1.5 }),
    rules({}, [], { mode: 'elapsed', pulseMs: 2_147_483_648 }),
  ])('rejects invalid rules before mounting: %#', async (invalid) => {
    const { engine, timing, mount } = setup({ rules: invalid })
    const starting = engine.start()
    const failed = vi.fn()
    engine.messages!.subscribe('engine.failed', failed)
    await expect(starting).rejects.toThrow()
    timing.drain()
    expect(mount).not.toHaveBeenCalled()
    expect(engine.actions).toBeUndefined()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(timing.pending).toEqual([])
  })

  it('provides actions during mounting and exposes them on the engine only while running', async () => {
    let captured: EngineHostSession | undefined
    const handler = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const { engine, timing } = setup({
      rules: rules({ ready: handler }),
      host: {
        mount: (_game, session) => {
          captured = session
          expect(engine.actions).toBeUndefined()
          session.actions.request('ready')
          return () => {}
        },
      },
    })
    expect(engine.actions).toBeUndefined()
    await engine.start()
    expect(engine.actions).toBe(captured!.actions)
    expect(handler).not.toHaveBeenCalled()
    timing.drain()
    expect(handler).toHaveBeenCalledTimes(1)
    engine.stop()
    expect(engine.actions).toBeUndefined()
    timing.drain()
  })

  it('handles a rules factory that throws or stops startup without mounting', async () => {
    for (const shouldThrow of [true, false]) {
      const { engine, timing, mount } = setup({
        factory: () => {
          if (shouldThrow) throw new Error('Rules failed')
          engine.stop()
          return rules({})
        },
      })
      if (shouldThrow) await expect(engine.start()).rejects.toThrow('Rules failed')
      else await engine.start()
      timing.drain()
      expect(mount).not.toHaveBeenCalled()
      expect(engine.actions).toBeUndefined()
      expect(timing.pending).toEqual([])
    }
  })

  it('does not partially advance the turn if the resulting world time overflows', async () => {
    const { engine, timing } = await start({
      rules: rules({
        huge: () => ({ status: 'applied', worldTimeCostMs: Number.MAX_VALUE }),
        overflow: () => ({
          status: 'applied',
          advanceTurn: true,
          worldTimeCostMs: Number.MAX_VALUE,
        }),
      }),
    })
    const events = observe(engine)
    engine.actions!.request('huge')
    engine.actions!.request('overflow')
    timing.drain()
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: Number.MAX_VALUE })
    expect(events.applied).toHaveBeenCalledTimes(1)
    expect(events.failed).toHaveBeenCalledTimes(1)
    expect(events.turns).not.toHaveBeenCalled()
    engine.stop()
    timing.drain()
  })

  it('cancels queued work and owned timers on stop and disables retained references', async () => {
    const handler = vi.fn<GameActionHandler>(() => ({ status: 'applied', advanceTurn: true }))
    const { engine, timing } = await start({
      rules: rules({ move: handler }, [], { mode: 'elapsed' }),
    })
    const actions = engine.actions!
    actions.request('move')
    const timer = actions.schedule('move', 5)!
    const stale = [...timing.tasks]
    engine.stop()
    expect(actions.request('move')).toBeUndefined()
    expect(actions.schedule('move', 0)).toBeUndefined()
    expect(actions.cancelScheduled(timer)).toBe(false)
    timing.now = 2000
    for (const task of stale) task.run()
    timing.drain()
    expect(handler).not.toHaveBeenCalled()
    expect(actions.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    expect(timing.pending).toEqual([])
  })

  it('does not commit a handler result if the handler stops the engine', async () => {
    const { engine, timing } = await start({
      rules: rules({
        stop: () => {
          engine.stop()
          return { status: 'applied', advanceTurn: true, worldTimeCostMs: 10 }
        },
      }),
    })
    const actions = engine.actions!
    const events = observe(engine)
    actions.request('stop')
    actions.request('stop')
    timing.drain()
    expect(actions.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    expect(events.applied).not.toHaveBeenCalled()
    expect(engine.state).toBe('stopped')
  })

  it('creates fresh handler state, progression, and IDs on restart and ignores old callbacks', async () => {
    const counts: number[] = []
    const factory = vi.fn<GameRulesFactory>(() => {
      let moves = 0
      return rules({
        move: () => {
          counts.push(++moves)
          return { status: 'applied', advanceTurn: true, worldTimeCostMs: 10 }
        },
      })
    })
    const { engine, timing } = await start({ factory })
    const oldActions = engine.actions!
    oldActions.request('move')
    timing.drain()
    oldActions.schedule('move', 10)
    const oldTimer = timing.tasks.at(-1)!
    engine.stop()
    await engine.start()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenLastCalledWith(game)
    expect(engine.actions).not.toBe(oldActions)
    expect(engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    timing.now = 10
    oldTimer.run()
    expect(engine.actions!.request('move')).toBe(1)
    timing.drain()
    expect(counts).toEqual([1, 1])
    expect(engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: 10 })
    engine.stop()
    timing.drain()
  })

  it('disposes actions when mounting fails or stops the engine', async () => {
    for (const shouldThrow of [true, false]) {
      let captured: IGameActions | undefined
      const { engine, timing } = setup({
        rules: rules({}, [], { mode: 'elapsed' }),
        host: {
          mount: (_game, session) => {
            captured = session.actions
            session.actions.schedule('anything', 0)
            if (shouldThrow) throw new Error('Mount failed')
            engine.stop()
            return () => {}
          },
        },
      })
      if (shouldThrow) await expect(engine.start()).rejects.toThrow('Mount failed')
      else await engine.start()
      timing.drain()
      expect(captured!.request('anything')).toBeUndefined()
      expect(captured!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
      expect(timing.pending).toEqual([])
    }
  })

  it('keeps simultaneous engine progression and domain state isolated', async () => {
    const counts: number[] = []
    const factory: GameRulesFactory = () => {
      let count = 0
      return rules({
        move: () => {
          counts.push(++count)
          return { status: 'applied', advanceTurn: true }
        },
      })
    }
    const first = await start({ factory })
    const second = await start({ factory })
    first.engine.actions!.request('move')
    first.engine.actions!.request('move')
    first.timing.drain()
    second.engine.actions!.request('move')
    second.timing.drain()
    expect(counts).toEqual([1, 2, 1])
    expect(first.engine.actions!.progression.turn).toBe(2)
    expect(second.engine.actions!.progression.turn).toBe(1)
    for (const instance of [first, second]) {
      instance.engine.stop()
      instance.timing.drain()
    }
  })
})
