import type { ProgressionSnapshot } from './actions.js'

export interface TurnSnapshot {
  readonly actorId: string
  readonly phaseId: string
  readonly round: number
  readonly revision: number
}

export type ActionTurnPolicy =
  | { readonly scope: 'global' }
  | { readonly scope: 'actor'; readonly allowedPhases?: readonly string[] }

export interface TurnRules {
  readonly actors: readonly string[]
  readonly phases: readonly string[]
  readonly actionPolicies: ReadonlyMap<string, ActionTurnPolicy>
}

export interface ActorAttribution {
  readonly actorId: string
  readonly actorGeneration: number
  readonly turnRevision: number
}

export interface RosterChanges {
  readonly add?: readonly string[]
  readonly remove?: readonly string[]
}

export interface ActorRosterEntry {
  readonly actorId: string
  readonly generation: number
  readonly eligibleFromRound: number
}

export interface ActorRosterSnapshot {
  readonly revision: number
  readonly actors: readonly ActorRosterEntry[]
}

export interface ActionRequestOptions {
  readonly actorId: string
}

export type InputActorSelector =
  | { readonly type: 'fixed'; readonly actorId: string }
  | { readonly type: 'active' }

export interface TurnStarted {
  readonly turnState: TurnSnapshot
  readonly progression: ProgressionSnapshot
  readonly rosterState: ActorRosterSnapshot
}

export interface TurnTransition extends TurnStarted {
  readonly previous: TurnSnapshot
}

export interface TurnEnded {
  readonly previous: TurnSnapshot
  readonly turnState?: TurnSnapshot
  readonly progression: ProgressionSnapshot
  readonly rosterState: ActorRosterSnapshot
}

export interface TurnIdle {
  readonly previous: TurnSnapshot
  readonly progression: ProgressionSnapshot
  readonly rosterState: ActorRosterSnapshot
}

export interface TurnRosterChanged {
  readonly previous: ActorRosterSnapshot
  readonly rosterState: ActorRosterSnapshot
  readonly turnState?: TurnSnapshot
  readonly progression: ProgressionSnapshot
}
