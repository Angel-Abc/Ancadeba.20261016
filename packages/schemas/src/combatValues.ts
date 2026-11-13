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

export const combatScalingTermSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resource'),
    resource: id,
    measure: z.enum(['value', 'percent']).optional(),
    factor: decimal,
  }),
  z.object({
    type: z.literal('status'),
    actor: id,
    status: id,
    measure: z.enum(['stacks', 'intensity', 'remaining']).optional(),
    factor: decimal,
  }),
])

/** A bounded affine formula; no executable scripts or recursive expressions. */
export const combatScalingSchema = z
  .object({
    terms: z.array(combatScalingTermSchema).min(1).max(20),
    mode: z.enum(['add', 'percent']).optional(),
    rounding: z.enum(['floor', 'ceil', 'nearest']).optional(),
    minimum: z.number().int().nonnegative().safe().optional(),
    maximum: z.number().int().nonnegative().safe().optional(),
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

export type CombatScaling = z.infer<typeof combatScalingSchema>

export function combatScalingIssues(
  scaling: CombatScaling | undefined,
  references: {
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
    } else {
      if (references.actors && !['self', 'target', ...references.actors].includes(term.actor))
        issues.push({ path: [...at, 'actor'], message: `Unknown scaling actor: ${term.actor}` })

      if (references.statuses && !Object.hasOwn(references.statuses, term.status))
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
    for (const [index, effect] of move.effects.entries())
      if ('scaling' in effect && effect.scaling)
        entries.push({ scaling: effect.scaling, path: ['effects', index, 'scaling'] })

  return entries
}
