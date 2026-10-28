import type { Unsubscribe } from './messaging/index.js'

export interface ITaskScheduler {
  /** Always defer execution. Cancellation must be idempotent. */
  schedule(callback: () => void, delayMs: number): Unsubscribe
}

export interface IMonotonicClock {
  now(): number
}
