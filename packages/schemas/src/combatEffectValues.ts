import { z } from 'zod'
import { combatScalingSchema, combatScalingIssues, type CombatScaling } from './combatValues.js'

/** Only numeric effect payloads are scalable; control fields and object keys are never evaluated. */
export const combatEffectValuePathSchema = z
  .string()
  .regex(
    /^(amount|damage(?:\.(?:min|max))?|regeneration|percent|maximum|minimumHealth|stacks|intensity|duration|modifiers\.(?:attack|defense|guard|ap|apCost)|percentModifiers\.(?:attack|defense|guard|ap|apCost|damage|healing)|damageDefenses\.(?:resistances|vulnerabilities)\.[a-zA-Z0-9_-]+)$/,
  )

export const combatEffectValueScalingSchema = z
  .record(combatEffectValuePathSchema, combatScalingSchema)
  .refine(
    (entries) => Object.keys(entries).length <= 100,
    'At most 100 effect formulas are supported',
  )

export const combatEffectValueFields = { valueScaling: combatEffectValueScalingSchema.optional() }

export type CombatEffectValueScaling = z.infer<typeof combatEffectValueScalingSchema>

export function combatNumericValue(value: unknown, path: string): number | undefined {
  let current = value

  for (const key of path.split('.')) {
    if (
      !current ||
      typeof current !== 'object' ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      return
    current = Object.getOwnPropertyDescriptor(current, key)?.value
  }

  return typeof current === 'number' ? current : undefined
}

export function combatNumericPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return []

  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key

    return typeof child === 'number' && combatEffectValuePathSchema.safeParse(path).success
      ? [path]
      : [
            'damage',
            'regeneration',
            'modifiers',
            'percentModifiers',
            'damageDefenses',
            'resistances',
            'vulnerabilities',
          ].includes(key)
        ? combatNumericPaths(child, path)
        : []
  })
}

export function combatEffectScalings(value: {
  valueScaling?: CombatEffectValueScaling | undefined
}): { scaling: CombatScaling; path: (string | number)[] }[] {
  return Object.entries(value.valueScaling ?? {}).map(([key, scaling]) => ({
    scaling,
    path: ['valueScaling', key],
  }))
}

export function combatEffectValueIssues(value: {
  valueScaling?: CombatEffectValueScaling | undefined
}) {
  return Object.keys(value.valueScaling ?? {})
    .filter((path) => combatNumericValue(value, path) === undefined)
    .map((path) => ({
      path: ['valueScaling', path],
      message: 'Scaling requires a declared numeric effect value',
    }))
}

export function bindCombatEffectValues<
  T extends { valueScaling?: CombatEffectValueScaling | undefined },
>(value: T, actor: (id: string) => string): T {
  if (!value.valueScaling) return value

  return {
    ...value,
    valueScaling: Object.fromEntries(
      Object.entries(value.valueScaling).map(([key, scaling]) => [
        key,
        {
          ...scaling,
          terms: scaling.terms.map((term) =>
            'actor' in term ? { ...term, actor: actor(term.actor) } : term,
          ),
        },
      ]),
    ),
  }
}

export function combatEffectValueReferenceIssues(
  value: { valueScaling?: CombatEffectValueScaling | undefined },
  references: Parameters<typeof combatScalingIssues>[1],
  path: (string | number)[],
) {
  return [
    ...combatEffectValueIssues(value).map((issue) => ({
      ...issue,
      path: [...path, ...issue.path],
    })),
    ...combatEffectScalings(value).flatMap((entry) =>
      combatScalingIssues(entry.scaling, references, [...path, ...entry.path]),
    ),
  ]
}
