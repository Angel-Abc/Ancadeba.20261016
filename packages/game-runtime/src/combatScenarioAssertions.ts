import type { CombatScenarioRichAssertion, CombatPassiveSource } from '@ancadeba/schemas'
import type { CombatSimulation } from './combatSimulation.js'
import {
  combatMetricTotal,
  type CombatSimulationMetric,
  type CombatMetricFilters,
} from './combatObservations.js'
import { cooldownRemaining } from './combatEffects.js'
import { combatTriggerActivationKey } from './combatTriggerLimits.js'

/** Validate every filter, including checks expecting zero; typos must never silently pass. */
export function checkCombatRichAssertion(
  simulation: CombatSimulation,
  expectation: CombatScenarioRichAssertion,
  baseline: readonly CombatSimulationMetric[] = [],
): number {
  const definition = simulation.definition,
    state = simulation.snapshot()

  const actors = [definition.player, ...definition.enemies]

  for (const field of ['actor', 'source', 'target'] as const) {
    const value =
      field in expectation ? Object.getOwnPropertyDescriptor(expectation, field)?.value : undefined

    if (value !== undefined && !actors.some((actor) => actor.id === value))
      throw new Error(`Unknown expected actor: ${value}`)
  }

  if ('move' in expectation && expectation.move && !definition.moves[expectation.move])
    throw new Error(`Unknown expected move: ${expectation.move}`)

  if (
    'resource' in expectation &&
    expectation.resource &&
    !definition.mechanics?.resources[expectation.resource]
  )
    throw new Error(`Unknown expected resource: ${expectation.resource}`)

  if (
    'rule' in expectation &&
    expectation.rule &&
    !actors
      .filter((actor) => !expectation.actor || actor.id === expectation.actor)
      .some((actor) => actor.ai?.rules.some((rule) => rule.id === expectation.rule))
  )
    throw new Error(`Unknown expected AI rule: ${expectation.rule}`)

  if ('damageType' in expectation && expectation.damageType) {
    const types = new Set(['physical'])

    const add = (effects: readonly import('@ancadeba/schemas').CombatTriggerEffect[]) => {
      for (const effect of effects)
        if (effect.type === 'damage') types.add(effect.damageType ?? 'physical')
    }

    for (const move of Object.values(definition.moves)) {
      if (move.type === 'attack') types.add(move.damageType ?? 'physical')

      if (move.type === 'ability')
        for (const effect of move.effects)
          if (effect.type === 'damage') types.add(effect.damageType ?? 'physical')
    }

    for (const owner of [
      definition.player,
      ...definition.enemies,
      ...Object.values(definition.statuses ?? {}),
    ]) {
      for (const key of ['resistances', 'vulnerabilities'] as const)
        for (const type of Object.keys(owner.damageDefenses?.[key] ?? {})) types.add(type)

      for (const type of owner.damageDefenses?.immunities ?? []) types.add(type)

      if ('damageType' in owner && owner.damageType) types.add(owner.damageType)
    }

    for (const trigger of Object.values(definition.mechanics?.triggers ?? {})) add(trigger.effects)

    for (const phase of Object.values(definition.mechanics?.phases ?? {})) add(phase.onEnter)

    for (const entries of Object.values(definition.passiveDefinitions ?? {}))
      for (const passive of Object.values(entries))
        for (const trigger of Object.values(passive.triggers)) add(trigger.effects)

    if (!types.has(expectation.damageType))
      throw new Error(`Unknown expected damage type: ${expectation.damageType}`)
  }

  const inventory = simulation.itemCatalog()?.inventory

  if (expectation.type === 'passive-activations' || expectation.type === 'trigger-cooldown') {
    const passives = Object.entries(definition.passiveDefinitions ?? {}).flatMap(
      ([library, entries]) =>
        Object.entries(entries).map(([id, value]) => ({ library, id, value })),
    )

    const matches = passives.filter(
      (entry) =>
        (!expectation.library || entry.library === expectation.library) &&
        (!expectation.passive || entry.id === expectation.passive),
    )

    if ((expectation.library || expectation.passive) && !matches.length)
      throw new Error('Unknown expected shared passive')

    if (
      expectation.sourceId &&
      !(
        expectation.sourceKind !== 'equipment' &&
        simulation.hasPassiveSource('status', expectation.sourceId)
      ) &&
      !(
        expectation.sourceKind !== 'status' &&
        simulation.hasPassiveSource('equipment', expectation.sourceId)
      )
    )
      throw new Error(`Unknown expected passive source: ${expectation.sourceId}`)

    if (
      expectation.trigger &&
      (expectation.type === 'passive-activations' ||
        expectation.library ||
        expectation.passive ||
        expectation.sourceKind) &&
      !matches.some((entry) => entry.value.triggers[expectation.trigger!])
    )
      throw new Error(`Unknown expected passive trigger: ${expectation.trigger}`)
  }

  if (
    expectation.type === 'interception' &&
    expectation.trigger &&
    !definition.mechanics?.triggers[expectation.trigger] &&
    !Object.values(definition.passiveDefinitions ?? {}).some((entries) =>
      Object.values(entries).some((passive) => passive.triggers[expectation.trigger!]),
    )
  )
    throw new Error(`Unknown expected interception trigger: ${expectation.trigger}`)

  if (expectation.type === 'item-consumption') {
    if (expectation.item && !inventory?.items[expectation.item])
      throw new Error(`Unknown expected item: ${expectation.item}`)

    if (expectation.itemType && !inventory?.itemTypes[expectation.itemType])
      throw new Error(`Unknown expected item type: ${expectation.itemType}`)
  }

  if (expectation.type === 'cooldown')
    return expectation.measure === 'readyRound'
      ? (state.cooldowns[expectation.actor]?.[expectation.move] ?? 0)
      : cooldownRemaining(state.cooldowns, expectation.actor, expectation.move, state.round)

  if (expectation.type === 'trigger-cooldown') {
    let source: CombatPassiveSource | undefined

    if (
      expectation.library ||
      expectation.passive ||
      expectation.sourceKind ||
      expectation.sourceId ||
      expectation.actor
    ) {
      if (
        !expectation.library ||
        !expectation.passive ||
        !expectation.sourceKind ||
        !expectation.sourceId ||
        !expectation.actor
      )
        throw new Error(
          'Passive cooldown checks require actor, library, passive, source kind and source ID',
        )
      source = {
        actor: expectation.actor,
        library: expectation.library,
        passive: expectation.passive,
        kind: expectation.sourceKind,
        id: expectation.sourceId,
      }
    }

    const trigger = source
      ? definition.passiveDefinitions?.[source.library]?.[source.passive]?.triggers[
          expectation.trigger
        ]
      : definition.mechanics?.triggers[expectation.trigger]

    if (!trigger) throw new Error(`Unknown expected cooldown trigger: ${expectation.trigger}`)
    const key = combatTriggerActivationKey(expectation.trigger, source)

    const ready =
      state.mechanics?.activations?.find(
        (entry) => combatTriggerActivationKey(entry.trigger, entry.passive) === key,
      )?.readyRound ?? 0

    return expectation.measure === 'readyRound' ? ready : Math.max(0, ready - state.round)
  }

  const { type, operator: _operator, value: _value, scope, ...fields } = expectation

  if ('measure' in fields) delete fields.measure
  const filters: CombatMetricFilters = fields

  if (type === 'action-choices') filters.result = expectation.result ?? 'chosen'

  if (type === 'item-consumption') filters.consumed = true
  const kind = type === 'item-consumption' ? 'item-use' : type

  const measure =
    ('measure' in expectation ? expectation.measure : undefined) ??
    (type === 'damage-total' || type === 'healing-total' ? 'amount' : 'count')

  const total = combatMetricTotal(simulation.statistics(), kind, filters, measure)

  return scope === 'step' ? total - combatMetricTotal(baseline, kind, filters, measure) : total
}
