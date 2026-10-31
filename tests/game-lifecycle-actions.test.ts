import { describe, expect, it, vi } from 'vite-plus/test'
import {
  Engine,
  GameLifecycle,
  type EngineHostSession,
  type EngineMessages,
  type GameActionHandler,
  type GameData,
  type GameRules,
  type GameRulesFactory,
  type IEngineHost,
  type SceneData,
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

  drain(): void {
    let passes = 0
    while (true) {
      const task = this.pending
        .filter((task) => task.dueAt <= this.now)
        .sort((a, b) => a.dueAt - b.dueAt)[0]
      if (!task) return
      if (++passes > 100) throw new Error('Dispatch did not become idle')
      task.ran = true
      task.run()
    }
  }
}

const data: GameData = {
  id: 'lifecycle-actions',
  title: 'Lifecycle actions',
  description: '',
  version: '1',
  scenes: new Map<string, SceneData>(
    ['standard', 'inventory', 'settings'].map((id) => [
      id,
      {
        id,
        title: id,
        description: '',
        type: id === 'settings' ? 'stand-alone' : 'game',
        screen: { type: 'grid', grid: { rows: 20, columns: 20 } },
        components: [],
      },
    ]),
  ),
  input: {
    virtualKeys: ['confirm'],
    keyboard: { Enter: 'confirm' },
    contexts: { game: { confirm: 'confirm' } },
    initialContext: 'game',
  },
}

function setup(options: { factory?: GameRulesFactory; host?: IEngineHost } = {}) {
  const timing = new TestTiming()
  const handler = vi.fn<GameActionHandler>(() => ({
    status: 'applied',
    advanceTurn: true,
    worldTimeCostMs: 10,
  }))
  const factory = vi.fn<GameRulesFactory>(
    options.factory ??
      (() => ({
        handlers: new Map([['act', handler]]),
        inputBindings: [
          { context: 'game', input: 'confirm', action: 'act' },
          { context: 'game', input: 'confirm', action: 'act', phase: 'released' },
          { context: 'game', input: 'confirm', action: 'act', phase: 'cancelled' },
        ],
      })),
  )
  const disposedStates = vi.fn()
  const logger: ILogger = {
    debug: () => '',
    info: () => '',
    warn: () => '',
    error: vi.fn(() => ''),
  }
  const host = { mount: vi.fn<IEngineHost['mount']>(() => () => {}) }
  const engine = new Engine(
    { load: async () => data },
    options.host ?? host,
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      clock: timing.clock,
      scheduler: timing.scheduler,
      createGameRules: factory,
      createGameLifecycle: (content) =>
        new GameLifecycle(content, {
          createGameState: () => ({ score: 0 }),
          createSceneState: () => undefined,
          disposeGameState: disposedStates,
        }),
    },
  )
  return { engine, timing, handler, factory, disposedStates, logger, host }
}

describe('playthrough-owned actions and progression', () => {
  it('creates services only on explicit game start and updates host accessors across games', async () => {
    const { engine, timing, factory, host } = setup()
    await engine.start()
    timing.drain()
    const session = host.mount.mock.calls[0]![1]
    const lifecycle = engine.lifecycle!
    expect(factory).not.toHaveBeenCalled()
    expect(engine.actions).toBeUndefined()
    expect(session.actions).toBeUndefined()
    expect(timing.pending).toEqual([])

    const first = lifecycle.startGame()
    expect(engine.actions).toBe(first.actions)
    expect(session.actions).toBe(first.actions)
    expect(factory).toHaveBeenCalledExactlyOnceWith(data, first)
    const old = first.actions!
    lifecycle.endGame()
    expect(engine.state).toBe('running')
    expect(engine.game).toBe(data)
    expect(engine.actions).toBeUndefined()
    expect(session.actions).toBeUndefined()
    expect(first.actions).toBeUndefined()
    expect(old.request('act')).toBeUndefined()
    expect(lifecycle.startGame().actions).not.toBe(old)
    expect(session.actions).toBe(engine.actions)
    engine.stop()
    timing.drain()
  })

  it('preserves actions, turn membership, and progression through every scene transition', async () => {
    const { engine, timing, factory } = setup({
      factory: () => ({
        handlers: new Map<string, GameActionHandler>([
          ['act', () => ({ status: 'applied', advanceTurn: true, worldTimeCostMs: 10 })],
        ]),
        turns: {
          actors: ['player', 'opponent'],
          phases: ['act'],
          actionPolicies: new Map([['act', { scope: 'actor' }]]),
        },
      }),
    })
    await engine.start()
    const lifecycle = engine.lifecycle!
    const game = lifecycle.startGame()
    const actions = game.actions!
    lifecycle.enterScene('standard')
    actions.request('act', undefined, { actorId: 'player' })
    timing.drain()
    const progression = actions.progression
    const turn = actions.turnState
    const roster = actions.rosterState

    for (const scene of ['inventory', 'settings', 'standard']) {
      lifecycle.enterScene(scene)
      expect(engine.actions).toBe(actions)
      expect(actions.progression).toBe(progression)
      expect(actions.turnState).toBe(turn)
      expect(actions.rosterState).toBe(roster)
    }
    expect(progression).toEqual({ turn: 1, worldTimeMs: 10 })
    expect(turn?.actorId).toBe('opponent')
    expect(factory).toHaveBeenCalledTimes(1)
    engine.stop()
    timing.drain()
  })

  it('resets rules and IDs and discards queued requests, input, outcomes, and fired timers', async () => {
    const counts: number[] = []
    const { engine, timing, factory } = setup({
      factory: () => {
        let count = 0
        return {
          handlers: new Map([
            [
              'act',
              () => {
                counts.push(++count)
                return { status: 'applied', advanceTurn: true, worldTimeCostMs: 10 }
              },
            ],
          ]),
          inputBindings: [{ context: 'game', input: 'confirm', action: 'act' }],
        }
      },
    })
    await engine.start()
    const lifecycle = engine.lifecycle!
    const first = lifecycle.startGame()
    const old = first.actions!
    old.request('act')
    // Queue an old outcome without delivering it to public observers yet.
    engine.flushMessages()
    const applied = vi.fn()
    engine.messages!.subscribe('action.applied', applied)
    const oldTimerId = old.schedule('act', 0)!
    const firedTimer = timing.tasks.at(-1)!
    firedTimer.run()
    old.schedule('act', 50)
    old.scheduleWorld('act', 20)
    old.request('act')
    engine.input!.pressKey('Enter')
    const staleTasks = [...timing.tasks]

    const second = lifecycle.startGame()
    const current = second.actions!
    expect(factory).toHaveBeenCalledTimes(2)
    expect(first.disposed).toBe(true)
    expect(current.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    expect(old.schedule('act', 0)).toBeUndefined()
    expect(old.scheduleWorld('act', 0)).toBeUndefined()
    expect(old.cancelScheduled(oldTimerId)).toBe(false)
    expect(current.request('act')).toBe(1)
    for (const task of staleTasks) task.run()
    timing.drain()
    expect(counts).toEqual([1, 1])
    expect(applied).toHaveBeenCalledTimes(1)
    expect(current.progression).toEqual({ turn: 1, worldTimeMs: 10 })
    expect(old.progression).toEqual({ turn: 1, worldTimeMs: 10 })
    engine.stop()
    timing.drain()
  })

  it('cancels game alarms on end while leaving engine timers usable and isolated', async () => {
    const { engine, timing, handler } = setup({
      factory: () => ({
        handlers: new Map([['act', handler]]),
        worldTime: { mode: 'elapsed', pulseMs: 10 },
      }),
    })
    await engine.start()
    const lifecycle = engine.lifecycle!
    const old = lifecycle.startGame().actions!
    timing.drain()
    const timer = old.schedule('act', 10)!
    old.scheduleWorld('act', 10)
    const stale = [...timing.tasks]
    lifecycle.endGame()
    timing.drain()
    expect(timing.pending).toEqual([])
    const wakeup = vi.fn()
    engine.messages!.subscribe('timer.wakeup', wakeup)
    const hostTimer = engine.timers!.schedule(10)
    const current = lifecycle.startGame().actions!
    const currentTimer = current.schedule('act', 10)!
    expect(current.cancelScheduled(timer)).toBe(false)
    expect(current.cancelScheduled(hostTimer!)).toBe(false)
    expect(currentTimer).not.toBe(hostTimer)
    timing.now = 10
    for (const task of stale) task.run()
    timing.drain()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(wakeup.mock.calls.some(([event]) => event.timerId === hostTimer)).toBe(true)
    engine.stop()
    timing.drain()
  })

  it('starts elapsed time at game start and continues it while a stand-alone scene is shown', async () => {
    const { engine, timing } = setup({
      factory: () => ({ handlers: new Map(), worldTime: { mode: 'elapsed', pulseMs: 10 } }),
    })
    await engine.start()
    timing.now = 1000
    timing.drain()
    const lifecycle = engine.lifecycle!
    const first = lifecycle.startGame().actions!
    expect(first.progression.worldTimeMs).toBe(0)
    lifecycle.enterScene('settings')
    timing.now = 1020
    timing.drain()
    expect(first.progression.worldTimeMs).toBe(20)
    lifecycle.endGame()
    const settings = lifecycle.activeScene
    timing.now = 2000
    timing.drain()
    const second = lifecycle.startGame().actions!
    expect(lifecycle.activeScene).toBe(settings)
    expect(second.progression.worldTimeMs).toBe(0)
    expect(first.progression.worldTimeMs).toBe(20)
    engine.stop()
    timing.drain()
  })

  it('keeps stand-alone and pre-game keyboard events from becoming gameplay actions', async () => {
    const { engine, timing, handler } = setup()
    await engine.start()
    const lifecycle = engine.lifecycle!
    engine.input!.pressKey('Enter')
    lifecycle.startGame()
    timing.drain()
    expect(handler).not.toHaveBeenCalled()
    lifecycle.enterScene('settings')
    engine.input!.pressKey('Enter')
    lifecycle.enterScene('standard')
    engine.input!.releaseKey('Enter')
    timing.drain()
    expect(handler).not.toHaveBeenCalled()
    engine.input!.pressKey('Enter')
    lifecycle.enterScene('settings')
    timing.drain()
    engine.input!.releaseKey('Enter')
    timing.drain()
    expect(handler).not.toHaveBeenCalled()
    lifecycle.enterScene('standard')
    engine.input!.pressKey('Enter')
    timing.drain()
    expect(handler).toHaveBeenCalledTimes(1)
    engine.stop()
    timing.drain()
  })

  it.each(['end', 'replace'] as const)(
    'does not commit an action that calls lifecycle %s, or run its queued follow-up',
    async (transition) => {
      const { engine, timing } = setup({
        factory: () => ({
          handlers: new Map([
            [
              'transition',
              () => {
                if (transition === 'end') engine.lifecycle!.endGame()
                else engine.lifecycle!.startGame()
                return { status: 'applied', advanceTurn: true, worldTimeCostMs: 10 }
              },
            ],
          ]),
        }),
      })
      await engine.start()
      const old = engine.lifecycle!.startGame().actions!
      const applied = vi.fn()
      engine.messages!.subscribe('action.applied', applied)
      old.request('transition')
      old.request('transition')
      timing.drain()
      expect(old.progression).toEqual({ turn: 0, worldTimeMs: 0 })
      expect(applied).not.toHaveBeenCalled()
      expect(engine.state).toBe('running')
      if (transition === 'replace')
        expect(engine.actions?.progression).toEqual({ turn: 0, worldTimeMs: 0 })
      else expect(engine.actions).toBeUndefined()
      engine.stop()
      timing.drain()
    },
  )

  it('preserves the existing game and scene when replacement rules are invalid', async () => {
    const { engine, timing, factory, disposedStates, handler } = setup()
    await engine.start()
    const lifecycle = engine.lifecycle!
    const original = lifecycle.startGame()
    const scene = lifecycle.enterScene('standard')
    original.actions!.request('act')
    timing.drain()
    const invalid: GameRules = { handlers: new Map(), worldTime: { mode: 'elapsed', rate: -1 } }
    factory.mockReturnValueOnce(invalid)

    expect(() => lifecycle.startGame()).toThrow('positive and finite')
    expect(lifecycle.currentGame).toBe(original)
    expect(lifecycle.activeScene).toBe(scene)
    expect(original.disposed).toBe(false)
    expect(disposedStates).toHaveBeenCalledTimes(1)
    original.actions!.request('act')
    timing.drain()
    expect(handler).toHaveBeenCalledTimes(2)
    expect(original.actions!.progression).toEqual({ turn: 2, worldTimeMs: 20 })
    engine.stop()
    timing.drain()
  })

  it('checks ownership between subscribers when a subscriber replaces the game', async () => {
    const { engine, timing, handler } = setup()
    await engine.start()
    const unsubscribe = engine.messages!.subscribe('action.requested', () => {
      unsubscribe()
      engine.lifecycle!.startGame().actions!.request('act')
    })
    const old = engine.lifecycle!.startGame().actions!
    old.request('act')
    old.request('act')
    timing.drain()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(old.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    expect(engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: 10 })
    engine.stop()
    timing.drain()
  })

  it('rolls back a failed runtime start and keeps the previous game usable', async () => {
    const { engine, timing, factory, disposedStates, handler } = setup()
    await engine.start()
    const lifecycle = engine.lifecycle!
    const original = lifecycle.startGame()
    const scene = lifecycle.enterScene('standard')
    factory.mockReturnValueOnce({
      handlers: new Map(),
      worldTime: { mode: 'elapsed', pulseMs: 10 },
    })
    const schedule = timing.scheduler.schedule
    timing.scheduler.schedule = (run, delay) => {
      if (delay === 10) throw new Error('Cannot schedule world pulse')
      return schedule(run, delay)
    }

    expect(() => lifecycle.startGame()).toThrow('Cannot schedule world pulse')
    timing.scheduler.schedule = schedule
    expect(lifecycle.currentGame).toBe(original)
    expect(lifecycle.activeScene).toBe(scene)
    expect(disposedStates).toHaveBeenCalledTimes(1)
    engine.input!.pressKey('Enter')
    timing.drain()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(original.actions?.progression).toEqual({ turn: 1, worldTimeMs: 10 })
    engine.stop()
    timing.drain()
  })

  it('exposes mounting-time game actions but starts elapsed accounting after mounting', async () => {
    let session: EngineHostSession | undefined
    const instance = setup({
      factory: () => ({ handlers: new Map(), worldTime: { mode: 'elapsed', pulseMs: 10 } }),
      host: {
        mount(_data, services) {
          session = services
          expect(services.actions).toBeUndefined()
          const game = services.lifecycle.startGame()
          expect(services.actions).toBe(game.actions)
          instance.timing.now = 1000
          return () => {}
        },
      },
    })
    await instance.engine.start()
    expect(session!.actions).toBe(instance.engine.actions)
    expect(instance.engine.actions?.progression.worldTimeMs).toBe(0)
    instance.timing.now = 1020
    instance.timing.drain()
    expect(instance.engine.actions?.progression.worldTimeMs).toBe(20)
    instance.engine.stop()
    instance.timing.drain()
  })
})
