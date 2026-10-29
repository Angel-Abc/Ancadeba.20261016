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
  readonly turnRevision: number
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
}

export interface TurnTransition extends TurnStarted {
  readonly previous: TurnSnapshot
}
