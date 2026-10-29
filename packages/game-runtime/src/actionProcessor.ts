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
} from './actions.js'
import type { VirtualInput } from './input.js'
import type { EngineMessages } from './messages.js'
import { GameProgression } from './progression.js'
import type { ITimerService, TimerId, TimerWakeup } from './timers.js'

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
  const cost =
    'worldTimeCostMs' in value && value.worldTimeCostMs !== undefined ? value.worldTimeCostMs : 0
  if (
    typeof advanceTurn !== 'boolean' ||
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    throw new TypeError(
      'Action progression requires a boolean turn advance and a finite nonnegative time cost',
    )
  }
  return Object.freeze({ status: 'applied', advanceTurn, worldTimeCostMs: cost })
}

/** Routes session triggers and serially executes synchronous action handlers. */
export class ActionProcessor implements IGameActions {
  private readonly handlers: Map<string, GameActionHandler>
  private readonly bindings = new Map<string, string>()
  private readonly scheduled = new Map<TimerId, { action: string; payload: unknown }>()
  private readonly progressionState: GameProgression
  private readonly subscriptions: Unsubscribe[]
  private nextRequestId = 0
  private disposed = false

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
    for (const binding of rules.inputBindings ?? []) this.addBinding(binding)
    this.progressionState = new GameProgression(rules.worldTime, messages, timers, clock)
    this.subscriptions = [
      messages.subscribe('input.virtual', (event) => this.onInput(event)),
      messages.subscribe('timer.wakeup', (event) => this.onTimer(event)),
      messages.subscribe('action.requested', (request) => this.process(request)),
    ]
  }

  get progression(): ProgressionSnapshot {
    return this.progressionState.current
  }

  start(): void {
    if (!this.disposed) this.progressionState.start()
  }

  request(action: string, payload?: unknown): ActionRequestId | undefined {
    return this.enqueue(action, payload, Object.freeze({ type: 'direct' }))
  }

  schedule(action: string, delayMs: number, payload?: unknown): TimerId | undefined {
    if (this.disposed) return undefined
    const id = this.timers.schedule(delayMs)
    if (id !== undefined) this.scheduled.set(id, { action, payload })
    return id
  }

  cancelScheduled(timerId: TimerId): boolean {
    if (this.disposed || !this.scheduled.has(timerId) || !this.timers.cancel(timerId)) return false
    this.scheduled.delete(timerId)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
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
    this.bindings.set(key, binding.action)
  }

  private onInput(event: VirtualInput): void {
    if (this.disposed || !this.isRunning()) return
    const action = this.bindings.get(bindingKey(event.context, event.input, event.phase))
    if (action !== undefined)
      this.enqueue(
        action,
        undefined,
        Object.freeze({ type: 'input', event: Object.freeze({ ...event }) }),
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
    )
  }

  private enqueue(
    action: string,
    payload: unknown,
    origin: ActionOrigin,
  ): ActionRequestId | undefined {
    if (this.disposed) return undefined
    const id = ++this.nextRequestId
    this.messages.publish('action.requested', Object.freeze({ id, action, payload, origin }))
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
          }),
        )
        return
      }
      const result = handler(
        request,
        Object.freeze({ progression: this.progression, actions: this }),
      )
      const outcome = validateOutcome(result)
      if (this.disposed || !this.isRunning()) return
      if (outcome.status === 'rejected') {
        this.messages.publish(
          'action.rejected',
          Object.freeze({ request, reason: outcome.reason, progression: this.progression }),
        )
        return
      }
      this.progressionState.apply(outcome.advanceTurn ?? false, outcome.worldTimeCostMs ?? 0)
      this.messages.publish(
        'action.applied',
        Object.freeze({ request, outcome, progression: this.progression }),
      )
    } catch (error) {
      if (this.disposed || !this.isRunning()) return
      this.messages.publish(
        'action.failed',
        Object.freeze({ request, error, progression: this.progression }),
      )
      this.logger.error('ActionProcessor', 'Action failed', error)
    }
  }
}
