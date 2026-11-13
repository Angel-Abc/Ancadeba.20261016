import { combatTriggerControlFields } from './combatTriggerLimits.js'
import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { combatDamageTypeSchema } from './combatDamage.js'
import { combatEffectDeliveries } from './combatEvents.js'
import { translationKeySchema } from './languages.js'
import {
  combatMechanicsSchema,
  combatTriggerConditionSchema,
  combatTriggerEffectSchema,
  combatTriggerEvents,
  type CombatMechanicsDefinition,
} from './combatMechanics.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const amount = z.number().int().nonnegative().safe()

const presentation = {
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
}

export const combatRulesetSchema = z.object({
  ...presentation,
  actors: z
    .array(id)
    .max(33)
    .refine((actors) => new Set(actors).size === actors.length, 'Actor roles must be unique')
    .default([]),
  mechanics: combatMechanicsSchema,
})

export type CombatRuleset = z.infer<typeof combatRulesetSchema>

export const combatRulesetReferenceSchema = z.object({
  library: id,
  id,
  actors: z.record(id, id).optional(),
})

/** Later layers replace colliding entries only when explicitly requested. */
export const combatRulesetLayerSchema = combatRulesetReferenceSchema.extend({
  collision: z.enum(['error', 'replace']).optional(),
})

export type CombatRulesetLayer = z.infer<typeof combatRulesetLayerSchema>

export function combatRulesetReferences(source: {
  ruleset?: z.infer<typeof combatRulesetReferenceSchema> | null | undefined
  rulesets?: readonly CombatRulesetLayer[] | undefined
}): readonly CombatRulesetLayer[] {
  return source.rulesets ?? (source.ruleset ? [source.ruleset] : [])
}

const presentationOverride = {
  label: z.string().optional(),
  description: z.string().optional(),
  labelKey: translationKeySchema.nullable().optional(),
  descriptionKey: translationKeySchema.nullable().optional(),
}

const resourceOverride = z.object({
  ...presentationOverride,
  actor: id.nullable().optional(),
  initial: amount.optional(),
  maximum: amount.positive().optional(),
})

const triggerOverride = z.object({
  priority: combatTriggerControlFields.priority.nullable(),
  charges: combatTriggerControlFields.charges.nullable(),
  perTurn: combatTriggerControlFields.perTurn.nullable(),
  cooldown: combatTriggerControlFields.cooldown.nullable(),

  source: id.nullable().optional(),
  target: id.nullable().optional(),
  damageType: combatDamageTypeSchema.nullable().optional(),
  delivery: z.enum(combatEffectDeliveries).nullable().optional(),
  includeReactions: z.boolean().nullable().optional(),
  event: z.enum(combatTriggerEvents).optional(),
  actor: id.nullable().optional(),
  move: id.nullable().optional(),
  status: id.nullable().optional(),
  resource: id.nullable().optional(),
  phase: id.nullable().optional(),
  once: z.boolean().optional(),
  conditions: z.array(combatTriggerConditionSchema).max(20).optional(),
  effects: z.array(combatTriggerEffectSchema).min(1).max(20).optional(),
})

const phaseOverride = z.object({
  ...presentationOverride,
  onEnter: z.array(combatTriggerEffectSchema).max(20).optional(),
  enemyRotations: z.record(id, z.array(id).min(1).nullable()).nullable().optional(),
})

/** Sparse patches never supply defaults. Null removes an inherited entry or optional field. */
export const combatMechanicsOverridesSchema = z.object({
  resources: z.record(id, resourceOverride.nullable()).optional(),
  triggers: z.record(id, triggerOverride.nullable()).optional(),
  phases: z.record(id, phaseOverride.nullable()).optional(),
  initialPhase: id.nullable().optional(),
  victory: z.enum(['enemies-defeated', 'triggers']).optional(),
  triggerOrder: z
    .array(id)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Trigger order must be unique')
    .optional(),
})

export type CombatMechanicsOverrides = z.infer<typeof combatMechanicsOverridesSchema>

export function cloneCombatRules<T>(value: T): T {
  if (Array.isArray(value)) {
    // SAFETY: schema-owned combat data is JSON; recursive mapping preserves T's elements and keys.
    return value.map(cloneCombatRules) as T
  }

  if (value !== null && typeof value === 'object') {
    // SAFETY: recursively cloning each own JSON property preserves the input object type T.
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneCombatRules(entry)]),
    ) as T
  }

  return value
}

function applyFields(previous: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const result = previous !== null && typeof previous === 'object' ? { ...previous } : {}
  const fields: Record<string, unknown> = result

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete fields[key]
    else if (value !== undefined) fields[key] = cloneCombatRules(value)
  }

  return fields
}

interface CombatRuleFields {
  [key: string]: unknown
}

/** Resolve a patch to a complete definition without mutating either authored input. */
export function applyCombatMechanicsOverrides(
  base: CombatMechanicsDefinition,
  overrides?: CombatMechanicsOverrides,
) {
  const result = cloneCombatRules(base)

  if (!overrides) return result
  const merged: CombatRuleFields = { ...result }

  for (const section of ['resources', 'triggers', 'phases'] as const) {
    const entries: CombatRuleFields = { ...result[section] }

    for (const [id, patch] of Object.entries(overrides[section] ?? {})) {
      if (patch === null) delete entries[id]
      else {
        const entry = applyFields(entries[id], patch)

        if (
          section === 'phases' &&
          'enemyRotations' in patch &&
          patch.enemyRotations !== null &&
          patch.enemyRotations !== undefined
        ) {
          entry.enemyRotations = applyFields(
            result.phases[id]?.enemyRotations,
            patch.enemyRotations,
          )
        }

        entries[id] = entry
      }
    }

    merged[section] = entries
  }

  if (overrides.initialPhase === null) delete merged.initialPhase
  else if (overrides.initialPhase !== undefined) merged.initialPhase = overrides.initialPhase

  if (overrides.victory !== undefined) merged.victory = overrides.victory
  const parsed = combatMechanicsSchema.parse(merged)

  if (overrides.triggerOrder) {
    for (const id of overrides.triggerOrder)
      if (!Object.hasOwn(parsed.triggers, id))
        throw new Error(`Unknown trigger in triggerOrder: ${id}`)
    parsed.triggers = Object.fromEntries([
      ...overrides.triggerOrder.map((id) => [id, parsed.triggers[id]!] as const),
      ...Object.entries(parsed.triggers).filter(([id]) => !overrides.triggerOrder!.includes(id)),
    ])
  }

  return parsed
}
