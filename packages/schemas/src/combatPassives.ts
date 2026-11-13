import { bindCombatEffectValues, combatEffectScalings } from './combatEffectValues.js'
import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'
import {
  combatTriggerSchema,
  type CombatTriggerDefinition,
  type CombatTriggerEffect,
  type CombatMechanicsDefinition,
} from './combatMechanics.js'
import {
  bindCombatCondition,
  visitCombatCondition,
  type CombatConditionLeaf,
} from './combatConditions.js'
import { combatMechanicsReferenceIssues } from './combatMechanicsValidation.js'
import type { CombatDefinition } from './combat.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

export const combatPassiveSchema = z.object({
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
  triggers: z
    .record(id, combatTriggerSchema)
    .refine(
      (entries) => Object.keys(entries).length > 0 && Object.keys(entries).length <= 100,
      'Passives require 1–100 triggers',
    ),
})

export type CombatPassive = z.infer<typeof combatPassiveSchema>

export const combatPassiveDefinitionsSchema = z
  .record(id, z.record(id, combatPassiveSchema))
  .refine(
    (libraries) =>
      Object.values(libraries).reduce((sum, entries) => sum + Object.keys(entries).length, 0) <=
      1000,
    'At most 1000 resolved passives are supported',
  )

export type CombatPassiveDefinitions = z.infer<typeof combatPassiveDefinitionsSchema>

/** self belongs to the granting item/status; target continues to refer to the event recipient. */
export function bindCombatPassiveTrigger(
  trigger: CombatTriggerDefinition,
  owner: string,
): CombatTriggerDefinition {
  const actor = (value: string) => (value === 'self' ? owner : value)

  return {
    ...trigger,
    ...(trigger.actor ? { actor: actor(trigger.actor) } : {}),
    ...(trigger.source ? { source: actor(trigger.source) } : {}),
    ...(trigger.target ? { target: actor(trigger.target) } : {}),
    conditions: trigger.conditions.map((condition) => bindCombatCondition(condition, actor)),
    effects: trigger.effects.map((original) => {
      const effect = bindCombatEffectValues(original, actor)

      return {
        ...effect,
        ...('actor' in effect ? { actor: actor(effect.actor) } : {}),
        ...(effect.type === 'damage' || effect.type === 'heal'
          ? { source: actor(effect.source ?? owner) }
          : {}),
        ...(effect.conditions
          ? {
              conditions: effect.conditions.map((condition) =>
                bindCombatCondition(condition, actor),
              ),
            }
          : {}),
      }
    }),
  }
}

/** Library references are contextual; still validate event contracts and local move/status dependencies. */
export function combatPassiveLibraryIssues(
  passive: CombatPassive,
  moves: CombatDefinition['moves'],
  statuses: CombatDefinition['statuses'],
) {
  const actors = new Set(['self', 'target'])

  const resources = new Set<string>(),
    phases = new Set<string>()

  const reference = (
    value:
      | CombatTriggerDefinition
      | CombatTriggerEffect
      | CombatConditionLeaf
      | import('./combatValues.js').CombatScaling['terms'][number],
  ) => {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'string') continue

      if (['actor', 'source', 'target'].includes(key) && !entry.startsWith('event.'))
        actors.add(entry)

      if (key === 'resource') resources.add(entry)

      if (key === 'phase') phases.add(entry)
    }
  }

  for (const trigger of Object.values(passive.triggers)) {
    reference(trigger)

    for (const condition of trigger.conditions) visitCombatCondition(condition, reference)

    for (const effect of trigger.effects) {
      reference(effect)

      for (const { scaling } of combatEffectScalings(effect))
        for (const term of scaling.terms) reference(term)

      for (const condition of effect.conditions ?? []) visitCombatCondition(condition, reference)
    }
  }

  const mechanics: CombatMechanicsDefinition = {
    resources: Object.fromEntries(
      [...resources].map((id) => [
        id,
        { label: '', description: '', initial: 0, maximum: Number.MAX_SAFE_INTEGER },
      ]),
    ),
    phases: Object.fromEntries(
      [...phases].map((id) => [id, { label: '', description: '', onEnter: [] }]),
    ),
    triggers: passive.triggers,
    victory: 'enemies-defeated',
  }

  return combatMechanicsReferenceIssues({
    mechanics,
    actors: [...actors],
    moves,
    statuses,
    enemyMoves: new Map(),
  })
}
