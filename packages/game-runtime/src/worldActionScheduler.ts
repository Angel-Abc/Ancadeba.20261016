import type { IMessageBus, Unsubscribe } from '@ancadeba/utilities'
import type { ActionOrigin, ProgressionSnapshot, WorldScheduleId } from './actions.js'
import type { EngineMessages } from './messages.js'
import type { ITimerService, TimerId } from './timers.js'

interface WorldProgression {
  readonly current: ProgressionSnapshot
  synchronize(): void
  hostDelayUntil(dueAtWorldMs: number): number | undefined
}

interface WorldSchedule {
  readonly id: WorldScheduleId
  readonly order: number
  readonly action: string
  readonly dueAtWorldMs: number
  readonly payload: unknown
}

/** Selects one-shot world deadlines and projects a single host alarm; never executes handlers. */
export class WorldActionScheduler {
  private readonly pending = new Map<WorldScheduleId, WorldSchedule>()
  private readonly subscriptions: Unsubscribe[]
  private nextId = 0
  private alarm: TimerId | undefined
  private started = false
  private disposed = false

  constructor(
    messages: IMessageBus<EngineMessages>,
    private readonly timers: ITimerService,
    private readonly progression: WorldProgression,
    private readonly enqueue: (action: string, payload: unknown, origin: ActionOrigin) => void,
    private readonly isRunning: () => boolean,
  ) {
    this.subscriptions = [
      messages.subscribe('world-time.advanced', () => this.selectDue()),
      messages.subscribe('timer.wakeup', (event) => {
        if (!this.ready || event.timerId !== this.alarm) return
        this.alarm = undefined
        this.progression.synchronize()
        this.selectDue()
      }),
    ]
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    this.selectDue()
  }

  scheduleAfter(
    action: string,
    delayWorldMs: number,
    payload?: unknown,
  ): WorldScheduleId | undefined {
    if (this.disposed) return undefined
    this.validateTime(delayWorldMs)
    this.progression.synchronize()
    const dueAtWorldMs = this.progression.current.worldTimeMs + delayWorldMs
    this.validateTime(dueAtWorldMs)
    return this.register(action, dueAtWorldMs, payload)
  }

  scheduleAt(action: string, dueAtWorldMs: number, payload?: unknown): WorldScheduleId | undefined {
    if (this.disposed) return undefined
    this.validateTime(dueAtWorldMs)
    this.progression.synchronize()
    return this.register(action, dueAtWorldMs, payload)
  }

  cancel(id: WorldScheduleId): boolean {
    if (this.disposed || !this.pending.delete(id)) return false
    this.rearm()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.clearAlarm()
    this.pending.clear()
  }

  private get ready(): boolean {
    return !this.disposed && this.started && this.isRunning()
  }

  private validateTime(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('World schedule times must be finite nonnegative milliseconds')
    }
  }

  private register(action: string, dueAtWorldMs: number, payload: unknown): WorldScheduleId {
    const order = ++this.nextId
    const id: WorldScheduleId = `world:${order}`
    this.pending.set(id, { id, order, action, dueAtWorldMs, payload })
    this.selectDue()
    return id
  }

  private selectDue(): void {
    if (!this.ready) return
    // Queued progression events can be older than the latest committed snapshot.
    const observedWorldMs = this.progression.current.worldTimeMs
    const due = [...this.pending.values()]
      .filter((schedule) => schedule.dueAtWorldMs <= observedWorldMs)
      .sort((a, b) => a.dueAtWorldMs - b.dueAtWorldMs || a.order - b.order)
    for (const schedule of due) {
      this.pending.delete(schedule.id)
      this.enqueue(
        schedule.action,
        schedule.payload,
        Object.freeze({
          type: 'world-time',
          scheduleId: schedule.id,
          dueAtWorldMs: schedule.dueAtWorldMs,
          observedWorldMs,
        }),
      )
    }
    this.rearm()
  }

  private clearAlarm(): void {
    if (this.alarm !== undefined) this.timers.cancel(this.alarm)
    this.alarm = undefined
  }

  private rearm(): void {
    this.clearAlarm()
    if (!this.ready || this.pending.size === 0) return
    let earliest = Infinity
    for (const schedule of this.pending.values())
      earliest = Math.min(earliest, schedule.dueAtWorldMs)
    const projected = this.progression.hostDelayUntil(earliest)
    if (projected === undefined) return
    // A remaining sub-millisecond deadline must not repeatedly wake at zero delay.
    const delay = Math.min(2_147_483_647, Math.max(1, Math.ceil(projected)))
    this.alarm = this.timers.schedule(delay)
  }
}
