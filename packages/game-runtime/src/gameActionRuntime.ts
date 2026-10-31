import type { ILogger, IMonotonicClock, ITaskScheduler } from '@ancadeba/utilities'
import { ActionProcessor } from './actionProcessor.js'
import type { GameRules } from './actions.js'
import type { IGameRuntime } from './gameLifecycle.js'
import type { GameMessageScope } from './gameMessageScope.js'
import { TimerService, type TimerId } from './timers.js'

/** Owns the action processor and its private host timers for one playthrough. */
export class GameActionRuntime implements IGameRuntime {
  readonly actions: ActionProcessor
  private readonly timers: TimerService
  private started = false
  private disposed = false

  constructor(
    rules: GameRules,
    readonly messages: GameMessageScope,
    scheduler: ITaskScheduler,
    clock: IMonotonicClock,
    logger: ILogger,
    private readonly isRunning: () => boolean,
    private readonly onStart: () => void,
    allocateTimerId: () => TimerId,
    private readonly onDispose: () => void,
  ) {
    this.timers = new TimerService(messages, scheduler, clock, allocateTimerId)
    try {
      this.actions = new ActionProcessor(rules, messages, this.timers, clock, logger, isRunning)
    } catch (error) {
      this.timers.dispose()
      messages.dispose()
      throw error
    }
  }

  start(): void {
    if (this.disposed || this.started || !this.isRunning()) return
    this.started = true
    this.onStart()
    this.actions.start()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.actions.dispose()
    } finally {
      try {
        this.timers.dispose()
      } finally {
        this.messages.dispose()
        this.onDispose()
      }
    }
  }
}
