import { combatResourceCosts, type CombatValueContext } from './combatValues.js'
import { combatEventAmount } from './combatEventValues.js'
import type {
  CombatDefinition,
  CombatMechanicsState,
  CombatMoveDefinition,
  CombatTriggerEffect,
  CombatTriggerEvent,
  CombatCondition,
  CombatEffectEventData,
} from '@ancadeba/schemas'
import type { CombatLogEntry, CombatOutcome, PlannedMove } from './combatResolution.js'
import type { CombatMechanicsTrace } from './combatDebug.js'
import {
  combatConditionContext,
  combatConditionsMatch,
  evaluateCombatCondition,
} from './combatConditions.js'
import type { CombatStatuses } from './combatEffects.js'

export function initialCombatMechanics(
  definition: CombatDefinition,
): CombatMechanicsState | undefined {
  if (!definition.mechanics) return

  return {
    resources: Object.fromEntries(
      Object.entries(definition.mechanics.resources).map(([id, resource]) => [
        id,
        resource.initial,
      ]),
    ),
    ...(definition.mechanics.initialPhase ? { phase: definition.mechanics.initialPhase } : {}),
    fired: [],
    initialized: false,
  }
}

export function validateCombatMechanicsState(
  definition: CombatDefinition,
  state: CombatMechanicsState | undefined,
): void {
  const mechanics = definition.mechanics

  if (!mechanics) {
    if (state) throw new Error('Unexpected saved combat mechanics')

    return
  }

  if (
    !state ||
    Object.keys(state.resources).length !== Object.keys(mechanics.resources).length ||
    Object.entries(state.resources).some(
      ([id, value]) =>
        !Object.hasOwn(mechanics.resources, id) ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > mechanics.resources[id]!.maximum,
    ) ||
    (state.phase !== undefined && !Object.hasOwn(mechanics.phases, state.phase)) ||
    (Object.keys(mechanics.phases).length > 0 && !state.phase) ||
    new Set(state.fired).size !== state.fired.length ||
    state.fired.some((id) => !mechanics.triggers[id]?.once)
  )
    throw new Error('Invalid saved combat mechanics')
}

/** Planning reserves costs only: future gains and triggers are conditional until resolution. */
export function combatResourceIssue(
  move: CombatMoveDefinition,
  resources: Readonly<Record<string, number>>,
  plan: readonly PlannedMove[] = [],
  moves: CombatDefinition['moves'] = {},
  context?: CombatValueContext,
): string | undefined {
  for (const [id, cost] of Object.entries(combatResourceCosts(move, context))) {
    const reserved = plan.reduce(
      (total, entry) =>
        total +
        (moves[entry.move]
          ? (combatResourceCosts(
              moves[entry.move]!,
              context ? { ...context, target: entry.target } : undefined,
            )[id] ?? 0)
          : 0),
      0,
    )

    if (!Number.isSafeInteger(reserved) || cost > (resources[id] ?? 0) - reserved) return id
  }
}

export interface CombatMechanicsEvent {
  type: CombatTriggerEvent
  actor?: string | undefined
  move?: string | undefined
  resource?: string | undefined
  phase?: string | undefined
  status?: string | undefined
  target?: string | undefined
  source?: string | undefined
  effect?: CombatEffectEventData | undefined
}

interface MechanicsEffects {
  damage?: (source: string, target: string, amount: number, damageType?: string) => void
  heal?: (source: string, target: string, amount: number) => void
  health: Readonly<Record<string, number>>
  maximumHealth?: Readonly<Record<string, number>> | undefined
  statuses?: (() => CombatStatuses) | undefined
  status: (
    actor: string,
    status: string,
    remove: boolean,
    stacks?: number,
    intensity?: number,
  ) => void
  log: (entry: CombatLogEntry) => void
  finish: (outcome: CombatOutcome) => void
  finished: () => boolean
}

/** A bounded event queue inside the pure round candidate; no callbacks publish external state. */
export class CombatMechanics {
  readonly state: CombatMechanicsState | undefined
  private readonly events: (CombatMechanicsEvent & { unobserved?: boolean })[] = []
  private processing = false
  private operations = 0
  private currentEvent: CombatMechanicsEvent | undefined

  constructor(
    private readonly definition: CombatDefinition,
    current: CombatMechanicsState | undefined,
    private readonly effects: MechanicsEffects,
    private readonly trace?: (entry: CombatMechanicsTrace) => void,
  ) {
    const state = current ?? initialCombatMechanics(definition)
    validateCombatMechanicsState(definition, state)
    this.state = state
      ? { ...state, resources: { ...state.resources }, fired: [...state.fired] }
      : undefined
  }

  start(): void {
    if (!this.state || this.state.initialized) return
    this.state.initialized = true

    // Initial phase entry precedes encounter-start; subsequent entries run once per transition.
    if (this.state.phase) this.emit({ type: 'phase-enter', phase: this.state.phase })
    this.emit({ type: 'encounter-start' })
  }

  change(resource: string, amount: number, set = false): void {
    const authored = this.definition.mechanics?.resources[resource]

    if (!this.state || !authored) throw new Error('Unknown combat resource')
    const next = set ? amount : this.state.resources[resource]! + amount

    if (!Number.isSafeInteger(next)) throw new RangeError('Combat resource overflow')
    const value = Math.max(0, Math.min(authored.maximum, next))

    if (value === this.state.resources[resource]) return
    this.state.resources[resource] = value
    this.effects.log({ type: 'resourceChanged', resource, amount: value })
    this.emit({ type: 'resource-changed', resource, actor: authored.actor })
  }

  pay(move: CombatMoveDefinition): void {
    // All costs are checked together before any trigger can change another resource.
    this.processing = true

    try {
      for (const [id, amount] of Object.entries(move.resourceCosts ?? {})) this.change(id, -amount)
    } finally {
      this.processing = false
    }

    this.drain()
  }

  private context(self = this.currentEvent?.actor, target = this.currentEvent?.target) {
    return combatConditionContext(this.definition, {
      health: this.effects.health,
      maximumHealth: this.effects.maximumHealth,
      statuses: this.effects.statuses?.() ?? {},
      resources: this.state?.resources ?? {},
      phase: this.state?.phase,
      self,
      target,
      event: this.currentEvent?.effect,
    })
  }

  matches(
    conditions: readonly CombatCondition[] | undefined,
    self?: string,
    target?: string,
  ): boolean {
    return combatConditionsMatch(conditions, this.context(self, target))
  }

  /** Unobserved lifecycle events remain visible to debugging without spending the trigger budget. */
  lifecycle(...events: CombatMechanicsEvent[]): void {
    if (this.effects.finished()) return

    for (const event of events) {
      const observed =
        this.state &&
        Object.values(this.definition.mechanics?.triggers ?? {}).some(
          (trigger) => trigger.event === event.type,
        )

      this.events.push({ ...event, unobserved: !observed })
    }

    this.drain()
  }

  private apply(effect: CombatTriggerEffect): void {
    this.limit()

    if (!this.matches(effect.conditions)) return

    const actor = (reference: string) => {
      const value =
        reference === 'event.source'
          ? this.currentEvent?.effect?.source
          : reference === 'event.target'
            ? this.currentEvent?.effect?.target
            : reference

      if (!value || !Object.hasOwn(this.effects.health, value))
        throw new Error('Combat reaction actor unavailable')

      return value
    }

    if (effect.type === 'change-resource' || effect.type === 'set-resource')
      this.change(
        effect.resource,
        combatEventAmount(
          effect.amount,
          effect.eventValue,
          this.currentEvent?.effect,
          effect.type === 'change-resource',
        ),
        effect.type === 'set-resource',
      )
    else if (effect.type === 'damage' || effect.type === 'heal') {
      const callback = effect.type === 'damage' ? this.effects.damage : this.effects.heal

      if (!callback) throw new Error('Combat reactive effects unavailable')
      callback(
        actor(effect.source ?? effect.actor),
        actor(effect.actor),
        combatEventAmount(effect.amount, effect.eventValue, this.currentEvent?.effect),
        effect.type === 'damage' ? effect.damageType : undefined,
      )
    } else if (effect.type === 'apply-status' || effect.type === 'remove-status')
      this.effects.status(
        actor(effect.actor),
        effect.status,
        effect.type === 'remove-status',
        effect.stacks,
        effect.type === 'apply-status' ? effect.intensity : undefined,
      )
    else if (effect.type === 'finish') this.effects.finish(effect.outcome)
    else if (this.state && this.state.phase !== effect.phase) {
      this.state.phase = effect.phase
      this.effects.log({ type: 'phaseChanged', phase: effect.phase })
      this.events.push({ type: 'phase-enter', phase: effect.phase })
    }
  }

  private limit(): void {
    if (++this.operations > 1000) throw new Error('Combat trigger operation limit exceeded')
  }

  emit(event: CombatMechanicsEvent): void {
    if (!this.state || this.effects.finished()) return
    this.events.push(event)
    this.drain()
  }

  private drain(): void {
    if (this.processing) return
    this.processing = true

    try {
      while (this.events.length && !this.effects.finished()) {
        const next = this.events.shift()!

        if (!next.unobserved) this.limit()
        this.currentEvent = next
        this.trace?.({
          event: next.type,
          actor: next.actor,
          target: next.target,
          move: next.move,
          status: next.status,
          phase: this.state?.phase,
          source: next.source,
          effect: next.effect,
        })

        if (next.unobserved) continue

        if (next.type === 'phase-enter') {
          if (next.phase !== this.state?.phase) continue

          for (const effect of this.definition.mechanics?.phases[next.phase ?? '']?.onEnter ?? []) {
            this.apply(effect)

            if (this.effects.finished()) break
          }
        }

        for (const [id, trigger] of Object.entries(this.definition.mechanics?.triggers ?? {})) {
          if (this.effects.finished()) break

          if (next.type === 'phase-enter' && next.phase !== this.state?.phase) break

          if (trigger.event !== next.type) continue

          const conditions = trigger.conditions.map((condition) =>
            evaluateCombatCondition(condition, this.context()),
          )

          const matched = !(
            (trigger.actor !== undefined && trigger.actor !== next.actor) ||
            (trigger.move !== undefined && trigger.move !== next.move) ||
            (trigger.resource !== undefined && trigger.resource !== next.resource) ||
            (trigger.phase !== undefined && trigger.phase !== this.state?.phase) ||
            (trigger.status !== undefined && trigger.status !== next.status) ||
            (trigger.source !== undefined && trigger.source !== next.effect?.source) ||
            (trigger.target !== undefined && trigger.target !== next.effect?.target) ||
            (trigger.damageType !== undefined && trigger.damageType !== next.effect?.damageType) ||
            (trigger.delivery !== undefined && trigger.delivery !== next.effect?.delivery) ||
            (next.effect?.reactive && !trigger.includeReactions) ||
            (trigger.once && this.state?.fired.includes(id)) ||
            !conditions.every((condition) => condition.matched)
          )

          this.trace?.({
            event: next.type,
            actor: next.actor,
            phase: this.state?.phase,
            trigger: id,
            status: next.status,
            target: next.target,
            move: next.move,
            matched,
            source: next.source,
            effect: next.effect,
            conditions,
          })

          if (!matched) continue
          this.limit()

          if (trigger.once) this.state?.fired.push(id)

          for (const effect of trigger.effects) {
            this.apply(effect)

            if (this.effects.finished()) break
          }
        }
      }
    } finally {
      this.processing = false
      this.currentEvent = undefined
    }
  }
}
