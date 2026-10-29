import type { IMessageBus, IMonotonicClock, Unsubscribe } from '@ancadeba/utilities'
import type { ProgressionSnapshot, WorldTimePolicy } from './actions.js'
import type { EngineMessages } from './messages.js'
import type { ITimerService, TimerId } from './timers.js'

/** Owns progression only; it neither executes actions nor owns game-specific state. */
export class GameProgression {
  private snapshot: ProgressionSnapshot = Object.freeze({ turn: 0, worldTimeMs: 0 })
  private readonly mode: WorldTimePolicy['mode']
  private readonly rate: number
  private readonly pulseMs: number
  private readonly unsubscribe: Unsubscribe
  private anchor = 0
  private pulse: TimerId | undefined
  private started = false
  private disposed = false

  constructor(
    policy: WorldTimePolicy | undefined,
    private readonly messages: IMessageBus<EngineMessages>,
    private readonly timers: ITimerService,
    private readonly clock: IMonotonicClock,
  ) {
    this.mode = policy?.mode ?? 'action-driven'
    this.rate = policy?.rate ?? 1
    this.pulseMs = policy?.pulseMs ?? 1000
    if (!['action-driven', 'elapsed', 'hybrid'].includes(this.mode))
      throw new TypeError('Unknown world-time mode')
    if (!Number.isFinite(this.rate) || this.rate <= 0)
      throw new RangeError('World-time rate must be positive and finite')
    if (!Number.isInteger(this.pulseMs) || this.pulseMs < 1 || this.pulseMs > 2_147_483_647) {
      throw new RangeError(
        'World-time pulse must be an integer from 1 through 2147483647 milliseconds',
      )
    }
    this.unsubscribe = messages.subscribe('timer.wakeup', (event) => {
      if (this.disposed || !this.started || event.timerId !== this.pulse) return
      this.pulse = undefined
      this.synchronize()
      this.armPulse()
    })
  }

  get current(): ProgressionSnapshot {
    return this.snapshot
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    if (this.mode !== 'action-driven') {
      this.anchor = this.clock.now()
      this.armPulse()
    }
  }

  synchronize(): void {
    if (this.disposed || !this.started || this.mode === 'action-driven') return
    const now = this.clock.now()
    const worldTimeMs = this.snapshot.worldTimeMs + (now - this.anchor) * this.rate
    this.update(this.snapshot.turn, worldTimeMs)
    this.anchor = now
  }

  apply(advanceTurn: boolean, worldTimeCostMs: number): void {
    if (this.disposed) return
    this.update(
      this.snapshot.turn + (advanceTurn ? 1 : 0),
      this.snapshot.worldTimeMs + (this.mode === 'elapsed' ? 0 : worldTimeCostMs),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    if (this.pulse !== undefined) this.timers.cancel(this.pulse)
    this.pulse = undefined
  }

  private armPulse(): void {
    if (!this.disposed) this.pulse = this.timers.schedule(this.pulseMs)
  }

  private update(turn: number, worldTimeMs: number): void {
    if (
      !Number.isSafeInteger(turn) ||
      !Number.isFinite(worldTimeMs) ||
      worldTimeMs < this.snapshot.worldTimeMs
    ) {
      throw new RangeError(
        'Progression must remain finite, monotonic, and within the safe turn range',
      )
    }
    const previous = this.snapshot
    if (turn === previous.turn && worldTimeMs === previous.worldTimeMs) return
    this.snapshot = Object.freeze({ turn, worldTimeMs })
    const event = Object.freeze({ previous, progression: this.snapshot })
    if (turn !== previous.turn) this.messages.publish('turn.advanced', event)
    if (worldTimeMs !== previous.worldTimeMs) this.messages.publish('world-time.advanced', event)
  }
}
