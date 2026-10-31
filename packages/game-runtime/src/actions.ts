import type { GameData } from './gameData.js'
import type { GameInstance } from './gameLifecycle.js'
import type { VirtualInput } from './input.js'
import type { TimerId, TimerWakeup } from './timers.js'
import type {
  ActionRequestOptions,
  ActorAttribution,
  ActorRosterSnapshot,
  RosterChanges,
  InputActorSelector,
  TurnRules,
  TurnSnapshot,
} from './turns.js'

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
  readonly actor?: ActorAttribution
}

export interface AppliedActionOutcome {
  readonly rosterChanges?: RosterChanges
  readonly status: 'applied'
  readonly advanceTurn?: boolean
  readonly advancePhase?: boolean
  readonly worldTimeCostMs?: number
}

export type ActionOutcome =
  | AppliedActionOutcome
  | { readonly status: 'rejected'; readonly reason: string }

export interface IGameActions {
  readonly rosterState: ActorRosterSnapshot | undefined
  readonly progression: ProgressionSnapshot
  readonly turnState: TurnSnapshot | undefined
  request(
    action: string,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): ActionRequestId | undefined
  schedule(
    action: string,
    delayMs: number,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): TimerId | undefined
  cancelScheduled(timerId: TimerId): boolean
  /** Relative to synchronized world time at this call; handlers still execute through the bus. */
  scheduleWorld(
    action: string,
    delayWorldMs: number,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): WorldScheduleId | undefined
  /** Past and current deadlines queue immediately once this game's runtime is running. */
  scheduleWorldAt(
    action: string,
    dueAtWorldMs: number,
    payload?: unknown,
    options?: ActionRequestOptions,
  ): WorldScheduleId | undefined
  cancelWorldScheduled(id: WorldScheduleId): boolean
}

export interface ActionContext {
  readonly rosterState: ActorRosterSnapshot | undefined
  readonly turnState: TurnSnapshot | undefined
  readonly progression: ProgressionSnapshot
  readonly actions: IGameActions
}

export type GameActionHandler = (request: ActionRequest, context: ActionContext) => ActionOutcome

export interface InputActionBinding {
  readonly actor?: InputActorSelector
  readonly context: string
  readonly input: string
  readonly phase?: VirtualInput['phase']
  readonly action: string
}

export interface GameRules {
  readonly turns?: TurnRules
  readonly handlers: ReadonlyMap<string, GameActionHandler>
  readonly inputBindings?: readonly InputActionBinding[]
  readonly worldTime?: WorldTimePolicy
}

/** Called for each new playthrough; return handlers with fresh, game-owned domain state. */
export type GameRulesFactory = (data: GameData, game: GameInstance) => GameRules

export interface ActionApplied {
  readonly rosterState?: ActorRosterSnapshot
  readonly turnState?: TurnSnapshot
  readonly request: ActionRequest
  readonly outcome: AppliedActionOutcome
  readonly progression: ProgressionSnapshot
}

export interface ActionRejected {
  readonly rosterState?: ActorRosterSnapshot
  readonly turnState?: TurnSnapshot
  readonly request: ActionRequest
  readonly reason: string
  readonly progression: ProgressionSnapshot
}

export interface ActionFailed {
  readonly rosterState?: ActorRosterSnapshot
  readonly turnState?: TurnSnapshot
  readonly request: ActionRequest
  readonly error: unknown
  readonly progression: ProgressionSnapshot
}

export interface ProgressionAdvanced {
  readonly previous: ProgressionSnapshot
  readonly progression: ProgressionSnapshot
}
