import type { CombatEnemyAI } from '@ancadeba/schemas'
import { object } from './project.js'
import { mergeCombatRuleConditions } from './combatRuleEntryEditing.js'

export function mergeCombatEnemyAI(previous: unknown, ai: CombatEnemyAI | undefined) {
  if (!ai) return undefined
  const old = object(previous)
  const rules = (Array.isArray(old.rules) ? old.rules : []).map(object)

  return {
    ...old,
    ...ai,
    rules: ai.rules.map((rule) => {
      const previous = rules.find((entry) => entry.id === rule.id)

      return {
        ...previous,
        ...rule,
        conditions: mergeCombatRuleConditions(previous?.conditions, rule.conditions),
      }
    }),
  }
}
