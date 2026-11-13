import type { CombatMechanicsDefinition } from '@ancadeba/schemas'
import { object } from './project.js'
import {
  mergeCombatRuleFields as mergeEntry,
  mergeCombatRuleEffects as effects,
  mergeCombatRuleConditions,
} from './combatRuleEntryEditing.js'

/** Preserve extension data while clearing removed mechanics and obsolete union fields. */
export function mergeCombatMechanics(
  previous: unknown,
  definition: CombatMechanicsDefinition | undefined,
) {
  if (!definition) return undefined
  const old = object(previous)

  return {
    ...old,
    ...definition,
    initialPhase: definition.initialPhase,
    resources: Object.fromEntries(
      Object.entries(definition.resources).map(([id, entry]) => [
        id,
        mergeEntry(object(old.resources)[id], entry, ['actor', 'labelKey', 'descriptionKey']),
      ]),
    ),
    triggers: Object.fromEntries(
      Object.entries(definition.triggers).map(([id, entry]) => {
        const previous = object(object(old.triggers)[id])

        return [
          id,
          {
            ...mergeEntry(previous, entry, [
              'actor',
              'move',
              'resource',
              'phase',
              'status',
              'source',
              'target',
              'damageType',
              'delivery',
              'includeReactions',
              'priority',
              'charges',
              'perTurn',
              'cooldown',
            ]),
            conditions: mergeCombatRuleConditions(previous.conditions, entry.conditions),
            effects: effects(previous.effects, entry.effects),
          },
        ]
      }),
    ),
    phases: Object.fromEntries(
      Object.entries(definition.phases).map(([id, entry]) => {
        const previous = object(object(old.phases)[id])

        return [
          id,
          {
            ...mergeEntry(previous, entry, ['labelKey', 'descriptionKey', 'enemyRotations']),
            onEnter: effects(previous.onEnter, entry.onEnter),
          },
        ]
      }),
    ),
  }
}
