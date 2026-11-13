import type { CombatAIOverrides, CombatLibrary } from '@ancadeba/schemas'
import { object } from './project.js'
import { mergeCombatEnemyAI } from './combatEnemyAIEditing.js'
import { mergeCombatRuleConditions } from './combatRuleEntryEditing.js'

export function mergeCombatAIProfiles(previous: unknown, profiles: CombatLibrary['aiProfiles']) {
  if (!profiles) return undefined

  return Object.fromEntries(
    Object.entries(profiles).map(([id, profile]) => {
      const old = object(object(previous)[id])

      return [
        id,
        {
          ...old,
          ...profile,
          labelKey: profile.labelKey,
          descriptionKey: profile.descriptionKey,
          actors: [...profile.actors],
          ai: mergeCombatEnemyAI(old.ai, profile.ai),
        },
      ]
    }),
  )
}

export function mergeCombatAIOverrides(
  previous: unknown,
  overrides: CombatAIOverrides | undefined,
) {
  if (!overrides) return undefined
  const old = object(previous)

  const result = {
    ...old,
    ...overrides,
    fallback: overrides.fallback,
    ruleOrder: overrides.ruleOrder,
    rules:
      overrides.rules && Object.keys(overrides.rules).length
        ? Object.fromEntries(
            Object.entries(overrides.rules).map(([id, patch]) => {
              if (patch === null) return [id, null]
              const previous = object(object(old.rules)[id])

              return [
                id,
                {
                  ...previous,
                  ...patch,
                  move: patch.move,
                  maxUses: patch.maxUses,
                  conditions: patch.conditions
                    ? mergeCombatRuleConditions(previous.conditions, patch.conditions)
                    : undefined,
                },
              ]
            }),
          )
        : undefined,
  }

  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined))
}
