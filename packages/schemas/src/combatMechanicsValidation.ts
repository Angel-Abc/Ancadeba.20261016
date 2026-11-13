import { combatMoveScalings, combatScalingIssues } from './combatValues.js'
import type { CombatDefinition } from './combat.js'
import { combatStatusApplicationIssues } from './combatAbilities.js'
import { combatConditionIssues, visitCombatCondition } from './combatConditions.js'
import type { CombatCondition } from './combatConditions.js'
import {
  combatEffectEvents,
  combatEventActorReferences,
  combatEventValueFieldsFor,
} from './combatEvents.js'
import type { CombatMechanicsDefinition, CombatTriggerEffect } from './combatMechanics.js'

export interface CombatMechanicsValidationContext {
  mechanics: CombatMechanicsDefinition | undefined
  actors: readonly string[]
  moves: CombatDefinition['moves']
  statuses: CombatDefinition['statuses']
  enemyMoves: ReadonlyMap<string, readonly string[]>
}

export function combatMechanicsIssues(combat: CombatDefinition) {
  const issues = combatMechanicsReferenceIssues({
    mechanics: combat.mechanics,
    actors: [combat.player, ...combat.enemies].map((actor) => actor.id),
    moves: combat.moves,
    statuses: combat.statuses,
    enemyMoves: new Map(combat.enemies.map((actor) => [actor.id, actor.moves])),
  })

  for (const [id, move] of Object.entries(combat.moves)) {
    const resources = [...Object.keys(move.resourceCosts ?? {})]

    for (const [resource] of Object.entries(move.resourceCostScaling ?? {}))
      if (!Object.hasOwn(move.resourceCosts ?? {}, resource))
        issues.push({
          path: ['moves', id, 'resourceCostScaling', resource],
          message: 'Scaling requires a declared resource cost',
        })

    for (const { scaling, path } of combatMoveScalings(move))
      issues.push(
        ...combatScalingIssues(
          scaling,
          {
            actors: [combat.player, ...combat.enemies].map((actor) => actor.id),
            resources: combat.mechanics?.resources ?? {},
            statuses: combat.statuses ?? {},
          },
          ['moves', id, ...path],
        ),
      )

    if (move.type === 'ability')
      for (const [index, entry] of move.effects.entries()) {
        if (entry.type === 'change-resource') resources.push(entry.resource)

        for (const [conditionIndex, condition] of (entry.conditions ?? []).entries())
          issues.push(
            ...combatConditionIssues(
              condition,
              {
                actors: [combat.player, ...combat.enemies].map((actor) => actor.id),
                resources: combat.mechanics?.resources ?? {},
                statuses: combat.statuses ?? {},
                phases: combat.mechanics?.phases ?? {},
              },
              ['moves', id, 'effects', index, 'conditions', conditionIndex],
            ),
          )
      }

    for (const resource of resources)
      if (!Object.hasOwn(combat.mechanics?.resources ?? {}, resource))
        issues.push({ path: ['moves', id], message: `Unknown combat resource: ${resource}` })
  }

  return issues
}

/** Shared mechanics use role names here; resolved encounters use their actual actor IDs. */
export function combatMechanicsReferenceIssues(combat: CombatMechanicsValidationContext) {
  const mechanics = combat.mechanics
  const issues: { path: (string | number)[]; message: string }[] = []
  const actors = combat.actors

  const check = (
    kind: 'actor' | 'resource' | 'phase' | 'move' | 'status',
    value: string | undefined,
    path: (string | number)[],
  ) => {
    if (value === undefined) return

    const exists =
      kind === 'actor'
        ? actors.includes(value)
        : Object.hasOwn(
            (kind === 'resource'
              ? mechanics?.resources
              : kind === 'phase'
                ? mechanics?.phases
                : kind === 'move'
                  ? combat.moves
                  : combat.statuses) ?? {},
            value,
          )

    if (!exists) issues.push({ path: [...path, kind], message: `Unknown combat ${kind}: ${value}` })
  }

  const eventConditions = (
    conditions: readonly CombatCondition[] | undefined,
    eventType: string | undefined,
    path: (string | number)[],
  ) => {
    if (!eventType) return

    for (const [index, condition] of (conditions ?? []).entries())
      visitCombatCondition(condition, (leaf, child) => {
        if (
          (leaf.type === 'event-value' &&
            !combatEventValueFieldsFor(eventType).includes(leaf.field)) ||
          (leaf.type === 'event-flag' &&
            leaf.field === 'immune' &&
            !eventType.startsWith('damage-'))
        )
          issues.push({
            path: [...path, index, ...child, 'field'],
            message: 'This field is unavailable on the selected event',
          })
      })
  }

  const effect = (effect: CombatTriggerEffect, path: (string | number)[], eventType?: string) => {
    const event = eventType !== undefined
    eventConditions(effect.conditions, eventType, [...path, 'conditions'])

    for (const [index, condition] of (effect.conditions ?? []).entries())
      issues.push(
        ...combatConditionIssues(
          condition,
          {
            actors,
            resources: mechanics?.resources ?? {},
            statuses: combat.statuses ?? {},
            phases: mechanics?.phases ?? {},
            event,
          },
          [...path, 'conditions', index],
        ),
      )

    if ('resource' in effect) check('resource', effect.resource, path)

    for (const key of ['actor', 'source'] as const) {
      const value =
        key === 'actor' && 'actor' in effect
          ? effect.actor
          : key === 'source' && 'source' in effect
            ? effect.source
            : undefined

      if (typeof value !== 'string') continue

      if (combatEventActorReferences.some((reference) => reference === value)) {
        if (!event)
          issues.push({
            path: [...path, key],
            message: 'Event actor references require a damage or healing trigger',
          })
      } else if (!actors.includes(value))
        issues.push({ path: [...path, key], message: `Unknown combat actor: ${value}` })
    }

    if ('eventValue' in effect && effect.eventValue && !event)
      issues.push({
        path: [...path, 'eventValue'],
        message: 'Event scaling requires a damage or healing trigger',
      })

    if (
      'eventValue' in effect &&
      effect.eventValue &&
      eventType &&
      !combatEventValueFieldsFor(eventType).includes(effect.eventValue.field)
    )
      issues.push({
        path: [...path, 'eventValue', 'field'],
        message: 'This field is unavailable on the selected event',
      })

    if ('status' in effect) check('status', effect.status, path)

    if (effect.type === 'apply-status' || effect.type === 'remove-status') {
      const status = combat.statuses?.[effect.status]

      if (status)
        for (const issue of combatStatusApplicationIssues(effect, status))
          issues.push({ path: [...path, ...issue.path], message: issue.message })
    }

    if ('phase' in effect) check('phase', effect.phase, path)

    if (
      effect.type === 'set-resource' &&
      !effect.eventValue &&
      effect.amount > (mechanics?.resources[effect.resource]?.maximum ?? 0)
    )
      issues.push({ path: [...path, 'amount'], message: 'Resource value exceeds maximum' })
  }

  for (const [id, resource] of Object.entries(mechanics?.resources ?? {}))
    check('actor', resource.actor, ['mechanics', 'resources', id])

  for (const [id, trigger] of Object.entries(mechanics?.triggers ?? {})) {
    const path = ['mechanics', 'triggers', id]
    const event = combatEffectEvents.some((value) => value === trigger.event)
    eventConditions(trigger.conditions, event ? trigger.event : undefined, [...path, 'conditions'])

    for (const key of ['source', 'target'] as const)
      if (trigger[key] && !actors.includes(trigger[key]!))
        issues.push({ path: [...path, key], message: `Unknown combat actor: ${trigger[key]}` })

    for (const key of ['source', 'target', 'damageType', 'delivery', 'includeReactions'] as const)
      if (trigger[key] !== undefined && !event)
        issues.push({
          path: [...path, key],
          message: 'Effect event filters require damage or healing events',
        })

    if (trigger.damageType && !trigger.event.startsWith('damage-'))
      issues.push({
        path: [...path, 'damageType'],
        message: 'Damage type filters require damage events',
      })

    for (const kind of ['actor', 'resource', 'phase', 'move', 'status'] as const)
      check(kind, trigger[kind], path)

    if (
      trigger.move &&
      !event &&
      !['action-resolved', 'before-action', 'after-action'].includes(trigger.event)
    )
      issues.push({
        path: [...path, 'move'],
        message: 'Move filters require action events',
      })

    if (trigger.resource && trigger.event !== 'resource-changed')
      issues.push({
        path: [...path, 'resource'],
        message: 'Resource filters require resource-changed events',
      })

    if (
      trigger.actor &&
      ![
        'turn-start',
        'turn-end',
        'action-resolved',
        'before-action',
        'after-action',
        'status-applied',
        'status-refreshed',
        'status-removed',
        'status-expired',
        'status-changed',
        'damage-received',
        ...combatEffectEvents,
        'resource-changed',
      ].includes(trigger.event)
    )
      issues.push({ path: [...path, 'actor'], message: 'This event has no actor' })

    if (trigger.status && !trigger.event.startsWith('status-') && !event)
      issues.push({ path: [...path, 'status'], message: 'Status filters require status events' })
    trigger.conditions.forEach((entry, index) =>
      issues.push(
        ...combatConditionIssues(
          entry,
          {
            actors,
            resources: mechanics?.resources ?? {},
            statuses: combat.statuses ?? {},
            phases: mechanics?.phases ?? {},
            event,
          },
          [...path, 'conditions', index],
        ),
      ),
    )
    trigger.effects.forEach((entry, index) =>
      effect(entry, [...path, 'effects', index], event ? trigger.event : undefined),
    )
  }

  for (const [id, phase] of Object.entries(mechanics?.phases ?? {})) {
    phase.onEnter.forEach((entry, index) =>
      effect(entry, ['mechanics', 'phases', id, 'onEnter', index]),
    )

    for (const [actor, rotation] of Object.entries(phase.enemyRotations ?? {})) {
      const enemy = combat.enemyMoves.get(actor)

      if (!enemy || rotation.some((move) => !enemy.includes(move)))
        issues.push({
          path: ['mechanics', 'phases', id, 'enemyRotations', actor],
          message: 'Phase rotations must use an enemy’s available moves',
        })
    }
  }

  return issues
}
