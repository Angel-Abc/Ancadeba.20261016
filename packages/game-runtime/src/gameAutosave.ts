import type { ITaskScheduler } from '@ancadeba/utilities'
import type { GameInstance, IGameLifecycle } from './gameLifecycle.js'

/** Coalesces progress notifications into deferred checkpoints owned by the active playthrough. */
export class GameAutosave {
  private disposed = false
  private generation = 0
  private game: GameInstance | undefined
  private checkpoint: (() => void) | undefined
  private interval: (() => void) | undefined
  private subscriptions: (() => void)[] = []
  private readonly unsubscribe: () => void

  constructor(
    private readonly lifecycle: IGameLifecycle,
    private readonly scheduler: ITaskScheduler,
    private readonly save: () => void,
  ) {
    this.unsubscribe = lifecycle.subscribeSceneChanges(() => this.refresh())
    this.refresh()
  }

  private refresh(): void {
    if (this.disposed) return

    if (this.game !== this.lifecycle.currentGame) {
      this.releaseGame()
      const game = this.lifecycle.currentGame
      this.game = game

      if (game) {
        const request = () => this.request()
        this.subscriptions = [
          game.bindings?.subscribeChanges(request),
          game.inventory?.subscribeChanges(request),
          game.mapMovement?.subscribeChanges(request),
          game.combat?.subscribeChanges(request),
          game.dialogue?.subscribeChanges(request),
          game.nearby?.subscribeChanges(request),
          game.inventorySelection?.subscribe(request),
        ].filter((release) => release !== undefined)
        this.scheduleInterval()
      }
    }

    if (this.game) this.request()
  }

  private request(): void {
    if (this.disposed || !this.game || this.checkpoint) return
    const game = this.game
    const generation = this.generation
    this.checkpoint = this.scheduler.schedule(() => {
      if (this.disposed || generation !== this.generation) return
      this.checkpoint = undefined

      if (this.lifecycle.currentGame !== game) {
        this.refresh()

        return
      }

      this.save()
    }, 500)
  }

  private scheduleInterval(): void {
    const generation = this.generation
    this.interval = this.scheduler.schedule(() => {
      if (this.disposed || generation !== this.generation) return
      this.interval = undefined

      if (this.lifecycle.currentGame !== this.game) {
        this.refresh()

        return
      }

      this.request()
      this.scheduleInterval()
    }, 30_000)
  }

  private releaseGame(): void {
    this.generation++
    this.checkpoint?.()
    this.interval?.()
    this.checkpoint = this.interval = undefined

    for (const release of this.subscriptions.splice(0)) release()
    this.game = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.releaseGame()
  }
}
