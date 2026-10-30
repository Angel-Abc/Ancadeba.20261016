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
  type RosterChanges,
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

async function dynamicStart(options: Parameters<typeof configured>[0] = {}) {
  return start({
    rules: configured({
      ...options,
      handlers: {
        edit: (request) => ({ status: 'applied', rosterChanges: request.payload as RosterChanges }),
        ...options.handlers,
      },
      policies: new Map([['edit', { scope: 'global' }], ...(options.policies ?? [])]),
    }),
  })
}

function edit(instance: ReturnType<typeof setup>, changes: RosterChanges): void {
  instance.engine.actions!.request('edit', changes)
  instance.timing.drain()
}

describe('dynamic actor membership', () => {
  it('appends newcomers in order for the next round without changing the current revision', async () => {
    const instance = await dynamicStart()
    const actions = instance.engine.actions!
    const initial = actions.turnState
    actorAction(instance, 'phase')
    const active = actions.turnState
    edit(instance, { add: ['c', 'd'] })
    expect(actions.turnState).toBe(active)
    expect(actions.rosterState).toEqual({
      revision: 1,
      actors: [
        { actorId: 'a', generation: 1, eligibleFromRound: 1 },
        { actorId: 'b', generation: 1, eligibleFromRound: 1 },
        { actorId: 'c', generation: 1, eligibleFromRound: 2 },
        { actorId: 'd', generation: 1, eligibleFromRound: 2 },
      ],
    })
    actorAction(instance, 'end')
    expect(actions.turnState).toMatchObject({ actorId: 'b', round: 1 })
    actorAction(instance, 'end')
    expect(actions.turnState).toMatchObject({ actorId: 'a', round: 2 })
    actorAction(instance, 'end')
    actorAction(instance, 'end')
    expect(actions.turnState).toMatchObject({ actorId: 'c', phaseId: 'setup', round: 2 })
    actorAction(instance, 'end')
    expect(actions.turnState?.actorId).toBe('d')
    expect(initial?.revision).toBe(0)
    stop(instance)
  })

  it('rejects pending actors before invoking their handler or committing costs', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied', worldTimeCostMs: 10 }))
    const instance = await dynamicStart({ handlers: { act } })
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    edit(instance, { add: ['c'] })
    instance.engine.actions!.request('act', undefined, { actorId: 'c' })
    instance.timing.drain()
    expect(rejected.mock.calls[0]![0].reason).toContain('next round')
    expect(act).not.toHaveBeenCalled()
    expect(instance.engine.actions!.progression.worldTimeMs).toBe(0)
    stop(instance)
  })

  it('preserves queued requests when future, completed, or pending actors are removed', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({ actors: ['a', 'b', 'c'], handlers: { act } })
    const actions = instance.engine.actions!
    actorAction(instance, 'end')
    edit(instance, { add: ['d'] })
    const active = actions.turnState
    actions.request('edit', { remove: ['a', 'c', 'd'] })
    actions.request('act', undefined, { actorId: 'b' })
    instance.timing.drain()
    expect(act).toHaveBeenCalledTimes(1)
    expect(actions.turnState).toBe(active)
    expect(actions.progression.turn).toBe(1)
    actorAction(instance, 'end')
    expect(actions.turnState).toMatchObject({ actorId: 'b', round: 2, revision: 2 })
    stop(instance)
  })

  it.each(['advancePhase', 'advanceTurn', 'neither'] as const)(
    'finishes active removal once and resets the next actor phase with %s',
    async (flag) => {
      const instance = await dynamicStart({
        handlers: {
          act: () => ({
            status: 'applied',
            rosterChanges: { remove: ['a'] },
            ...(flag === 'neither' ? {} : { [flag]: true }),
            worldTimeCostMs: 5,
          }),
        },
      })
      actorAction(instance, 'phase')
      const events: string[] = []
      for (const topic of [
        'turn.advanced',
        'world-time.advanced',
        'turn.rosterChanged',
        'turn.ended',
        'turn.phaseChanged',
        'turn.started',
        'action.applied',
      ] as const)
        instance.engine.messages!.subscribe(topic, () => events.push(topic))
      actorAction(instance, 'act')
      expect(instance.engine.actions!.turnState).toEqual({
        actorId: 'b',
        phaseId: 'setup',
        round: 1,
        revision: 2,
      })
      expect(instance.engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: 5 })
      expect(events).toEqual([
        'turn.advanced',
        'world-time.advanced',
        'turn.rosterChanged',
        'turn.ended',
        'turn.started',
        'action.applied',
      ])
      stop(instance)
    },
  )

  it('lets a global action remove the active actor and skips removed future participants', async () => {
    const instance = await dynamicStart({ actors: ['a', 'b', 'c', 'd'] })
    edit(instance, { remove: ['a', 'b', 'd'], add: ['e'] })
    expect(instance.engine.actions!.turnState).toEqual({
      actorId: 'c',
      phaseId: 'setup',
      round: 1,
      revision: 1,
    })
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState).toMatchObject({ actorId: 'c', round: 2 })
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState).toMatchObject({ actorId: 'e', round: 2 })
    stop(instance)
  })

  it('keeps idle globals and elapsed deadlines running and resumes the next round with a whole batch', async () => {
    const weather = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({ worldTime: { mode: 'hybrid' }, handlers: { weather } })
    const actions = instance.engine.actions!
    const events: string[] = []
    let ended: EngineMessages['turn.ended'] | undefined
    instance.engine.messages!.subscribe('turn.ended', (event) => {
      ended = event
    })
    for (const topic of [
      'turn.advanced',
      'turn.rosterChanged',
      'turn.ended',
      'turn.idle',
      'turn.roundAdvanced',
      'turn.started',
      'action.applied',
    ] as const)
      instance.engine.messages!.subscribe(topic, () => events.push(topic))
    actions.schedule('weather', 10)
    actions.scheduleWorldAt('weather', 10)
    edit(instance, { remove: ['a', 'b'] })
    expect(events).toEqual([
      'turn.advanced',
      'turn.rosterChanged',
      'turn.ended',
      'turn.idle',
      'action.applied',
    ])
    expect(actions.turnState).toBeUndefined()
    expect(actions.rosterState).toEqual({ revision: 1, actors: [] })
    expect(ended).not.toHaveProperty('turnState')
    expect(instance.engine.state).toBe('running')
    instance.timing.now = 10
    instance.timing.drain()
    expect(weather).toHaveBeenCalledTimes(2)
    expect(weather.mock.calls[0]![1].turnState).toBeUndefined()
    expect(actions.progression).toEqual({ turn: 1, worldTimeMs: 10 })
    events.length = 0
    edit(instance, { add: ['c', 'd'] })
    expect(events).toEqual([
      'turn.rosterChanged',
      'turn.roundAdvanced',
      'turn.started',
      'action.applied',
    ])
    expect(actions.turnState).toEqual({ actorId: 'c', phaseId: 'setup', round: 2, revision: 2 })
    expect(actions.rosterState!.actors.map((actor) => actor.eligibleFromRound)).toEqual([2, 2])
    expect(actions.progression.turn).toBe(1)
    edit(instance, { add: ['e'] })
    actorAction(instance, 'end')
    expect(actions.turnState).toMatchObject({ actorId: 'd', round: 2 })
    actorAction(instance, 'end')
    expect(actions.turnState).toMatchObject({ actorId: 'c', round: 3 })
    stop(instance)
  })

  it('handles repeated single-actor idle/resume cycles without reusing revisions or generations', async () => {
    const instance = await dynamicStart({ actors: ['a'], phases: ['only'] })
    const actions = instance.engine.actions!
    for (let cycle = 1; cycle <= 3; cycle++) {
      edit(instance, { remove: ['a'] })
      expect(actions.turnState).toBeUndefined()
      edit(instance, { add: ['a'] })
      expect(actions.turnState).toEqual({
        actorId: 'a',
        phaseId: 'only',
        round: cycle + 1,
        revision: cycle * 2,
      })
      expect(actions.rosterState!.actors[0]!.generation).toBe(cycle + 1)
      expect(actions.progression.turn).toBe(cycle)
    }
    stop(instance)
  })

  it('starts the next round immediately when one batch replaces every current participant', async () => {
    const instance = await dynamicStart()
    const idle = vi.fn()
    const round = vi.fn()
    instance.engine.messages!.subscribe('turn.idle', idle)
    instance.engine.messages!.subscribe('turn.roundAdvanced', round)
    edit(instance, { remove: ['a', 'b'], add: ['c', 'd'] })
    expect(instance.engine.actions!.turnState).toEqual({
      actorId: 'c',
      phaseId: 'setup',
      round: 2,
      revision: 1,
    })
    expect(instance.engine.actions!.progression.turn).toBe(1)
    expect(idle).not.toHaveBeenCalled()
    expect(round).toHaveBeenCalledTimes(1)
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState).toMatchObject({ actorId: 'd', round: 2 })
    stop(instance)
  })

  it('starts a fresh registration next round rather than restoring its old round position', async () => {
    const instance = await dynamicStart({ actors: ['a', 'b', 'c'] })
    edit(instance, { remove: ['b'] })
    edit(instance, { add: ['b'] })
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState).toMatchObject({ actorId: 'c', round: 1 })
    actorAction(instance, 'end')
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState).toMatchObject({ actorId: 'c', round: 2 })
    actorAction(instance, 'end')
    expect(instance.engine.actions!.turnState).toMatchObject({ actorId: 'b', round: 2 })
    expect(instance.engine.actions!.rosterState!.actors.at(-1)!.generation).toBe(2)
    stop(instance)
  })

  it('treats empty edits as no-ops and freezes copied outcome, roster, and handler snapshots', async () => {
    const changes = { add: ['c'] }
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({ handlers: { act } })
    const applied: EngineMessages['action.applied'][] = []
    const changed: EngineMessages['turn.rosterChanged'][] = []
    instance.engine.messages!.subscribe('action.applied', (event) => applied.push(event))
    instance.engine.messages!.subscribe('turn.rosterChanged', (event) => changed.push(event))
    const actions = instance.engine.actions!
    const initial = actions.rosterState!
    edit(instance, {})
    edit(instance, { add: [], remove: [] })
    expect(actions.rosterState).toBe(initial)
    expect(changed).toEqual([])
    edit(instance, changes)
    const captured = actions.rosterState!
    changes.add[0] = 'mutated'
    expect(applied.at(-1)!.outcome.rosterChanges?.add).toEqual(['c'])
    expect(changed[0]!.previous).toBe(initial)
    expect(changed[0]!.rosterState).toBe(captured)
    expect(applied.at(-1)!.rosterState).toBe(captured)
    actorAction(instance, 'act')
    expect(act.mock.calls[0]![1].rosterState).toBe(captured)
    for (const value of [
      initial,
      captured,
      captured.actors,
      ...captured.actors,
      applied[2]!.outcome.rosterChanges,
      applied[2]!.outcome.rosterChanges!.add,
      applied[2]!.outcome.rosterChanges!.remove,
    ])
      expect(Object.isFrozen(value)).toBe(true)
    edit(instance, { remove: ['c'] })
    expect(captured.actors.at(-1)!.actorId).toBe('c')
    stop(instance)
  })

  it.each([
    null,
    [],
    { add: 'c' },
    { remove: 'a' },
    { add: [''] },
    { remove: [' '] },
    { add: [1] },
    { add: Array<string>(1) },
    { add: ['c', 'c'] },
    { remove: ['a', 'a'] },
    { add: ['c'], remove: ['c'] },
    { add: ['a'] },
    { remove: ['unknown'] },
    { add: ['c'], remove: ['unknown'] },
    { add: ['b'], remove: ['a'] },
  ])('fails invalid roster batches atomically: %#', async (changes) => {
    const instance = await dynamicStart({
      handlers: {
        act: () => ({
          status: 'applied',
          rosterChanges: changes as RosterChanges,
          advancePhase: true,
          worldTimeCostMs: 10,
        }),
      },
    })
    const actions = instance.engine.actions!
    const initialRoster = actions.rosterState
    const initialTurn = actions.turnState
    const failed = vi.fn()
    const changed = vi.fn()
    instance.engine.messages!.subscribe('action.failed', failed)
    instance.engine.messages!.subscribe('turn.rosterChanged', changed)
    actorAction(instance, 'act')
    expect(failed).toHaveBeenCalledTimes(1)
    expect(changed).not.toHaveBeenCalled()
    expect(actions.rosterState).toBe(initialRoster)
    expect(actions.turnState).toBe(initialTurn)
    expect(actions.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    stop(instance)
  })

  it.each([
    { advancePhase: true, advanceTurn: true },
    { advancePhase: true },
    { advanceTurn: true },
  ])('does not allow roster changes to bypass global advancement rules: %#', async (flags) => {
    const instance = await dynamicStart({
      handlers: {
        edit: () => ({
          status: 'applied',
          ...flags,
          rosterChanges: { remove: ['a'] },
          worldTimeCostMs: 10,
        }),
      },
    })
    const failed = vi.fn()
    instance.engine.messages!.subscribe('action.failed', failed)
    const initial = instance.engine.actions!.rosterState
    edit(instance, {})
    expect(failed).toHaveBeenCalledTimes(1)
    expect(instance.engine.actions!.rosterState).toBe(initial)
    expect(instance.engine.actions!.turnState?.actorId).toBe('a')
    expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    stop(instance)
  })

  it('does not commit membership or consume generations when progression fails', async () => {
    const instance = await dynamicStart({
      handlers: {
        act: () => ({
          status: 'applied',
          rosterChanges: { add: ['c'], remove: ['a'] },
          worldTimeCostMs: Number.MAX_VALUE,
        }),
      },
    })
    const actions = instance.engine.actions!
    actions.request('cost', Number.MAX_VALUE)
    instance.timing.drain()
    const initial = actions.rosterState
    actorAction(instance, 'act')
    expect(actions.rosterState).toBe(initial)
    expect(actions.turnState?.revision).toBe(0)
    expect(actions.progression.turn).toBe(0)
    edit(instance, { add: ['c'] })
    expect(actions.rosterState!.actors.at(-1)!.generation).toBe(1)
    stop(instance)
  })

  it('does not commit roster edits after a handler stops the session', async () => {
    const instance = await dynamicStart({
      handlers: {
        edit: () => {
          instance.engine.stop()
          return {
            status: 'applied',
            rosterChanges: { remove: ['a'], add: ['c'] },
            worldTimeCostMs: 10,
          }
        },
      },
    })
    const retained = instance.engine.actions!
    const initial = retained.rosterState
    edit(instance, {})
    expect(retained.rosterState).toBe(initial)
    expect(retained.turnState?.revision).toBe(0)
    expect(retained.progression).toEqual({ turn: 0, worldTimeMs: 0 })
  })

  it('rejects roster changes without turn configuration and omits roster fields in legacy outcomes', async () => {
    const instance = await start({
      rules: {
        handlers: new Map<string, GameActionHandler>([
          [
            'edit',
            () => ({
              status: 'applied',
              rosterChanges: {},
              advanceTurn: true,
              worldTimeCostMs: 10,
            }),
          ],
          ['act', () => ({ status: 'applied' })],
        ]),
      },
    })
    const failed = vi.fn()
    const applied = vi.fn()
    instance.engine.messages!.subscribe('action.failed', failed)
    instance.engine.messages!.subscribe('action.applied', applied)
    instance.engine.actions!.request('edit')
    instance.engine.actions!.request('act')
    instance.timing.drain()
    expect(instance.engine.actions!.rosterState).toBeUndefined()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(applied.mock.calls[0]![0]).not.toHaveProperty('rosterState')
    expect(instance.engine.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    stop(instance)
  })
})

describe('dynamic actor attribution and session isolation', () => {
  it.each(['direct', 'host', 'world-relative', 'world-absolute'] as const)(
    'keeps original registration metadata for %s requests after removal and re-addition',
    async (kind) => {
      const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
      const instance = await dynamicStart({ handlers: { act } })
      const actions = instance.engine.actions!
      const rejected: EngineMessages['action.rejected'][] = []
      instance.engine.messages!.subscribe('action.rejected', (event) => rejected.push(event))
      if (kind === 'direct') {
        actions.request('edit', { remove: ['b'] })
        actions.request('edit', { add: ['b'] })
        actions.request('act', undefined, { actorId: 'b' })
      } else if (kind === 'host') actions.schedule('act', 10, undefined, { actorId: 'b' })
      else if (kind === 'world-relative')
        actions.scheduleWorld('act', 10, undefined, { actorId: 'b' })
      else actions.scheduleWorldAt('act', 10, undefined, { actorId: 'b' })
      instance.timing.drain()
      if (kind !== 'direct') {
        edit(instance, { remove: ['b'] })
        edit(instance, { add: ['b'] })
        actorAction(instance, 'end')
        actorAction(instance, 'end')
        expect(actions.turnState).toMatchObject({ actorId: 'b', round: 2 })
        if (kind === 'host') instance.timing.now = 10
        else actions.request('cost', 10)
        instance.timing.drain()
      }
      expect(act).not.toHaveBeenCalled()
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason).toContain('registration')
      expect(rejected[0]!.request.actor).toEqual({
        actorId: 'b',
        actorGeneration: 1,
        turnRevision: 0,
      })
      expect(actions.rosterState!.actors.at(-1)!.generation).toBe(2)
      if (kind !== 'direct') {
        actorAction(instance, 'act')
        expect(act.mock.calls[0]![0].actor?.actorGeneration).toBe(2)
      }
      stop(instance)
    },
  )

  it('never attaches a request captured for an unknown actor to its first registration', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({ actors: ['a'], handlers: { act } })
    const actions = instance.engine.actions!
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    actions.schedule('act', 10, undefined, { actorId: 'new' })
    edit(instance, { remove: ['a'] })
    edit(instance, { add: ['new'] })
    instance.timing.now = 10
    instance.timing.drain()
    expect(rejected.mock.calls[0]![0].request.actor).toEqual({
      actorId: 'new',
      actorGeneration: 0,
      turnRevision: 0,
    })
    expect(act).not.toHaveBeenCalled()
    actorAction(instance, 'act')
    expect(act.mock.calls[0]![0].actor?.actorGeneration).toBe(1)
    stop(instance)
  })

  it('rejects removed registrations and keeps unrelated active-actor schedules valid', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({ handlers: { act } })
    const actions = instance.engine.actions!
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    actions.schedule('act', 10, undefined, { actorId: 'a' })
    actions.schedule('act', 10, undefined, { actorId: 'b' })
    edit(instance, { remove: ['b'], add: ['c'] })
    instance.timing.now = 10
    instance.timing.drain()
    expect(act).toHaveBeenCalledTimes(1)
    expect(act.mock.calls[0]![0].actor?.actorId).toBe('a')
    expect(rejected.mock.calls[0]![0].reason).toBe('Unknown actor: b')
    expect(actions.progression.turn).toBe(0)
    stop(instance)
  })

  it('retains the original revision for a schedule registered while an actor is pending', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({ actors: ['a'], handlers: { act } })
    edit(instance, { add: ['b'] })
    instance.engine.actions!.schedule('act', 10, undefined, { actorId: 'b' })
    actorAction(instance, 'end')
    actorAction(instance, 'end')
    const rejected = vi.fn()
    instance.engine.messages!.subscribe('action.rejected', rejected)
    instance.timing.now = 10
    instance.timing.drain()
    expect(rejected.mock.calls[0]![0].reason).toContain('Stale actor action')
    expect(act).not.toHaveBeenCalled()
    stop(instance)
  })

  it('captures fixed input generations at conversion and handles active input while idle', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({
      actors: ['a'],
      handlers: { act },
      bindings: [
        { context: 'game', input: 'move', action: 'act', actor: { type: 'fixed', actorId: 'a' } },
        { context: 'game', input: 'end', action: 'act', actor: { type: 'active' } },
      ],
    })
    const actions = instance.engine.actions!
    const rejected: EngineMessages['action.rejected'][] = []
    instance.engine.messages!.subscribe('action.rejected', (event) => rejected.push(event))
    instance.engine.input!.pressKey('KeyM')
    instance.engine.input!.releaseKey('KeyM')
    // Convert input first, then process removal/re-add before the generated request.
    actions.request('edit', { remove: ['a'] })
    actions.request('edit', { add: ['a'] })
    instance.timing.drain()
    expect(rejected[0]!.request.actor?.actorGeneration).toBe(1)
    expect(rejected[0]!.reason).toContain('registration')
    instance.engine.input!.pressKey('KeyM')
    instance.engine.input!.releaseKey('KeyM')
    instance.timing.drain()
    expect(act.mock.calls[0]![0].actor).toEqual({
      actorId: 'a',
      actorGeneration: 2,
      turnRevision: 2,
    })
    edit(instance, { remove: ['a'] })
    instance.engine.input!.pressKey('KeyM')
    instance.engine.input!.pressKey('KeyE')
    instance.engine.input!.releaseKey('KeyE')
    instance.engine.input!.releaseKey('KeyM')
    instance.timing.drain()
    expect(rejected).toHaveLength(3)
    expect(act).toHaveBeenCalledTimes(1)
    expect(instance.logger.error).not.toHaveBeenCalled()
    stop(instance)
  })

  it('keeps due global world actions in bus order across a removal caused by action time costs', async () => {
    const order: string[] = []
    const instance = await dynamicStart({
      handlers: {
        edit: (request) => ({
          status: 'applied',
          rosterChanges: request.payload as RosterChanges,
          worldTimeCostMs: 10,
        }),
        weather: (_request, context) => {
          order.push(`weather:${context.turnState?.actorId}`)
          return { status: 'applied' }
        },
      },
    })
    instance.engine.actions!.scheduleWorld('weather', 5)
    instance.engine.messages!.subscribe('turn.rosterChanged', () => order.push('roster'))
    instance.engine.messages!.subscribe('action.applied', (event) =>
      order.push(`applied:${event.request.action}`),
    )
    edit(instance, { remove: ['a'] })
    expect(order).toEqual(['roster', 'applied:edit', 'weather:b', 'applied:weather'])
    expect(instance.engine.actions!.progression).toEqual({ turn: 1, worldTimeMs: 10 })
    stop(instance)
  })

  it('retains cancellation behavior for scheduled requests after actor removal', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const instance = await dynamicStart({ handlers: { act } })
    const actions = instance.engine.actions!
    const host = actions.schedule('act', 10, undefined, { actorId: 'b' })!
    const world = actions.scheduleWorld('act', 10, undefined, { actorId: 'b' })!
    edit(instance, { remove: ['b'] })
    expect(actions.cancelScheduled(host)).toBe(true)
    expect(actions.cancelWorldScheduled(world)).toBe(true)
    expect(actions.cancelScheduled(host)).toBe(false)
    expect(actions.cancelWorldScheduled(world)).toBe(false)
    instance.timing.now = 10
    actions.request('cost', 10)
    instance.timing.drain()
    expect(act).not.toHaveBeenCalled()
    stop(instance)
  })

  it('resets generation history on restart, preserves frozen final snapshots, and isolates engines', async () => {
    const act = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))
    const first = await dynamicStart({ handlers: { act } })
    const second = await dynamicStart()
    edit(first, { remove: ['b'] })
    edit(first, { add: ['b'] })
    const retained = first.engine.actions!
    const final = retained.rosterState
    retained.schedule('act', 10, undefined, { actorId: 'a' })
    const stale = first.timing.tasks.at(-1)!
    first.engine.stop()
    await first.engine.start()
    stale.run()
    first.timing.now = 10
    first.timing.drain()
    expect(act).not.toHaveBeenCalled()
    expect(first.engine.actions!.rosterState).toEqual(second.engine.actions!.rosterState)
    expect(first.engine.actions!.rosterState!.revision).toBe(0)
    expect(retained.rosterState).toBe(final)
    expect(final!.actors.at(-1)!.generation).toBe(2)
    expect(retained.request('edit', { remove: ['a'] })).toBeUndefined()
    expect(retained.scheduleWorld('edit', 0, { remove: ['a'] })).toBeUndefined()
    stop(first)
    stop(second)
  })

  it('exposes initial frozen membership during mounting and preserves it on startup failure', async () => {
    let retained: Engine['actions']
    const instance = setup({
      host: {
        mount: (_game, session) => {
          retained = session.actions
          expect(retained.rosterState!.actors.map((actor) => actor.actorId)).toEqual(['a', 'b'])
          expect(Object.isFrozen(retained.rosterState)).toBe(true)
          retained.request('end', undefined, { actorId: 'a' })
          throw new Error('Mount failed')
        },
      },
    })
    await expect(instance.engine.start()).rejects.toThrow('Mount failed')
    instance.timing.drain()
    expect(retained!.rosterState!.revision).toBe(0)
    expect(retained!.request('end', undefined, { actorId: 'a' })).toBeUndefined()
  })
})

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
      rosterState: instance.engine.actions!.rosterState,
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
      rosterState: instance.engine.actions!.rosterState,
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
    expect(rejected.mock.calls[0]![0].request.actor).toEqual({
      actorId: 'a',
      actorGeneration: 1,
      turnRevision: 0,
    })
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
    expect(requests.at(-1)!.actor).toEqual({ actorId: 'b', actorGeneration: 1, turnRevision: 1 })
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
    expect(rejected.mock.calls[0]![0].request.actor).toEqual({
      actorId: 'a',
      actorGeneration: 1,
      turnRevision: 0,
    })
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
    expect(instance.act.mock.calls[0]![0].actor).toEqual({
      actorId: 'a',
      actorGeneration: 1,
      turnRevision: 0,
    })
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
      expect(rejected.mock.calls[0]![0].request.actor).toEqual({
        actorId: 'a',
        actorGeneration: 1,
        turnRevision: 0,
      })
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
    { actors: Array<string>(1) },
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
