import type { AppliedActionOutcome } from './actions.js'
import type { ActorAttribution, InputActorSelector, TurnRules, TurnSnapshot } from './turns.js'

type Policy = { scope: 'global' } | { scope: 'actor'; phases: ReadonlySet<string> }

export interface PreparedTurnTransition {
  readonly previous: TurnSnapshot
  readonly turnState: TurnSnapshot
  readonly actorIndex: number
  readonly phaseIndex: number
  readonly advanceTurn: boolean
  readonly roundAdvanced: boolean
}

function copyIds(ids: readonly string[], category: string): readonly string[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || !id.trim()) ||
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
  private actorIndex = 0
  private phaseIndex = 0
  private snapshot: TurnSnapshot

  constructor(rules: TurnRules, actionIds: Iterable<string>) {
    this.actors = copyIds(rules.actors, 'Turn actors')
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

  get current(): TurnSnapshot {
    return this.snapshot
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
    if (!this.actors.includes(actor.actorId)) return `Unknown actor: ${actor.actorId}`
    if (actor.turnRevision !== this.snapshot.revision) return 'Stale actor action request'
    if (actor.actorId !== this.snapshot.actorId) return `Inactive actor: ${actor.actorId}`
    if (!policy.phases.has(this.snapshot.phaseId))
      return `Action is not allowed in phase: ${this.snapshot.phaseId}`
    return undefined
  }

  prepare(action: string, outcome: AppliedActionOutcome): PreparedTurnTransition | undefined {
    if (!outcome.advancePhase && !outcome.advanceTurn) return undefined
    if (this.policies.get(action)!.scope === 'global')
      throw new TypeError('Global actions cannot advance actor turns or phases')
    const advanceTurn = outcome.advanceTurn === true || this.phaseIndex === this.phases.length - 1
    const actorIndex = advanceTurn ? (this.actorIndex + 1) % this.actors.length : this.actorIndex
    const phaseIndex = advanceTurn ? 0 : this.phaseIndex + 1
    const roundAdvanced = advanceTurn && actorIndex === 0
    const round = this.snapshot.round + (roundAdvanced ? 1 : 0)
    const revision = this.snapshot.revision + 1
    if (!Number.isSafeInteger(round) || !Number.isSafeInteger(revision))
      throw new RangeError('Turn state exceeds the safe counter range')
    return {
      previous: this.snapshot,
      turnState: Object.freeze({
        actorId: this.actors[actorIndex]!,
        phaseId: this.phases[phaseIndex]!,
        round,
        revision,
      }),
      actorIndex,
      phaseIndex,
      advanceTurn,
      roundAdvanced,
    }
  }

  commit(transition: PreparedTurnTransition): void {
    this.actorIndex = transition.actorIndex
    this.phaseIndex = transition.phaseIndex
    this.snapshot = transition.turnState
  }
}
