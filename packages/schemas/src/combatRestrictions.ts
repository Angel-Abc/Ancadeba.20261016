import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'

const identifier = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const identifiers = (maximum: number) =>
  z
    .array(identifier)
    .max(maximum)
    .refine(
      (values) => new Set(values).size === values.length,
      'Combat identifier lists must be unique',
    )

export const combatMoveCategoriesSchema = identifiers(20)

export const combatRestrictionFields = {
  statusImmunities: identifiers(100).optional(),
  blockedMoveCategories: identifiers(100).optional(),
}

export function combatStatusImmunityIssues(
  owner: { statusImmunities?: readonly string[] | undefined },
  statuses: Readonly<Record<string, unknown>>,
  path: (string | number)[],
) {
  return (owner.statusImmunities ?? []).flatMap((id, index) =>
    Object.hasOwn(statuses, id)
      ? []
      : [
          {
            path: [...path, 'statusImmunities', index],
            message: `Unknown immune status: ${id}`,
          },
        ],
  )
}
