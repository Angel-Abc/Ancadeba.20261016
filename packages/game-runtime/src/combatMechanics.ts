import type { CombatObservationSink } from './combatObservations.js'
import { resolveCombatEffectValues } from './combatEffectValues.js'
import {
  activateCombatTrigger,
  combatTriggerActivationKey,
  combatTriggerHasLimits,
  combatTriggerLimits,
  validateCombatTriggerActivations,
} from './combatTriggerLimits.js'
import {
  applyCombatInterception,
  combatPendingSnapshot,
  type CombatPendingEffect,
} from './combatInterception.js'
import type { CombatEffectEventData } from '@ancadeba/schemas'
import { bindCombatPassiveTrigger, type CombatPassiveSource } from '@ancadeba/schemas'
import {
  combatPassiveGrants,
  combatPassiveActive,
  combatPassiveReceiptKey,
} from './combatPassives.js'
import { combatResourceCosts, type CombatValueContext } from './combatValues.js'
import { combatEventAmount } from './combatEventValues.js'
import { combatEquipmentResourceGain } from './combatEquipment.js'
import type {
  CombatDefinition,
  CombatMechanicsDefinition,
  CombatTriggerDefinition,
  CombatMechanicsState,
  CombatMoveDefinition,
  CombatTriggerEffect,
  CombatTriggerEvent,
  CombatCondition,
  CombatEquipment,
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
  if (!definition.mechanics && !Object.keys(definition.passiveDefinitions ?? {}).length) return

  return {
    resources: Object.fromEntries(
      Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => [
        id,
        resource.initial,
      ]),
    ),
    ...(definition.mechanics?.initialPhase ? { phase: definition.mechanics.initialPhase } : {}),
    fired: [],
    initialized: false,
  }
}

export function validateCombatMechanicsState(
  definition: CombatDefinition,
  state: CombatMechanicsState | undefined,
): void {
  const mechanics: CombatMechanicsDefinition | undefined =
    definition.mechanics ??
    (Object.keys(definition.passiveDefinitions ?? {}).length
      ? { resources: {}, phases: {}, triggers: {}, victory: 'enemies-defeated' }
      : undefined)

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
  validateCombatTriggerActivations(definition, state)
  const receipts = state.passiveFired ?? []

  if (
    receipts.length > 10000 ||
    new Set(receipts.map(combatPassiveReceiptKey)).size !== receipts.length
  )
    throw new Error('Invalid passive trigger receipts')

  for (const receipt of receipts) {
    const actor = [definition.player, ...definition.enemies].find(
      (actor) => actor.id === receipt.actor,
    )

    const trigger =
      definition.passiveDefinitions?.[receipt.library]?.[receipt.passive]?.triggers[receipt.trigger]

    const status = definition.statuses?.[receipt.id]

    if (
      !actor ||
      !trigger?.once ||
      (receipt.kind === 'equipment'
        ? !actor.equipmentOwner
        : !status?.passives?.some(
            (reference) =>
              reference.library === receipt.library && reference.id === receipt.passive,
          ))
    )
      throw new Error('Invalid passive trigger receipt reference')
  }
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
  observe?: CombatObservationSink | undefined
  values?: ((self: string, target?: string) => CombatValueContext) | undefined
  round?: number | undefined
  equipment?: CombatEquipment | undefined
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
    source?: string,
    duration?: number,
  ) => void
  log: (entry: CombatLogEntry) => void
  finish: (outcome: CombatOutcome) => void
  finished: () => boolean
}

/** A bounded event queue inside the pure round candidate; no callbacks publish external state. */
export class CombatMechanics {
  readonly state: CombatMechanicsState | undefined
  private readonly events: (CombatMechanicsEvent & { unobserved?: boolean })[] = []
  private readonly trackTurns: boolean
  private processing = false
  private operations = 0
  private currentEvent: CombatMechanicsEvent | undefined
  private currentPassive: CombatPassiveSource | undefined
  private currentPending: CombatPendingEffect | undefined
  private currentTrigger: string | undefined

  constructor(
    private readonly definition: CombatDefinition,
    current: CombatMechanicsState | undefined,
    private readonly effects: MechanicsEffects,
    private readonly trace?: (entry: CombatMechanicsTrace) => void,
  ) {
    this.trackTurns = [
      ...Object.values(definition.mechanics?.triggers ?? {}),
      ...Object.values(definition.passiveDefinitions ?? {}).flatMap((entries) =>
        Object.values(entries).flatMap((passive) => Object.values(passive.triggers)),
      ),
    ].some(combatTriggerHasLimits)
    const state = current ?? initialCombatMechanics(definition)
    validateCombatMechanicsState(definition, state)
    this.state = state
      ? {
          ...state,
          resources: { ...state.resources },
          fired: [...state.fired],
          ...(state.activations
            ? {
                activations: state.activations.map((entry) => ({
                  ...entry,
                  ...(entry.passive ? { passive: { ...entry.passive } } : {}),
                })),
              }
            : {}),
          ...(state.passiveFired
            ? { passiveFired: state.passiveFired.map((receipt) => ({ ...receipt })) }
            : {}),
        }
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

    if (!set && amount > 0) {
      const adjusted = combatEquipmentResourceGain(
        this.effects.equipment,
        authored.actor,
        resource,
        amount,
      )

      if (adjusted.items.length)
        this.effects.log({
          type: 'resourceAdjusted',
          resource,
          amount: adjusted.amount,
          requested: amount,
          equipment: adjusted.items,
        })
      amount = adjusted.amount
    }

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

  private context(
    self = this.currentPassive?.actor ?? this.currentEvent?.actor,
    target = this.currentEvent?.target,
  ) {
    return combatConditionContext(this.definition, {
      health: this.effects.health,
      maximumHealth: this.effects.maximumHealth,
      statuses: this.effects.statuses?.() ?? {},
      resources: this.state?.resources ?? {},
      phase: this.state?.phase,
      self,
      target,
      event: this.effectData(),
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
        (Object.values(this.definition.mechanics?.triggers ?? {}).some(
          (trigger) => trigger.event === event.type,
        ) ||
          combatPassiveGrants(
            this.definition,
            this.effects.statuses?.() ?? {},
            this.effects.equipment,
            this.effects.health,
          ).some((source) =>
            Object.values(
              this.definition.passiveDefinitions?.[source.library]?.[source.passive]?.triggers ??
                {},
            ).some((trigger) => trigger.event === event.type),
          ))

      this.events.push({ ...event, unobserved: !observed })
    }

    this.drain()
  }

  private apply(effect: CombatTriggerEffect): void {
    this.limit()

    if (!this.matches(effect.conditions)) return
    const self = this.currentPassive?.actor ?? this.currentEvent?.actor ?? this.definition.player.id

    const values = this.effects.values?.(
      self,
      this.currentEvent?.target ?? this.currentEvent?.actor ?? self,
    )

    effect = resolveCombatEffectValues(
      effect,
      values ? { ...values, event: this.effectData() } : undefined,
    )

    const actor = (reference: string) => {
      const value =
        reference === 'event.source'
          ? this.effectData()?.source
          : reference === 'event.target'
            ? this.effectData()?.target
            : reference

      if (!value || !Object.hasOwn(this.effects.health, value))
        throw new Error('Combat reaction actor unavailable')

      return value
    }

    if (this.currentPending && ['damage', 'heal', 'finish'].includes(effect.type))
      throw new Error('Pending hooks cannot apply HP effects or finish combat')

    if (
      effect.type === 'adjust-effect' ||
      effect.type === 'absorb-damage' ||
      effect.type === 'redirect-damage' ||
      effect.type === 'prevent-lethal'
    ) {
      const pending = this.currentPending

      if (!pending) throw new Error('Interception requires a pending effect')

      const change = applyCombatInterception(pending, effect, {
        health: this.effects.health,
        resources: this.state?.resources ?? {},
        spend: (resource, amount) => this.change(resource, -amount),
        actor,
      })

      if (change) {
        this.effects.observe?.({
          kind: 'interception',
          source: pending.data.source,
          target: pending.data.target,
          trigger: this.currentTrigger,
          change,
        })
        this.effects.log({
          type: 'effectIntercepted',
          actor: this.currentPassive?.actor ?? pending.data.target,
          target: pending.data.target,
          interception: effect.type,
          requested: change.before,
          amount: change.after,
          ...(change.resource ? { resource: change.resource } : {}),
          ...(change.redirectTarget ? { redirectTarget: change.redirectTarget } : {}),
          ...(this.currentPassive ? { passive: this.currentPassive } : {}),
          ...(this.currentTrigger ? { trigger: this.currentTrigger } : {}),
        })
        this.trace?.({
          event: this.currentEvent!.type,
          actor: pending.data.target,
          trigger: this.currentTrigger,
          passive: this.currentPassive,
          source: pending.data.source,
          target: pending.data.target,
          effect: this.effectData(),
          interception: change,
        })
      }
    } else if (effect.type === 'change-resource' || effect.type === 'set-resource')
      this.change(
        effect.resource,
        combatEventAmount(
          effect.amount,
          effect.eventValue,
          this.effectData(),
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
        this.currentPassive?.actor,
        effect.type === 'apply-status' ? effect.duration : undefined,
      )
    else if (effect.type === 'finish') this.effects.finish(effect.outcome)
    else if (effect.type === 'set-phase' && this.state && this.state.phase !== effect.phase) {
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

  private effectData(): CombatEffectEventData | undefined {
    return this.currentPending
      ? combatPendingSnapshot(this.currentPending, this.effects.health)
      : this.currentEvent?.effect
  }

  intercept(
    kind: 'damage' | 'healing',
    data: CombatEffectEventData,
    move?: string,
    status?: string,
    healingCapacity?: number,
  ): CombatPendingEffect | undefined {
    if (!this.state || this.effects.finished()) return
    const event = kind === 'damage' ? 'damage-pending' : 'healing-pending'

    const grants = combatPassiveGrants(
      this.definition,
      this.effects.statuses?.() ?? {},
      this.effects.equipment,
      this.effects.health,
    )

    if (
      !Object.values(this.definition.mechanics?.triggers ?? {}).some(
        (trigger) => trigger.event === event,
      ) &&
      !grants.some((source) =>
        Object.values(
          this.definition.passiveDefinitions?.[source.library]?.[source.passive]?.triggers ?? {},
        ).some((trigger) => trigger.event === event),
      )
    )
      return

    const pending: CombatPendingEffect = {
      kind,
      data,
      healingCapacity,
      amount: data.amount,
      absorbed: 0,
      prevented: 0,
      redirectedAmount: 0,
      floor: 0,
      changed: false,
      redirects: [],
    }

    const previous = this.currentPending,
      processing = this.processing

    this.currentPending = pending
    this.processing = true

    try {
      this.dispatch({
        type: event,
        actor: data.target,
        source: data.source,
        target: data.target,
        move,
        status,
        effect: data,
      })
    } finally {
      this.currentPending = previous
      this.processing = processing
    }

    return pending
  }

  private dispatch(next: CombatMechanicsEvent & { unobserved?: boolean }): void {
    const previousEvent = this.currentEvent,
      previousPassive = this.currentPassive,
      previousTrigger = this.currentTrigger

    try {
      if (next.type === 'turn-start' && this.state && this.trackTurns) {
        const turn = (this.state.turn ?? 0) + 1

        if (!Number.isSafeInteger(turn)) throw new RangeError('Combat trigger turn overflow')
        this.state.turn = turn
      }

      const grants = combatPassiveGrants(
        this.definition,
        this.effects.statuses?.() ?? {},
        this.effects.equipment,
        this.effects.health,
      )

      // Grants may have changed while this notification waited in the FIFO batch.
      const observed =
        !next.unobserved ||
        grants.some((source) =>
          Object.values(
            this.definition.passiveDefinitions?.[source.library]?.[source.passive]?.triggers ?? {},
          ).some((trigger) => trigger.event === next.type),
        )

      if (observed) this.limit()
      this.currentEvent = next
      this.currentPassive = undefined
      this.currentTrigger = undefined
      this.trace?.({
        event: next.type,
        actor: next.actor,
        target: next.target,
        move: next.move,
        status: next.status,
        phase: this.state?.phase,
        source: next.source,
        effect: this.effectData(),
      })

      if (!observed) return

      if (next.type === 'phase-enter') {
        if (next.phase !== this.state?.phase) return

        for (const effect of this.definition.mechanics?.phases[next.phase ?? '']?.onEnter ?? []) {
          this.apply(effect)

          if (this.effects.finished()) break
        }
      }

      const triggers: {
        id: string
        trigger: CombatTriggerDefinition
        passive: CombatPassiveSource | undefined
      }[] = [
        ...Object.entries(this.definition.mechanics?.triggers ?? {}).map(([id, trigger]) => ({
          id,
          trigger,
          passive: undefined,
        })),
        ...grants.flatMap((passive) =>
          Object.entries(
            this.definition.passiveDefinitions?.[passive.library]?.[passive.passive]?.triggers ??
              {},
          ).map(([id, trigger]) => ({
            id,
            trigger: bindCombatPassiveTrigger(trigger, passive.actor),
            passive,
          })),
        ),
      ]

      // Stable sorting preserves authored/source order for equal priorities.
      triggers.sort((left, right) => (right.trigger.priority ?? 0) - (left.trigger.priority ?? 0))

      for (const { id, trigger, passive } of triggers) {
        if (this.effects.finished()) break

        if (next.type === 'phase-enter' && next.phase !== this.state?.phase) break

        if (trigger.event !== next.type) continue

        if (
          passive &&
          !combatPassiveActive(
            this.definition,
            passive,
            this.effects.statuses?.() ?? {},
            this.effects.equipment,
            this.effects.health,
          )
        )
          continue
        this.currentPassive = passive
        this.currentTrigger = id
        const receipt = passive ? { ...passive, trigger: id } : undefined

        const alreadyFired = receipt
          ? this.state?.passiveFired?.some(
              (entry) => combatPassiveReceiptKey(entry) === combatPassiveReceiptKey(receipt),
            )
          : this.state?.fired.includes(id)

        const key = combatTriggerActivationKey(id, passive)

        const previous = this.state?.activations?.find(
          (entry) => combatTriggerActivationKey(entry.trigger, entry.passive) === key,
        )

        const activation = combatTriggerLimits(
          trigger,
          previous,
          this.state?.turn ?? 0,
          this.effects.round ?? 1,
          Boolean(alreadyFired),
        )

        const controlled = trigger.priority !== undefined || combatTriggerHasLimits(trigger)

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
          (next.effect?.reactive &&
            !(
              trigger.includeReactions ??
              (next.type === 'damage-pending' || next.type === 'healing-pending')
            )) ||
          activation.blockers.length > 0 ||
          !conditions.every((condition) => condition.matched)
        )

        this.trace?.({
          event: next.type,
          actor: next.actor,
          phase: this.state?.phase,
          trigger: id,
          ...(passive ? { passive } : {}),
          status: next.status,
          target: next.target,
          move: next.move,
          matched,
          ...(controlled ? { activation } : {}),
          source: next.source,
          effect: this.effectData(),
          conditions,
        })

        if (!matched) continue
        this.limit()

        if (this.state)
          activateCombatTrigger(this.state, trigger, id, passive, this.effects.round ?? 1)

        if (trigger.once && this.state) {
          if (receipt) {
            if ((this.state.passiveFired?.length ?? 0) >= 10000)
              throw new Error('Passive trigger receipt limit exceeded')
            ;(this.state.passiveFired ??= []).push(receipt)
          } else this.state.fired.push(id)
        }

        if (controlled)
          this.trace?.({
            event: next.type,
            actor: next.actor,
            trigger: id,
            ...(passive ? { passive } : {}),
            activated: true,
            activation: combatTriggerLimits(
              trigger,
              this.state?.activations?.find(
                (entry) => combatTriggerActivationKey(entry.trigger, entry.passive) === key,
              ),
              this.state?.turn ?? 0,
              this.effects.round ?? 1,
              Boolean(trigger.once),
            ),
            effect: this.effectData(),
          })

        if (passive) this.effects.observe?.({ kind: 'passive-activations', passive, trigger: id })

        if (passive)
          this.effects.log({
            type: 'passiveTriggered',
            actor: passive.actor,
            passive,
            trigger: id,
          })

        for (const effect of trigger.effects) {
          this.apply(effect)

          if (this.effects.finished()) break
        }
      }
    } finally {
      this.currentEvent = previousEvent
      this.currentPassive = previousPassive
      this.currentTrigger = previousTrigger
    }
  }

  private drain(): void {
    if (this.processing) return
    this.processing = true

    try {
      while (this.events.length && !this.effects.finished()) {
        const next = this.events.shift()!

        this.dispatch(next)
        this.currentPassive = undefined
      }
    } finally {
      this.processing = false
      this.currentPassive = undefined
      this.currentEvent = undefined
    }
  }
}
