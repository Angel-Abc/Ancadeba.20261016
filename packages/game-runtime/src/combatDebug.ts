import type { CombatInterceptionChange } from './combatInterception.js'
import type {
  CombatMechanicsState,
  CombatEffectEventData,
  CombatPassiveSource,
} from '@ancadeba/schemas'
import type { CombatCooldowns, CombatStatuses } from './combatEffects.js'
import type { CombatLogEntry, CombatOutcome, PlannedMove } from './combatResolution.js'
import type { CombatConditionEvaluation } from './combatConditions.js'
import type { CombatMoveRestriction } from './combatRestrictions.js'

export type EnemyConditionTrace = CombatConditionEvaluation

export type EnemyBlocker =
  | 'use-limit'
  | 'condition'
  | 'ap'
  | 'cooldown'
  | 'reserved'
  | 'resource'
  | 'restriction'
  | 'equipment'
  | 'requirements'

export interface EnemyCandidateTrace {
  readonly requirements?: readonly CombatConditionEvaluation[] | undefined
  readonly restriction?: CombatMoveRestriction | undefined
  readonly kind: 'rule' | 'rotation'
  readonly rule?: string | undefined
  readonly move: string
  readonly uses?: number | undefined
  readonly maximumUses?: number | undefined
  readonly conditions: readonly EnemyConditionTrace[]
  readonly blockers: readonly EnemyBlocker[]
  readonly cost: number
  readonly cooldown: number
  readonly resource?: string | undefined
  readonly required?: number | undefined
  readonly available?: number | undefined
  readonly selected: boolean
}

export interface EnemyDecisionTrace {
  readonly actor: string
  readonly round: number
  readonly phase: string | undefined
  readonly ap: number
  readonly spentAp: number
  readonly remainingAp: number
  readonly cursor: number
  readonly candidates: readonly EnemyCandidateTrace[]
  readonly choice: PlannedMove | undefined
  readonly stop: 'chosen' | 'wait' | 'unavailable' | 'defeated' | 'player-defeated' | 'stunned'
}

export interface CombatMechanicsTrace {
  readonly interception?: CombatInterceptionChange | undefined
  readonly passive?: CombatPassiveSource | undefined
  readonly source?: string | undefined
  readonly effect?: CombatEffectEventData | undefined
  readonly event: string
  readonly actor?: string | undefined
  readonly trigger?: string | undefined
  readonly phase?: string | undefined
  readonly target?: string | undefined
  readonly status?: string | undefined
  readonly move?: string | undefined
  readonly matched?: boolean | undefined
  readonly conditions?: readonly CombatConditionEvaluation[] | undefined
}

export interface CombatDebugFrame {
  readonly requirements?: readonly CombatConditionEvaluation[] | undefined
  readonly kind:
    | 'round-start'
    | 'turn-start'
    | 'enemy-decision'
    | 'mechanics'
    | 'action'
    | 'turn-end'
    | 'round-end'
  readonly round: number
  readonly actor?: string | undefined
  readonly spentAp?: number | undefined
  readonly action?: PlannedMove | undefined
  readonly decision?: EnemyDecisionTrace | undefined
  readonly mechanicsEvent?: CombatMechanicsTrace | undefined
  readonly health: Readonly<Record<string, number>>
  readonly guard: Readonly<Record<string, number>>
  readonly statuses: CombatStatuses
  readonly cooldowns: CombatCooldowns
  readonly mechanics: CombatMechanicsState | undefined
  readonly seed: number
  readonly outcome: CombatOutcome | undefined
  readonly entries: readonly CombatLogEntry[]
}

/** Return false to stop collecting frames, without stopping the simulation. */
export type CombatDebugSink = (frame: CombatDebugFrame) => boolean | void
