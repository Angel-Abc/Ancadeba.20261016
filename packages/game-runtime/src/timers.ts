import type { IMessageBus, IMonotonicClock, ITaskScheduler, Unsubscribe } from '@ancadeba/utilities'
import type { EngineMessages } from './messages.js'

export type TimerId = number

export interface TimerWakeup {
  readonly timerId: TimerId
  readonly dueAt: number
  readonly observedAt: number
}

export interface ITimerService {
  schedule(delayMs: number): TimerId | undefined
  cancel(id: TimerId): boolean
}

interface PendingTimer {
  dueAt: number
  task?: object
  cancel?: Unsubscribe
}

export class TimerService implements ITimerService {
  private readonly pending = new Map<TimerId, PendingTimer>()
  private nextId = 0
  private disposed = false

  constructor(
    private readonly messages: IMessageBus<EngineMessages>,
    private readonly scheduler: ITaskScheduler,
    private readonly clock: IMonotonicClock,
    private readonly allocateId: () => TimerId = () => ++this.nextId,
  ) {}

  schedule(delayMs: number): TimerId | undefined {
    if (this.disposed) return undefined
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
      throw new RangeError('Timer delay must be an integer from 0 through 2147483647 milliseconds')
    }
    const id = this.allocateId()
    const timer: PendingTimer = { dueAt: this.clock.now() + delayMs }
    this.pending.set(id, timer)
    this.arm(id, timer, delayMs)
    return id
  }

  cancel(id: TimerId): boolean {
    const timer = this.pending.get(id)
    if (!timer) return false
    this.pending.delete(id)
    timer.cancel?.()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const timers = [...this.pending.values()]
    this.pending.clear()
    for (const timer of timers) timer.cancel?.()
  }

  private arm(id: TimerId, timer: PendingTimer, delayMs: number): void {
    const task = {}
    timer.task = task
    timer.cancel = this.scheduler.schedule(() => {
      if (this.disposed || this.pending.get(id) !== timer || timer.task !== task) return
      const observedAt = this.clock.now()
      const remaining = timer.dueAt - observedAt
      if (remaining > 0) {
        this.arm(id, timer, remaining)
        return
      }
      this.pending.delete(id)
      this.messages.publish('timer.wakeup', { timerId: id, dueAt: timer.dueAt, observedAt })
    }, delayMs)
  }
}
