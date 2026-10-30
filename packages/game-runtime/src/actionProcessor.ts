import type { ILogger, IMessageBus, IMonotonicClock, Unsubscribe } from '@ancadeba/utilities'
import type {
  ActionOrigin,
  ActionOutcome,
  ActionRequest,
  ActionRequestId,
  GameActionHandler,
  GameRules,
  IGameActions,
  InputActionBinding,
  ProgressionSnapshot,
  WorldScheduleId,
} from './actions.js'
import type { VirtualInput } from './input.js'
import type { EngineMessages } from './messages.js'
import { GameProgression } from './progression.js'
import { copyRosterChanges } from './actorRoster.js'
import type { ITimerService, TimerId, TimerWakeup } from './timers.js'
import { WorldActionScheduler } from './worldActionScheduler.js'
import { TurnCoordinator, type PreparedTurnTransition } from './turnCoordinator.js'
import type {
  ActionRequestOptions,
  ActorAttribution,
  ActorRosterSnapshot,
  InputActorSelector,
  TurnSnapshot,
} from './turns.js'

function bindingKey(context: string, input: string, phase: VirtualInput['phase']): string {
  return JSON.stringify([context, input, phase])
}

function validateOutcome(value: unknown): ActionOutcome {
  if (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  ) {
    // Unsupported rejected promises must not become unhandled host rejections.
    void Promise.resolve(value).catch(() => {})
    throw new TypeError('Action handlers must be synchronous')
  }
  if (typeof value !== 'object' || value === null || !('status' in value))
    throw new TypeError('Invalid action outcome')
  if (
    value.status === 'rejected' &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    value.reason.trim()
  ) {
    return Object.freeze({ status: 'rejected', reason: value.reason })
  }
  if (value.status !== 'applied') throw new TypeError('Invalid action outcome')
  const advanceTurn =
    'advanceTurn' in value && value.advanceTurn !== undefined ? value.advanceTurn : false
  const advancePhase =
    'advancePhase' in value && value.advancePhase !== undefined ? value.advancePhase : false
  const cost =
    'worldTimeCostMs' in value && value.worldTimeCostMs !== undefined ? value.worldTimeCostMs : 0
  if (
    typeof advanceTurn !== 'boolean' ||
    typeof advancePhase !== 'boolean' ||
    (advanceTurn && advancePhase) ||
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    throw new TypeError(
      'Action progression requires exclusive boolean turn/phase advances and a finite nonnegative time cost',
    )
  }
  return Object.freeze({
    status: 'applied',
    advanceTurn,
    worldTimeCostMs: cost,
    ...(advancePhase ? { advancePhase: true } : {}),
    ...('rosterChanges' in value && value.rosterChanges !== undefined
      ? { rosterChanges: copyRosterChanges(value.rosterChanges) }
      : {}),
  })
}

/** Routes session triggers and serially executes synchronous action handlers. */
export class ActionProcessor implements IGameActions {
  private readonly handlers: Map<string, GameActionHandler>
  private readonly bindings = new Map<
    string,
    { action: string; actor: InputActorSelector | undefined }
  >()
  private readonly scheduled = new Map<
    TimerId,
    { action: string; payload: unknown; actor: ActorAttribution | undefined }
  >()
  private readonly progressionState: GameProgression
  private readonly worldSchedules: WorldActionScheduler<ActorAttribution>
  private readonly turns: TurnCoordinator | undefined
  private readonly subscriptions: Unsubscribe[]
  private nextRequestId = 0
  private disposed = false
  private started = false

  constructor(
    rules: GameRules,
    private readonly messages: IMessageBus<EngineMessages>,
    private readonly timers: ITimerService,
    clock: IMonotonicClock,
    private readonly logger: ILogger,
    private readonly isRunning: () => boolean,
  ) {
    this.handlers = new Map(rules.handlers)
    for (const [id, handler] of this.handlers) {
      if (!id.trim() || typeof handler !== 'function')
        throw new TypeError('Action handlers require nonempty IDs and functions')
    }
    this.turns = rules.turns ? new TurnCoordinator(rules.turns, this.handlers.keys()) : undefined
    for (const binding of rules.inputBindings ?? []) this.addBinding(binding)
    this.progressionState = new GameProgression(rules.worldTime, messages, timers, clock)
    this.worldSchedules = new WorldActionScheduler<ActorAttribution>(
      messages,
      timers,
      this.progressionState,
      (action, payload, origin, actor) => {
        this.enqueue(action, payload, origin, actor)
      },
      isRunning,
    )
    this.subscriptions = [
      messages.subscribe('input.virtual', (event) => this.onInput(event)),
      messages.subscribe('timer.wakeup', (event) => this.onTimer(event)),
      messages.subscribe('action.requested', (request) => this.process(request)),
    ]
  }

  get progression(): ProgressionSnapshot {
    return this.progressionState.current
  }

  get turnState(): TurnSnapshot | undefined {
    return this.turns?.current
  }

  get rosterState(): ActorRosterSnapshot | undefined {
    return this.turns?.rosterState
  }

  private get turnFields(): {
    readonly turnState?: TurnSnapshot
    readonly rosterState?: ActorRosterSnapshot
  } {
    return {
      ...(this.turnState ? { turnState: this.turnState } : {}),
      ...(this.rosterState ? { rosterState: this.rosterState } : {}),
    }
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    this.progressionState.start()
    if (this.turnState)
      this.messages.publish(
        'turn.started',
        Object.freeze({
          turnState: this.turnState,
          rosterState: this.rosterState!,
          progression: this.progression,
        }),
      )
    this.worldSchedules.start()
  }

  request(
    action: string,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): ActionRequestId | undefined {
    if (this.disposed) return undefined
    return this.enqueue(
      action,
      payload,
      Object.freeze({ type: 'direct' }),
      this.captureActor(options),
    )
  }

  schedule(
    action: string,
    delayMs: number,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): TimerId | undefined {
    if (this.disposed) return undefined
    const id = this.timers.schedule(delayMs)
    if (id !== undefined)
      this.scheduled.set(id, { action, payload, actor: this.captureActor(options) })
    return id
  }

  cancelScheduled(timerId: TimerId): boolean {
    if (this.disposed || !this.scheduled.has(timerId) || !this.timers.cancel(timerId)) return false
    this.scheduled.delete(timerId)
    return true
  }

  scheduleWorld(
    action: string,
    delayWorldMs: number,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): WorldScheduleId | undefined {
    if (this.disposed) return undefined
    return this.worldSchedules.scheduleAfter(
      action,
      delayWorldMs,
      payload,
      this.captureActor(options),
    )
  }

  scheduleWorldAt(
    action: string,
    dueAtWorldMs: number,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): WorldScheduleId | undefined {
    if (this.disposed) return undefined
    return this.worldSchedules.scheduleAt(action, dueAtWorldMs, payload, this.captureActor(options))
  }

  cancelWorldScheduled(id: WorldScheduleId): boolean {
    return this.worldSchedules.cancel(id)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worldSchedules.dispose()
    for (const unsubscribe of this.subscriptions) unsubscribe()
    for (const timerId of this.scheduled.keys()) this.timers.cancel(timerId)
    this.scheduled.clear()
    this.bindings.clear()
    this.handlers.clear()
    this.progressionState.dispose()
  }

  private addBinding(binding: InputActionBinding): void {
    const phase = binding.phase ?? 'pressed'
    const key = bindingKey(binding.context, binding.input, phase)
    if (
      !binding.context.trim() ||
      !binding.input.trim() ||
      !['pressed', 'released', 'cancelled'].includes(phase)
    ) {
      throw new TypeError('Invalid input action binding')
    }
    if (!this.handlers.has(binding.action))
      throw new Error(`Unknown bound action: ${binding.action}`)
    if (this.bindings.has(key)) throw new Error('Duplicate input action binding')
    if (!this.turns && binding.actor !== undefined)
      throw new TypeError('Input actor selection requires turn configuration')
    const actor = this.turns?.validateBinding(binding.action, binding.actor)
    this.bindings.set(key, { action: binding.action, actor })
  }

  private onInput(event: VirtualInput): void {
    if (this.disposed || !this.isRunning()) return
    const binding = this.bindings.get(bindingKey(event.context, event.input, event.phase))
    if (binding === undefined) return
    const actorId =
      binding.actor?.type === 'fixed'
        ? binding.actor.actorId
        : binding.actor?.type === 'active'
          ? this.turnState?.actorId
          : undefined
    this.enqueue(
      binding.action,
      undefined,
      Object.freeze({ type: 'input', event: Object.freeze({ ...event }) }),
      this.captureActor(actorId === undefined ? undefined : { actorId }),
    )
  }

  private onTimer(event: TimerWakeup): void {
    if (this.disposed || !this.isRunning()) return
    const scheduled = this.scheduled.get(event.timerId)
    if (!scheduled) return
    this.scheduled.delete(event.timerId)
    this.enqueue(
      scheduled.action,
      scheduled.payload,
      Object.freeze({ type: 'timer', event: Object.freeze({ ...event }) }),
      scheduled.actor,
    )
  }

  private enqueue(
    action: string,
    payload: unknown,
    origin: ActionOrigin,
    actor?: ActorAttribution,
  ): ActionRequestId | undefined {
    if (this.disposed) return undefined
    const id = ++this.nextRequestId
    this.messages.publish(
      'action.requested',
      Object.freeze({ id, action, payload, origin, ...(actor ? { actor } : {}) }),
    )
    return id
  }

  private process(request: ActionRequest): void {
    if (this.disposed || !this.isRunning()) return
    try {
      this.progressionState.synchronize()
      const handler = this.handlers.get(request.action)
      if (!handler) {
        this.messages.publish(
          'action.rejected',
          Object.freeze({
            request,
            reason: `Unknown action: ${request.action}`,
            progression: this.progression,
            ...this.turnFields,
          }),
        )
        return
      }
      const rejection = this.turns
        ? this.turns.rejection(request.action, request.actor)
        : request.actor !== undefined
          ? 'Actor turns are not enabled'
          : undefined
      if (rejection !== undefined) {
        this.messages.publish(
          'action.rejected',
          Object.freeze({
            request,
            reason: rejection,
            progression: this.progression,
            ...this.turnFields,
          }),
        )
        return
      }
      const result = handler(
        request,
        Object.freeze({
          progression: this.progression,
          actions: this,
          turnState: this.turnState,
          rosterState: this.rosterState,
        }),
      )
      const outcome = validateOutcome(result)
      if (this.disposed || !this.isRunning()) return
      if (outcome.status === 'rejected') {
        this.messages.publish(
          'action.rejected',
          Object.freeze({
            request,
            reason: outcome.reason,
            progression: this.progression,
            ...this.turnFields,
          }),
        )
        return
      }
      if (!this.turns && outcome.advancePhase)
        throw new TypeError('Phase advancement requires turn configuration')
      if (!this.turns && outcome.rosterChanges !== undefined)
        throw new TypeError('Roster changes require turn configuration')
      const transition = this.turns?.prepare(request.action, outcome)
      this.progressionState.apply(
        transition?.advanceTurn ?? outcome.advanceTurn ?? false,
        outcome.worldTimeCostMs ?? 0,
      )
      if (transition) {
        this.turns!.commit(transition)
        this.publishTransition(transition)
      }
      this.messages.publish(
        'action.applied',
        Object.freeze({ request, outcome, progression: this.progression, ...this.turnFields }),
      )
    } catch (error) {
      if (this.disposed || !this.isRunning()) return
      this.messages.publish(
        'action.failed',
        Object.freeze({ request, error, progression: this.progression, ...this.turnFields }),
      )
      this.logger.error('ActionProcessor', 'Action failed', error)
    }
  }

  private captureActor(options: ActionRequestOptions | undefined): ActorAttribution | undefined {
    return options === undefined
      ? undefined
      : (this.turns?.captureActor(options.actorId) ??
          Object.freeze({ actorId: options.actorId, actorGeneration: 0, turnRevision: 0 }))
  }

  private publishTransition(transition: PreparedTurnTransition): void {
    const common = { progression: this.progression, rosterState: this.rosterState! }
    const { previous, turnState } = transition
    if (transition.rosterChange) {
      this.messages.publish(
        'turn.rosterChanged',
        Object.freeze({
          ...common,
          previous: transition.rosterChange.previous,
          ...(turnState ? { turnState } : {}),
        }),
      )
    }
    if (transition.advanceTurn && previous)
      this.messages.publish(
        'turn.ended',
        Object.freeze({ ...common, previous, ...(turnState ? { turnState } : {}) }),
      )
    if (turnState) {
      if (transition.roundAdvanced)
        this.messages.publish(
          'turn.roundAdvanced',
          Object.freeze({ ...common, previous: transition.lastEnded!, turnState }),
        )
      if (transition.advanceTurn || previous === undefined)
        this.messages.publish('turn.started', Object.freeze({ ...common, turnState }))
      else if (turnState !== previous)
        this.messages.publish(
          'turn.phaseChanged',
          Object.freeze({ ...common, previous, turnState }),
        )
    } else if (transition.advanceTurn && previous) {
      this.messages.publish('turn.idle', Object.freeze({ ...common, previous }))
    }
  }
}
