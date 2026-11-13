import { combatEffectActorSchema } from './combatEvents.js'
import type { CombatMoveDefinition } from './combat.js'
import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const decimal = z
  .number()
  .finite()
  .min(-10000)
  .max(10000)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
    'Use at most two decimal places',
  )

export const combatScalingStats = ['attack', 'defense', 'guard', 'maximumHealth'] as const

export const combatScalingTermSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('health'),
    actor: combatEffectActorSchema,
    measure: z.enum(['value', 'percent']).optional(),
    factor: decimal,
  }),
  z.object({
    type: z.literal('missing-health'),
    actor: combatEffectActorSchema,
    measure: z.enum(['value', 'percent']).optional(),
    factor: decimal,
  }),
  z.object({
    type: z.literal('stat'),
    actor: combatEffectActorSchema,
    stat: z.enum(combatScalingStats),
    factor: decimal,
  }),
  z.object({ type: z.literal('round'), factor: decimal }),
  z.object({
    type: z.literal('resource'),
    resource: id,
    measure: z.enum(['value', 'percent']).optional(),
    factor: decimal,
  }),
  z.object({
    type: z.literal('status'),
    actor: combatEffectActorSchema,
    status: id,
    measure: z.enum(['stacks', 'intensity', 'remaining']).optional(),
    factor: decimal,
  }),
])

export type CombatScalingTerm = z.infer<typeof combatScalingTermSchema>

export interface CombatScaling {
  terms: CombatScalingTerm[]
  mode?: 'add' | 'percent' | undefined
  rounding?: 'floor' | 'ceil' | 'nearest' | undefined
  minimum?: number | undefined
  maximum?: number | undefined
}

/** A bounded affine formula; the named output type also keeps editor protocol declarations compact. */
export const combatScalingSchema: z.ZodType<CombatScaling> = z
  .object({
    terms: z.array(combatScalingTermSchema).min(1).max(20),
    mode: z.enum(['add', 'percent']).optional(),
    rounding: z.enum(['floor', 'ceil', 'nearest']).optional(),
    minimum: z.number().int().safe().optional(),
    maximum: z.number().int().safe().optional(),
  })
  .refine(
    (value) =>
      value.minimum === undefined || value.maximum === undefined || value.minimum <= value.maximum,
    'Scaling minimum exceeds maximum',
  )

export const combatPercentModifierNames = [
  'attack',
  'defense',
  'guard',
  'ap',
  'apCost',
  'damage',
  'healing',
] as const

export const combatPercentModifiersSchema = z.object({
  attack: decimal.optional(),
  defense: decimal.optional(),
  guard: decimal.optional(),
  ap: decimal.optional(),
  apCost: decimal.optional(),
  damage: decimal.optional(),
  healing: decimal.optional(),
})

export type CombatPercentModifiers = z.infer<typeof combatPercentModifiersSchema>

export function combatScalingIssues(
  scaling: CombatScaling | undefined,
  references: {
    event?: boolean
    actors?: readonly string[]
    resources?: Readonly<Record<string, unknown>>
    statuses?: Readonly<Record<string, unknown>>
  },
  path: (string | number)[] = [],
) {
  const issues: { path: (string | number)[]; message: string }[] = []

  for (const [index, term] of (scaling?.terms ?? []).entries()) {
    const at = [...path, 'terms', index]

    if (term.type === 'resource') {
      if (references.resources && !Object.hasOwn(references.resources, term.resource))
        issues.push({
          path: [...at, 'resource'],
          message: `Unknown scaling resource: ${term.resource}`,
        })
    } else if (term.type !== 'round') {
      if (term.actor.startsWith('event.') && !references.event)
        issues.push({
          path: [...at, 'actor'],
          message: 'Event actors require a damage or healing trigger',
        })

      if (
        references.actors &&
        ![
          'self',
          'target',
          ...(references.event ? ['event.source', 'event.target'] : []),
          ...references.actors,
        ].includes(term.actor)
      )
        issues.push({ path: [...at, 'actor'], message: `Unknown scaling actor: ${term.actor}` })

      if (
        term.type === 'status' &&
        references.statuses &&
        !Object.hasOwn(references.statuses, term.status)
      )
        issues.push({ path: [...at, 'status'], message: `Unknown scaling status: ${term.status}` })
    }
  }

  return issues
}

export function combatMoveScalings(
  move: CombatMoveDefinition,
): { scaling: CombatScaling; path: (string | number)[] }[] {
  const entries: { scaling: CombatScaling; path: (string | number)[] }[] = []

  if (move.apCostScaling) entries.push({ scaling: move.apCostScaling, path: ['apCostScaling'] })

  for (const [id, scaling] of Object.entries(move.resourceCostScaling ?? {}))
    entries.push({ scaling, path: ['resourceCostScaling', id] })

  if ('scaling' in move && move.scaling) entries.push({ scaling: move.scaling, path: ['scaling'] })

  if (move.type === 'ability')
    for (const [index, effect] of move.effects.entries()) {
      if ('scaling' in effect && effect.scaling)
        entries.push({ scaling: effect.scaling, path: ['effects', index, 'scaling'] })

      for (const [key, scaling] of Object.entries(effect.valueScaling ?? {}))
        entries.push({ scaling, path: ['effects', index, 'valueScaling', key] })
    }

  return entries
}
