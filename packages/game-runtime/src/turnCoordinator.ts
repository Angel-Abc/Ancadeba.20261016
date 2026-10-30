import type { AppliedActionOutcome } from './actions.js'
import { ActorRoster, type PreparedRosterChange } from './actorRoster.js'
import type {
  ActorAttribution,
  ActorRosterEntry,
  ActorRosterSnapshot,
  InputActorSelector,
  TurnRules,
  TurnSnapshot,
} from './turns.js'

type Policy = { scope: 'global' } | { scope: 'actor'; phases: ReadonlySet<string> }

export interface PreparedTurnTransition {
  readonly previous: TurnSnapshot | undefined
  readonly turnState: TurnSnapshot | undefined
  readonly rosterChange: PreparedRosterChange | undefined
  readonly participants: readonly ActorRosterEntry[]
  readonly cursor: number
  readonly phaseIndex: number
  readonly round: number
  readonly revision: number
  readonly lastEnded: TurnSnapshot | undefined
  readonly advanceTurn: boolean
  readonly roundAdvanced: boolean
}

function copyIds(ids: readonly string[], category: string): readonly string[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    Array.from(ids).some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(ids).size !== ids.length
  ) {
    throw new TypeError(`${category} must contain unique nonempty IDs`)
  }
  return [...ids]
}

/** Pure turn state and eligibility rules. No clocks, timers, handlers, or subscriptions. */
export class TurnCoordinator {
  private readonly actors: readonly string[]
  private readonly phases: readonly string[]
  private readonly policies = new Map<string, Policy>()
  private readonly roster: ActorRoster
  private participants: readonly ActorRosterEntry[]
  private cursor = 0
  private phaseIndex = 0
  private round = 1
  private revision = 0
  private lastEnded: TurnSnapshot | undefined
  private snapshot: TurnSnapshot | undefined

  constructor(rules: TurnRules, actionIds: Iterable<string>) {
    this.actors = copyIds(rules.actors, 'Turn actors')
    this.roster = new ActorRoster(this.actors)
    this.participants = this.roster.current.actors
    this.phases = copyIds(rules.phases, 'Turn phases')
    const actions = new Set(actionIds)
    for (const [id, policy] of rules.actionPolicies) {
      if (!actions.has(id)) throw new Error(`Unknown turn-policy action: ${id}`)
      if (policy.scope === 'global') {
        if ('allowedPhases' in policy && policy.allowedPhases !== undefined)
          throw new TypeError('Global actions cannot restrict phases')
        this.policies.set(id, { scope: 'global' })
      } else if (policy.scope === 'actor') {
        const phases =
          policy.allowedPhases === undefined
            ? this.phases
            : copyIds(policy.allowedPhases, 'Allowed phases')
        if (phases.some((phase) => !this.phases.includes(phase)))
          throw new Error(`Unknown allowed phase for action: ${id}`)
        this.policies.set(id, { scope: 'actor', phases: new Set(phases) })
      } else {
        throw new TypeError(`Invalid turn policy for action: ${id}`)
      }
    }
    for (const id of actions)
      if (!this.policies.has(id)) throw new Error(`Missing turn policy for action: ${id}`)
    this.snapshot = Object.freeze({
      actorId: this.actors[0]!,
      phaseId: this.phases[0]!,
      round: 1,
      revision: 0,
    })
  }

  get current(): TurnSnapshot | undefined {
    return this.snapshot
  }

  get rosterState(): ActorRosterSnapshot {
    return this.roster.current
  }

  captureActor(actorId: string): ActorAttribution {
    return Object.freeze({
      actorId,
      actorGeneration:
        this.roster.current.actors.find((actor) => actor.actorId === actorId)?.generation ?? 0,
      turnRevision: this.revision,
    })
  }

  validateBinding(
    action: string,
    selector: InputActorSelector | undefined,
  ): InputActorSelector | undefined {
    const policy = this.policies.get(action)!
    if (policy.scope === 'global') {
      if (selector !== undefined) throw new TypeError('Global input bindings must be actorless')
      return undefined
    }
    if (!selector) throw new TypeError('Actor input bindings require an actor selector')
    if (selector.type === 'active') return Object.freeze({ type: 'active' })
    if (selector.type === 'fixed' && this.actors.includes(selector.actorId))
      return Object.freeze({ type: 'fixed', actorId: selector.actorId })
    throw new TypeError('Invalid or unknown input actor selector')
  }

  rejection(action: string, actor: ActorAttribution | undefined): string | undefined {
    const policy = this.policies.get(action)!
    if (policy.scope === 'global')
      return actor === undefined ? undefined : 'Global actions must be actorless'
    if (!actor) return 'Actor action requires actor attribution'
    const registration = this.roster.current.actors.find((entry) => entry.actorId === actor.actorId)
    if (!registration) return `Unknown actor: ${actor.actorId}`
    if (actor.actorGeneration !== registration.generation) return 'Stale actor registration'
    if (!this.snapshot) return 'No active actor turn'
    if (registration.eligibleFromRound > this.round)
      return 'Actor is not eligible until the next round'
    if (actor.turnRevision !== this.revision) return 'Stale actor action request'
    if (actor.actorId !== this.snapshot.actorId) return `Inactive actor: ${actor.actorId}`
    if (!policy.phases.has(this.snapshot.phaseId))
      return `Action is not allowed in phase: ${this.snapshot.phaseId}`
    return undefined
  }

  prepare(action: string, outcome: AppliedActionOutcome): PreparedTurnTransition | undefined {
    if (
      (outcome.advancePhase || outcome.advanceTurn) &&
      this.policies.get(action)!.scope === 'global'
    )
      throw new TypeError('Global actions cannot advance actor turns or phases')
    const rosterChange = this.roster.prepare(outcome.rosterChanges, this.round + 1)
    if (!rosterChange && !outcome.advancePhase && !outcome.advanceTurn) return undefined
    const actors = rosterChange?.current.actors ?? this.roster.current.actors
    const survives = (entry: ActorRosterEntry): boolean =>
      actors.some(
        (actor) => actor.actorId === entry.actorId && actor.generation === entry.generation,
      )
    const removedActive = this.snapshot !== undefined && !survives(this.participants[this.cursor]!)
    const advanceTurn =
      this.snapshot !== undefined &&
      (removedActive ||
        outcome.advanceTurn === true ||
        (outcome.advancePhase === true && this.phaseIndex === this.phases.length - 1))
    let participants = this.participants
    let cursor = this.cursor
    let phaseIndex = this.phaseIndex
    let round = this.round
    let revision = this.revision
    let lastEnded = this.lastEnded
    let turnState = this.snapshot
    let roundAdvanced = false
    if (advanceTurn || (!this.snapshot && actors.length > 0)) {
      if (advanceTurn) lastEnded = this.snapshot
      cursor = advanceTurn
        ? participants.findIndex((entry, index) => index > this.cursor && survives(entry))
        : -1
      phaseIndex = 0
      revision++
      if (cursor < 0 && actors.length > 0) {
        round++
        roundAdvanced = true
        participants = actors.filter((actor) => actor.eligibleFromRound <= round)
        cursor = 0
      }
      turnState =
        cursor < 0
          ? undefined
          : Object.freeze({
              actorId: participants[cursor]!.actorId,
              phaseId: this.phases[0]!,
              round,
              revision,
            })
    } else if (outcome.advancePhase && this.snapshot) {
      phaseIndex++
      revision++
      turnState = Object.freeze({ ...this.snapshot, phaseId: this.phases[phaseIndex]!, revision })
    }
    if (!Number.isSafeInteger(round) || !Number.isSafeInteger(revision))
      throw new RangeError('Turn state exceeds the safe counter range')
    return {
      previous: this.snapshot,
      turnState,
      rosterChange,
      participants,
      cursor,
      phaseIndex,
      round,
      revision,
      lastEnded,
      advanceTurn,
      roundAdvanced,
    }
  }

  commit(transition: PreparedTurnTransition): void {
    if (transition.rosterChange) this.roster.commit(transition.rosterChange)
    this.participants = transition.participants
    this.cursor = transition.cursor
    this.phaseIndex = transition.phaseIndex
    this.round = transition.round
    this.revision = transition.revision
    this.lastEnded = transition.lastEnded
    this.snapshot = transition.turnState
  }
}
