import type { GameData } from './gameData.js'
import type { VirtualInput } from './input.js'
import type { TimerId, TimerWakeup } from './timers.js'

export type ActionRequestId = number
export type WorldScheduleId = `world:${number}`

export interface ProgressionSnapshot {
  readonly turn: number
  readonly worldTimeMs: number
}

export interface WorldTimePolicy {
  readonly mode: 'action-driven' | 'elapsed' | 'hybrid'
  readonly rate?: number
  readonly pulseMs?: number
}

export type ActionOrigin =
  | { readonly type: 'direct' }
  | { readonly type: 'input'; readonly event: VirtualInput }
  | { readonly type: 'timer'; readonly event: TimerWakeup }
  | {
      readonly type: 'world-time'
      readonly scheduleId: WorldScheduleId
      readonly dueAtWorldMs: number
      readonly observedWorldMs: number
    }

export interface ActionRequest {
  readonly id: ActionRequestId
  readonly action: string
  /** Payloads, like message-bus payloads, must be treated as immutable. */
  readonly payload?: unknown
  readonly origin: ActionOrigin
}

export interface AppliedActionOutcome {
  readonly status: 'applied'
  readonly advanceTurn?: boolean
  readonly worldTimeCostMs?: number
}

export type ActionOutcome =
  | AppliedActionOutcome
  | { readonly status: 'rejected'; readonly reason: string }

export interface IGameActions {
  readonly progression: ProgressionSnapshot
  request(action: string, payload?: unknown): ActionRequestId | undefined
  schedule(action: string, delayMs: number, payload?: unknown): TimerId | undefined
  cancelScheduled(timerId: TimerId): boolean
  /** Relative to synchronized world time at this call; handlers still execute through the bus. */
  scheduleWorld(
    action: string,
    delayWorldMs: number,
    payload?: unknown,
  ): WorldScheduleId | undefined
  /** Past and current deadlines queue immediately once the session is running. */
  scheduleWorldAt(
    action: string,
    dueAtWorldMs: number,
    payload?: unknown,
  ): WorldScheduleId | undefined
  cancelWorldScheduled(id: WorldScheduleId): boolean
}

export interface ActionContext {
  readonly progression: ProgressionSnapshot
  readonly actions: IGameActions
}

export type GameActionHandler = (request: ActionRequest, context: ActionContext) => ActionOutcome

export interface InputActionBinding {
  readonly context: string
  readonly input: string
  readonly phase?: VirtualInput['phase']
  readonly action: string
}

export interface GameRules {
  readonly handlers: ReadonlyMap<string, GameActionHandler>
  readonly inputBindings?: readonly InputActionBinding[]
  readonly worldTime?: WorldTimePolicy
}

/** Called once per loaded session; return handlers with fresh, session-owned domain state. */
export type GameRulesFactory = (game: GameData) => GameRules

export interface ActionApplied {
  readonly request: ActionRequest
  readonly outcome: AppliedActionOutcome
  readonly progression: ProgressionSnapshot
}

export interface ActionRejected {
  readonly request: ActionRequest
  readonly reason: string
  readonly progression: ProgressionSnapshot
}

export interface ActionFailed {
  readonly request: ActionRequest
  readonly error: unknown
  readonly progression: ProgressionSnapshot
}

export interface ProgressionAdvanced {
  readonly previous: ProgressionSnapshot
  readonly progression: ProgressionSnapshot
}
