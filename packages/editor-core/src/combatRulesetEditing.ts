import type { CombatLibrary, CombatMechanicsOverrides } from '@ancadeba/schemas'
import { object } from './project.js'
import { mergeCombatMechanics } from './combatMechanicsEditing.js'
import { mergeCombatRuleEffects, mergeCombatRuleConditions } from './combatRuleEntryEditing.js'

export function mergeCombatRulesets(previous: unknown, rulesets: CombatLibrary['rulesets']) {
  if (!rulesets) return undefined

  return Object.fromEntries(
    Object.entries(rulesets).map(([id, ruleset]) => {
      const old = object(object(previous)[id])

      return [
        id,
        {
          ...old,
          ...ruleset,
          labelKey: ruleset.labelKey,
          descriptionKey: ruleset.descriptionKey,
          actors: [...ruleset.actors],
          mechanics: mergeCombatMechanics(old.mechanics, ruleset.mechanics),
        },
      ]
    }),
  )
}

export function mergeCombatMechanicsOverrides(
  previous: unknown,
  overrides: CombatMechanicsOverrides | undefined,
) {
  if (!overrides) return undefined
  const old = object(previous)

  const sections = (section: 'resources' | 'triggers' | 'phases', fields: readonly string[]) => {
    const patch = overrides[section]

    if (!patch || !Object.keys(patch).length) return undefined

    return Object.fromEntries(
      Object.entries(patch).map(([id, entry]) => {
        if (entry === null) return [id, null]
        const next = { ...object(object(old[section])[id]), ...entry }

        for (const field of fields) {
          const value = object(entry)[field]

          if (value === undefined) delete next[field]
          else next[field] = value
        }

        const previousEntry = object(object(old[section])[id])

        if ('effects' in entry && entry.effects)
          next.effects = mergeCombatRuleEffects(previousEntry.effects, entry.effects)

        if ('onEnter' in entry && entry.onEnter)
          next.onEnter = mergeCombatRuleEffects(previousEntry.onEnter, entry.onEnter)

        if ('conditions' in entry && entry.conditions)
          next.conditions = mergeCombatRuleConditions(previousEntry.conditions, entry.conditions)

        return [id, next]
      }),
    )
  }

  const result = {
    ...old,
    resources: sections('resources', [
      'label',
      'description',
      'labelKey',
      'descriptionKey',
      'actor',
      'initial',
      'maximum',
    ]),
    triggers: sections('triggers', [
      'source',
      'target',
      'damageType',
      'delivery',
      'includeReactions',
      'event',
      'actor',
      'move',
      'status',
      'resource',
      'phase',
      'once',
      'conditions',
      'effects',
    ]),
    phases: sections('phases', [
      'label',
      'description',
      'labelKey',
      'descriptionKey',
      'onEnter',
      'enemyRotations',
    ]),
    initialPhase: overrides.initialPhase,
    victory: overrides.victory,
    triggerOrder: overrides.triggerOrder,
  }

  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined))
}
