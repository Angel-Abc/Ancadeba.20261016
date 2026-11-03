import type { ILogger, IMonotonicClock, ITaskScheduler } from '@ancadeba/utilities'
import { ActionProcessor } from './actionProcessor.js'
import type { GameRules } from './actions.js'
import type { GameInstance, IGameRuntime } from './gameLifecycle.js'
import { GameBindings } from './gameBindings.js'
import type { GameMessageScope } from './gameMessageScope.js'
import { TimerService, type TimerId } from './timers.js'

/** Owns actions, bindings, and private host timers for one playthrough. */
export class GameActionRuntime implements IGameRuntime {
  readonly actions: ActionProcessor
  readonly bindings: GameBindings
  private readonly timers: TimerService
  private started = false
  private disposed = false

  constructor(
    game: GameInstance,
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
      this.bindings = new GameBindings(
        { state: () => game.state, progression: () => this.actions.progression },
        messages,
      )
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
    this.bindings.dispose()

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
