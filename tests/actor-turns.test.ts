import { describe, expect, it, vi } from 'vite-plus/test'
import {
  Engine,
  type ActionOutcome,
  type ActionRequestOptions,
  type ActionTurnPolicy,
  type EngineMessages,
  type GameActionHandler,
  type GameData,
  type GameRules,
  type IEngineHost,
  type InputActionBinding,
  type WorldTimePolicy,
} from '@ancadeba/game-runtime'
import { MessageBus, type ILogger } from '@ancadeba/utilities'

class TestTiming {
  now = 0
  readonly tasks: { run: () => void; dueAt: number; ran: boolean; cancelled: boolean }[] = []
  readonly clock = { now: () => this.now }
  readonly scheduler = {
    schedule: (run: () => void, delay: number) => {
      const task = { run, dueAt: this.now + delay, ran: false, cancelled: false }
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
    let count = 0
    while (this.pending.some((task) => task.dueAt <= this.now)) {
      if (++count > 100) throw new Error('Tasks did not become idle')
      this.runNext()
    }
  }
}

const game: GameData = {
  id: 'turns',
  title: 'Turns',
  description: '',
  version: '1',
  scenes: new Map(),
  input: {
    virtualKeys: ['move', 'end'],
    keyboard: { KeyM: 'move', KeyE: 'end' },
    contexts: { game: { move: 'move', end: 'end' } },
    initialContext: 'game',
  },
}

function configured(
  options: {
    actors?: readonly string[]
    phases?: readonly string[]
    policies?: ReadonlyMap<string, ActionTurnPolicy>
    handlers?: Record<string, GameActionHandler>
    bindings?: readonly InputActionBinding[]
    worldTime?: WorldTimePolicy
  } = {},
): GameRules {
  return {
    handlers: new Map<string, GameActionHandler>([
      ['phase', () => ({ status: 'applied', advancePhase: true })],
      ['end', () => ({ status: 'applied', advanceTurn: true })],
      ['act', () => ({ status: 'applied' })],
      ['weather', () => ({ status: 'applied' })],
      ['cost', (request) => ({ status: 'applied', worldTimeCostMs: request.payload as number })],
      ...Object.entries(options.handlers ?? {}),
    ]),
    turns: {
      actors: options.actors ?? ['a', 'b'],
      phases: options.phases ?? ['setup', 'play', 'cleanup'],
      actionPolicies: new Map<string, ActionTurnPolicy>([
        ['phase', { scope: 'actor' }],
        ['end', { scope: 'actor' }],
        ['act', { scope: 'actor' }],
        ['weather', { scope: 'global' }],
        ['cost', { scope: 'global' }],
        ...(options.policies ?? []),
      ]),
    },
    inputBindings: options.bindings ?? [],
    worldTime: options.worldTime ?? { mode: 'action-driven' },
  }
}

function setup(
  options: {
    rules?: GameRules
    policy?: WorldTimePolicy
    bindings?: readonly InputActionBinding[]
    host?: IEngineHost
    handlers?: Record<string, GameActionHandler>
  } = {},
) {
  const timing = new TestTiming()
  const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
  const weather = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
  const rules =
    options.rules ??
    configured({
      handlers: { act, weather, ...options.handlers },
      ...(options.policy ? { worldTime: options.policy } : {}),
      ...(options.bindings ? { bindings: options.bindings } : {}),
    })
  const logger = {
    debug: () => '',
    info: () => '',
    warn: () => '',
    error: vi.fn(() => ''),
  } satisfies ILogger
  const mount = vi.fn<IEngineHost['mount']>(() => () => {})
  const factory = vi.fn(() => rules)
  const engine = new Engine(
    { load: async () => game },
    options.host ?? { mount },
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      clock: timing.clock,
      scheduler: timing.scheduler,
      createGameRules: factory,
    },
  )
  return { engine, timing, act, weather, logger, mount, factory }
}

async function start(options: Parameters<typeof setup>[0] = {}) {
  const instance = setup(options)
  await instance.engine.start()
  instance.timing.drain()
  return instance
}

function stop(instance: ReturnType<typeof setup>): void {
  instance.engine.stop()
  instance.timing.drain()
}

function actorAction(instance: ReturnType<typeof setup>, action: string): void {
  instance.engine.actions!.request(action, undefined, {
    actorId: instance.engine.actions!.turnState!.actorId,
  })
  instance.timing.drain()
}

describe('cyclic actor turns and phases', () => {
  it('starts with the first actor and phase and publishes a frozen initial snapshot', async () => {
    const instance = setup()
    expect(instance.engine.actions).toBeUndefined()
    const starting = instance.engine.start()
    const started = vi.fn()
    instance.engine.messages!.subscribe('turn.started', started)
    await starting
    const initial = instance.engine.actions!.turnState!
    expect(initial).toEqual({ actorId: 'a', phaseId: 'setup', round: 1, revision: 0 })
    expect(Object.isFrozen(initial)).toBe(true)
    expect(started).not.toHaveBeenCalled()
    instance.timing.drain()
    expect(started).toHaveBeenCalledExactlyOnceWith({
      turnState: initial,
      progression: { turn: 0, worldTimeMs: 0 },
    })
    stop(instance)
  })

  it('advances phases, wraps actors, and advances the round after the final actor', async () => {
    const instance = await start()
    const { engine } = instance
    const events: string[] = []
    for (const topic of [
      'turn.advanced',
      'turn.phaseChanged',
      'turn.ended',
      'turn.roundAdvanced',
      'turn.started',
      'action.applied',
    ] as const)
      engine.messages!.subscribe(topic, () => events.push(topic))
    actorAction(instance, 'phase')
    expect(engine.actions!.turnState).toEqual({
      actorId: 'a',
      phaseId: 'play',
      round: 1,
      revision: 1,
    })
    expect(engine.actions!.progression.turn).toBe(0)
    actorAction(instance, 'phase')
    expect(engine.actions!.turnState?.phaseId).toBe('cleanup')
    actorAction(instance, 'phase')
    expect(engine.actions!.turnState).toEqual({
      actorId: 'b',
      phaseId: 'setup',
      round: 1,
      revision: 3,
    })
    expect(engine.actions!.progression.turn).toBe(1)
    actorAction(instance, 'end')
    expect(engine.actions!.turnState).toEqual({
      actorId: 'a',
      phaseId: 'setup',
      round: 2,
      revision: 4,
    })
    expect(engine.actions!.progression).toEqual({ turn: 2, worldTimeMs: 0 })
    expect(events).toEqual([
      'turn.phaseChanged',
      'action.applied',
      'turn.phaseChanged',
      'action.applied',
      'turn.advanced',
      'turn.ended',
      'turn.started',
      'action.applied',
      'turn.advanced',
      'turn.ended',
      'turn.roundAdvanced',
      'turn.started',
      'action.applied',
    ])
    stop(instance)
  })

  it('ends a turn early without emitting skipped phase transitions', async () => {
    const instance = await start()
    const changed = vi.fn()
    const ended = vi.fn<(event: EngineMessages['turn.ended']) => void>()
    instance.engine.messages!.subscribe('turn.phaseChanged', changed)
    instance.engine.messages!.subscribe('turn.ended', ended)
    actorAction(instance, 'end')
    expect(changed).not.toHaveBeenCalled()
    expect(ended.mock.calls[0]![0]).toEqual({
      previous: { actorId: 'a', phaseId: 'setup', round: 1, revision: 0 },
      turnState: { actorId: 'b', phaseId: 'setup', round: 1, revision: 1 },
      progression: { turn: 1, worldTimeMs: 0 },
    })
    stop(instance)
  })

  it('increments round and revision for a single actor and phase, invalidating queued requests', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await start({
      rules: configured({ actors: ['a'], phases: ['only'], handlers: { act } }),
    })
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.engine.actions!.request('phase', undefined, { actorId: 'a' })
    instance.engine.actions!.request('act', undefined, { actorId: 'a' })
    instance.timing.drain()
    expect(instance.engine.actions!.turnState).toEqual({
      actorId: 'a',
      phaseId: 'only',
      round: 2,
      revision: 1,
    })
    expect(instance.engine.actions!.progression.turn).toBe(1)
    expect(act).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]![0].reason).toContain('Stale')
    stop(instance)
  })

  it('captures committed turn snapshots in outcomes and orders progression before coordinator notifications', async () => {
    const instance = await start({
      handlers: { end: () => ({ status: 'applied', advanceTurn: true, worldTimeCostMs: 10 }) },
    })
    const order: string[] = []
    const applied = vi.fn<(event: EngineMessages['action.applied']) => void>()
    for (const topic of [
      'turn.advanced',
      'world-time.advanced',
      'turn.ended',
      'turn.started',
      'action.applied',
    ] as const)
      instance.engine.messages!.subscribe(topic, () => order.push(topic))
    instance.engine.messages!.subscribe('action.applied', applied)
    actorAction(instance, 'end')
    const snapshot = applied.mock.calls[0]![0].turnState!
    expect(snapshot).toEqual({ actorId: 'b', phaseId: 'setup', round: 1, revision: 1 })
    expect(order).toEqual([
      'turn.advanced',
      'world-time.advanced',
      'turn.ended',
      'turn.started',
      'action.applied',
    ])
    actorAction(instance, 'phase')
    expect(snapshot.phaseId).toBe('setup')
    expect(Object.isFrozen(snapshot)).toBe(true)
    stop(instance)
  })
})

describe('actor request eligibility and attribution', () => {
  it('rejects missing, unknown, inactive, and globally attributed actors before handlers', async () => {
    const instance = await start()
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.engine.actions!.request('act')
    instance.engine.actions!.request('act', undefined, { actorId: 'unknown' })
    instance.engine.actions!.request('act', undefined, { actorId: 'b' })
    instance.engine.actions!.request('weather', undefined, { actorId: 'a' })
    instance.timing.drain()
    expect(instance.act).not.toHaveBeenCalled()
    expect(instance.weather).not.toHaveBeenCalled()
    expect(rejected.mock.calls.map(([event]) => event.reason)).toEqual([
      'Actor action requires actor attribution',
      'Unknown actor: unknown',
      'Inactive actor: b',
      'Global actions must be actorless',
    ])
    expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    stop(instance)
  })

  it('checks allowed phases at execution and exposes turn state to eligible handlers', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await start({
      rules: configured({
        handlers: { act },
        policies: new Map([['act', { scope: 'actor', allowedPhases: ['play'] }]]),
      }),
    })
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.engine.actions!.request('act', undefined, { actorId: 'a' })
    instance.timing.drain()
    expect(act).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]![0].reason).toContain('phase: setup')
    actorAction(instance, 'phase')
    actorAction(instance, 'act')
    expect(act.mock.calls[0]![1].turnState).toEqual({
      actorId: 'a',
      phaseId: 'play',
      round: 1,
      revision: 1,
    })
    stop(instance)
  })

  it('rejects requests queued before a phase transition even if the action permits both phases', async () => {
    const instance = await start()
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.engine.actions!.request('phase', undefined, { actorId: 'a' })
    instance.engine.actions!.request('act', undefined, { actorId: 'a' })
    instance.timing.drain()
    expect(instance.act).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]![0].reason).toContain('Stale')
    stop(instance)
  })

  it('keeps a handler-generated followup on the revision captured before its transition', async () => {
    const instance = await start({
      handlers: {
        phase: (_request, context) => {
          context.actions.request('act', undefined, { actorId: context.turnState!.actorId })
          return { status: 'applied', advancePhase: true }
        },
      },
    })
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    actorAction(instance, 'phase')
    expect(instance.act).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]![0].request.actor).toEqual({ actorId: 'a', turnRevision: 0 })
    expect(instance.engine.actions!.turnState?.revision).toBe(1)
    stop(instance)
  })

  it('supports fixed-player and active-actor input bindings', async () => {
    const instance = await start({
      bindings: [
        { context: 'game', input: 'move', action: 'act', actor: { type: 'fixed', actorId: 'a' } },
        { context: 'game', input: 'end', action: 'end', actor: { type: 'active' } },
      ],
    })
    const { engine, timing, act } = instance
    const requests: EngineMessages['action.requested'][] = []
    engine.messages!.subscribe('action.requested', (request) => requests.push(request))
    engine.input!.pressKey('KeyM')
    engine.input!.releaseKey('KeyM')
    timing.drain()
    expect(act).toHaveBeenCalledTimes(1)
    actorAction(instance, 'end')
    engine.input!.pressKey('KeyM')
    engine.input!.releaseKey('KeyM')
    timing.drain()
    expect(act).toHaveBeenCalledTimes(1)
    engine.input!.pressKey('KeyE')
    engine.input!.releaseKey('KeyE')
    timing.drain()
    expect(requests.at(-1)!.actor).toEqual({ actorId: 'b', turnRevision: 1 })
    expect(engine.actions!.turnState?.actorId).toBe('a')
    stop(instance)
  })

  it('captures an active input actor at conversion rather than reassigning it at execution', async () => {
    const instance = await start({
      bindings: [{ context: 'game', input: 'move', action: 'act', actor: { type: 'active' } }],
    })
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.engine.input!.pressKey('KeyM')
    instance.engine.actions!.request('end', undefined, { actorId: 'a' })
    instance.timing.drain()
    expect(instance.act).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]![0].request.actor).toEqual({ actorId: 'a', turnRevision: 0 })
    expect(instance.engine.actions!.turnState?.actorId).toBe('b')
    stop(instance)
  })

  it('copies actor options at registration and does not inherit ambient actor identity', async () => {
    const instance = await start()
    const options: { actorId: string } = { actorId: 'a' }
    instance.engine.actions!.schedule('act', 5, 'payload', options)
    options.actorId = 'b'
    instance.timing.now = 5
    instance.timing.drain()
    expect(instance.act.mock.calls[0]![0].actor).toEqual({ actorId: 'a', turnRevision: 0 })
    expect(Object.isFrozen(instance.act.mock.calls[0]![0].actor)).toBe(true)
    instance.engine.actions!.request('act')
    instance.timing.drain()
    expect(instance.act).toHaveBeenCalledTimes(1)
    stop(instance)
  })

  it.each(['host', 'world-relative', 'world-absolute'] as const)(
    'retains stale actor attribution for %s schedules while global effects remain valid',
    async (kind) => {
      const instance = await start()
      const { engine, timing } = instance
      const options: ActionRequestOptions = { actorId: 'a' }
      if (kind === 'host') {
        engine.actions!.schedule('act', 10, undefined, options)
        engine.actions!.schedule('weather', 10)
      } else if (kind === 'world-relative') {
        engine.actions!.scheduleWorld('act', 10, undefined, options)
        engine.actions!.scheduleWorld('weather', 10)
      } else {
        engine.actions!.scheduleWorldAt('act', 10, undefined, options)
        engine.actions!.scheduleWorldAt('weather', 10)
      }
      const rejected = vi.fn()
      engine.messages!.subscribe('action.rejected', rejected)
      actorAction(instance, 'phase')
      if (kind === 'host') timing.now = 10
      else engine.actions!.request('cost', 10)
      timing.drain()
      expect(instance.act).not.toHaveBeenCalled()
      expect(instance.weather).toHaveBeenCalledTimes(1)
      expect(rejected.mock.calls[0]![0].reason).toContain('Stale')
      expect(rejected.mock.calls[0]![0].request.actor).toEqual({ actorId: 'a', turnRevision: 0 })
      expect(engine.actions!.turnState?.phaseId).toBe('play')
      stop(instance)
    },
  )

  it('rejects a scheduled request from an earlier round even when the actor and phase match again', async () => {
    const instance = await start()
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.engine.actions!.schedule('act', 10, undefined, { actorId: 'a' })
    actorAction(instance, 'end')
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState).toMatchObject({
      actorId: 'a',
      phaseId: 'setup',
      round: 2,
    })
    instance.timing.now = 10
    instance.timing.drain()
    expect(instance.act).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]![0].reason).toContain('Stale')
    stop(instance)
  })
})

describe('turn and world-time independence', () => {
  it('keeps global host and world effects running across actor and phase transitions', async () => {
    const instance = await start({ policy: { mode: 'hybrid' } })
    const { engine, timing, weather } = instance
    engine.actions!.schedule('weather', 50)
    engine.actions!.scheduleWorld('weather', 100)
    actorAction(instance, 'end')
    expect(engine.actions!.progression.worldTimeMs).toBe(0)
    timing.now = 50
    timing.drain()
    expect(weather).toHaveBeenCalledTimes(1)
    expect(weather.mock.calls[0]![1].turnState).toMatchObject({ actorId: 'b', phaseId: 'setup' })
    actorAction(instance, 'phase')
    timing.now = 100
    timing.drain()
    expect(weather).toHaveBeenCalledTimes(2)
    expect(weather.mock.calls[1]![1].turnState).toMatchObject({ actorId: 'b', phaseId: 'play' })
    expect(engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: 100 })
    stop(instance)
  })

  it('does not make an actor request stale when only world time changes', async () => {
    const instance = await start({ policy: { mode: 'elapsed' } })
    instance.engine.actions!.schedule('act', 500, undefined, { actorId: 'a' })
    instance.engine.actions!.scheduleWorld('weather', 200)
    instance.timing.now = 500
    instance.timing.drain()
    expect(instance.weather).toHaveBeenCalledTimes(1)
    expect(instance.act).toHaveBeenCalledTimes(1)
    expect(instance.engine.actions!.turnState?.revision).toBe(0)
    expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 500 })
    stop(instance)
  })

  it('still synchronizes elapsed time and due effects when actor eligibility fails', async () => {
    const instance = await start({ policy: { mode: 'hybrid' } })
    instance.engine.actions!.scheduleWorldAt('weather', 50)
    instance.timing.now = 100
    instance.engine.actions!.request('act', undefined, { actorId: 'b' })
    instance.timing.drain()
    expect(instance.act).not.toHaveBeenCalled()
    expect(instance.weather).toHaveBeenCalledTimes(1)
    expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 100 })
    stop(instance)
  })
})

describe('turn outcome validation and atomic commits', () => {
  it.each([
    { status: 'applied', advancePhase: true, advanceTurn: true, worldTimeCostMs: 10 },
    { status: 'applied', advancePhase: 1, worldTimeCostMs: 10 },
    { status: 'applied', advancePhase: null, worldTimeCostMs: 10 },
  ])('fails invalid turn outcomes without committing state: %#', async (outcome) => {
    const instance = await start({ handlers: { act: () => outcome as ActionOutcome } })
    const failed = vi.fn()
    instance.engine.messages!.subscribe('action.failed', failed)
    const initial = instance.engine.actions!.turnState
    actorAction(instance, 'act')
    expect(failed).toHaveBeenCalledTimes(1)
    expect(instance.engine.actions!.turnState).toBe(initial)
    expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    stop(instance)
  })

  it.each(['advanceTurn', 'advancePhase'] as const)(
    'prevents global actions from requesting %s',
    async (flag) => {
      const instance = await start({
        handlers: { weather: () => ({ status: 'applied', [flag]: true, worldTimeCostMs: 10 }) },
      })
      const failed = vi.fn()
      instance.engine.messages!.subscribe('action.failed', failed)
      instance.engine.actions!.request('weather')
      instance.timing.drain()
      expect(failed.mock.calls[0]![0].error.message).toContain('Global actions')
      expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
      expect(instance.engine.actions!.turnState?.revision).toBe(0)
      stop(instance)
    },
  )

  it('does not partially transition actors when progression overflows', async () => {
    const instance = await start({
      handlers: {
        end: () => ({ status: 'applied', advanceTurn: true, worldTimeCostMs: Number.MAX_VALUE }),
      },
    })
    const failed = vi.fn()
    const ended = vi.fn()
    instance.engine.messages!.subscribe('action.failed', failed)
    instance.engine.messages!.subscribe('turn.ended', ended)
    instance.engine.actions!.request('cost', Number.MAX_VALUE)
    instance.timing.drain()
    const initial = instance.engine.actions!.turnState
    actorAction(instance, 'end')
    expect(failed).toHaveBeenCalledTimes(1)
    expect(ended).not.toHaveBeenCalled()
    expect(instance.engine.actions!.turnState).toBe(initial)
    expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: Number.MAX_VALUE })
    stop(instance)
  })

  it('does not commit a prepared turn after a handler stops the engine', async () => {
    const instance = await start({
      handlers: {
        end: () => {
          instance.engine.stop()
          return { status: 'applied', advanceTurn: true }
        },
      },
    })
    const retained = instance.engine.actions!
    const initial = retained.turnState
    retained.request('end', undefined, { actorId: 'a' })
    instance.timing.drain()
    expect(retained.turnState).toBe(initial)
    expect(retained.progression.turn).toBe(0)
    expect(instance.engine.state).toBe('stopped')
  })

  it('keeps legacy numeric turns compatible and rejects phase advances without configuration', async () => {
    const handler = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await start({
      rules: {
        handlers: new Map<string, GameActionHandler>([
          ['end', () => ({ status: 'applied', advanceTurn: true })],
          ['phase', () => ({ status: 'applied', advancePhase: true, worldTimeCostMs: 10 })],
          ['act', handler],
        ]),
      },
    })
    const failed = vi.fn()
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.failed', failed)
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.engine.actions!.request('end')
    instance.engine.actions!.request('phase')
    instance.engine.actions!.request('act', undefined, { actorId: 'a' })
    instance.timing.drain()
    expect(instance.engine.actions!.turnState).toBeUndefined()
    expect(instance.engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: 0 })
    expect(failed).toHaveBeenCalledTimes(1)
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
    stop(instance)
  })
})

describe('turn configuration and session lifecycle', () => {
  const invalidConfigurations: GameRules[] = []
  for (const patch of [
    { actors: [] },
    { actors: ['a', 'a'] },
    { actors: [''] },
    { phases: [] },
    { phases: ['play', 'play'] },
    { phases: [' '] },
  ]) {
    const base = configured()
    invalidConfigurations.push({ ...base, turns: { ...base.turns!, ...patch } })
  }
  for (const policy of [
    { scope: 'actor', allowedPhases: [] },
    { scope: 'actor', allowedPhases: ['play', 'play'] },
    { scope: 'actor', allowedPhases: ['unknown'] },
    { scope: 'global', allowedPhases: ['play'] },
    { scope: 'invalid' },
  ]) {
    invalidConfigurations.push(
      configured({ policies: new Map([['act', policy as ActionTurnPolicy]]) }),
    )
  }
  const base = configured()
  const missing = new Map(base.turns!.actionPolicies)
  missing.delete('act')
  invalidConfigurations.push({ ...base, turns: { ...base.turns!, actionPolicies: missing } })
  invalidConfigurations.push(configured({ policies: new Map([['unknown', { scope: 'global' }]]) }))
  for (const binding of [
    { context: 'game', input: 'move', action: 'act' },
    { context: 'game', input: 'move', action: 'act', actor: { type: 'fixed', actorId: 'unknown' } },
    { context: 'game', input: 'move', action: 'weather', actor: { type: 'active' } },
    { context: 'game', input: 'move', action: 'act', actor: { type: 'invalid' } },
  ])
    invalidConfigurations.push(configured({ bindings: [binding as InputActionBinding] }))
  invalidConfigurations.push({
    handlers: new Map([['act', () => ({ status: 'applied' })]]),
    inputBindings: [{ context: 'game', input: 'move', action: 'act', actor: { type: 'active' } }],
  })

  it.each(invalidConfigurations)(
    'rejects invalid turn rules before mounting: %#',
    async (rules) => {
      const instance = setup({ rules })
      const starting = instance.engine.start()
      const failed = vi.fn()
      const turnStarted = vi.fn()
      instance.engine.messages!.subscribe('engine.failed', failed)
      instance.engine.messages!.subscribe('turn.started', turnStarted)
      await expect(starting).rejects.toThrow()
      instance.timing.drain()
      expect(instance.mount).not.toHaveBeenCalled()
      expect(failed).toHaveBeenCalledTimes(1)
      expect(turnStarted).not.toHaveBeenCalled()
      expect(instance.timing.pending).toEqual([])
    },
  )

  it('copies the fixed roster, phases, policies, and input selectors', async () => {
    const actors = ['a', 'b']
    const phases = ['setup', 'play']
    const allowed = ['play']
    const selector = { type: 'fixed' as const, actorId: 'a' }
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await start({
      rules: configured({
        actors,
        phases,
        handlers: { act },
        policies: new Map([['act', { scope: 'actor', allowedPhases: allowed }]]),
        bindings: [{ context: 'game', input: 'move', action: 'act', actor: selector }],
      }),
    })
    actors[1] = 'other'
    phases[1] = 'other'
    allowed[0] = 'setup'
    selector.actorId = 'b'
    instance.engine.input!.pressKey('KeyM')
    instance.engine.input!.releaseKey('KeyM')
    instance.timing.drain()
    expect(act).not.toHaveBeenCalled()
    actorAction(instance, 'phase')
    instance.engine.input!.pressKey('KeyM')
    instance.timing.drain()
    expect(act.mock.calls[0]![0].actor?.actorId).toBe('a')
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState?.actorId).toBe('b')
    stop(instance)
  })

  it('resets state on restart and leaves retained snapshots and old scheduled work inert', async () => {
    const instance = await start({ policy: { mode: 'hybrid' } })
    actorAction(instance, 'phase')
    const old = instance.engine.actions!
    const final = old.turnState!
    old.schedule('act', 50, undefined, { actorId: 'a' })
    const stale = instance.timing.tasks.at(-1)!
    instance.engine.stop()
    await instance.engine.start()
    expect(instance.factory).toHaveBeenCalledTimes(2)
    expect(instance.engine.actions!.turnState).toEqual({
      actorId: 'a',
      phaseId: 'setup',
      round: 1,
      revision: 0,
    })
    expect(old.request('end', undefined, { actorId: 'a' })).toBeUndefined()
    instance.timing.now = 50
    stale.run()
    instance.timing.drain()
    expect(instance.act).not.toHaveBeenCalled()
    actorAction(instance, 'act')
    expect(instance.act).toHaveBeenCalledTimes(1)
    expect(old.turnState).toBe(final)
    expect(Object.isFrozen(final)).toBe(true)
    stop(instance)
  })

  it('isolates coordinator state between simultaneous engines', async () => {
    const first = await start()
    const second = await start()
    actorAction(first, 'end')
    expect(first.engine.actions!.turnState?.actorId).toBe('b')
    expect(second.engine.actions!.turnState).toEqual({
      actorId: 'a',
      phaseId: 'setup',
      round: 1,
      revision: 0,
    })
    actorAction(second, 'act')
    expect(second.act).toHaveBeenCalledTimes(1)
    stop(first)
    stop(second)
  })

  it('exposes initial state during mounting and retains it inertly after a mount failure', async () => {
    let retained: NonNullable<Engine['actions']> | undefined
    const instance = setup({
      host: {
        mount: (_game, session) => {
          retained = session.actions
          expect(session.actions.turnState).toEqual({
            actorId: 'a',
            phaseId: 'setup',
            round: 1,
            revision: 0,
          })
          expect(instance.engine.actions).toBeUndefined()
          session.actions.request('phase', undefined, { actorId: 'a' })
          throw new Error('Mount failed')
        },
      },
    })
    await expect(instance.engine.start()).rejects.toThrow('Mount failed')
    instance.timing.drain()
    expect(retained!.turnState?.revision).toBe(0)
    expect(Object.isFrozen(retained!.turnState)).toBe(true)
    expect(retained!.request('end', undefined, { actorId: 'a' })).toBeUndefined()
    expect(instance.timing.pending).toEqual([])
  })
})
