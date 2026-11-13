import { z } from 'zod'

const presentationFields = new Set([
  'title',
  'titleKey',
  'description',
  'descriptionKey',
  'label',
  'labelKey',
  'name',
  'nameKey',
  'text',
  'textKey',
  'alt',
  'altKey',
  'emptyText',
  'emptyTextKey',
  'currency',
  'currencyKey',
  'speaker',
  'unavailableText',
  'messages',
  'messageKeys',
  'equipmentSlotKeys',
  'languages',
  'simulationScenarios',
])

/**
 * Project validated definitions onto their save-relevant content. Inspect schema fields,
 * not arbitrary JSON keys: an action, move, slot or resource ID may be named "label".
 * Arrays and dictionary order remain significant, including implicit trigger ordering.
 */
export function gameplaySaveDefinition(schema: z.core.$ZodType, value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault
  )
    return gameplaySaveDefinition(schema.unwrap(), value)

  if (schema instanceof z.ZodUnion) {
    const option = schema.options.find((option) => z.safeParse(option, value).success)

    return option ? gameplaySaveDefinition(option, value) : value
  }

  if (schema instanceof z.ZodArray && Array.isArray(value))
    return value.map((entry) => gameplaySaveDefinition(schema.element, entry))

  if (typeof value !== 'object' || Array.isArray(value)) return value

  if (schema instanceof z.ZodRecord)
    return Object.fromEntries(
      Object.entries(value).map(([id, entry]) => [
        id,
        gameplaySaveDefinition(schema.valueType, entry),
      ]),
    )

  if (!(schema instanceof z.ZodObject)) return value

  const shape = schema.shape

  return Object.fromEntries(
    Object.entries(value).flatMap(([field, entry]) => {
      const child = shape[field]

      if (!child) return [[field, entry]]

      if (presentationFields.has(field)) return []

      // Property values are presentation text; other string state/effect values are gameplay.
      if (field === 'value' && shape.valueKey && typeof entry === 'string') return []

      // Slot identities affect equipment; their displayed names and translation keys do not.
      if (
        field === 'equipmentSlots' &&
        shape.equipmentSlotKeys &&
        entry &&
        typeof entry === 'object'
      )
        return [[field, Object.keys(entry)]]

      if (field === 'initial' && shape.capacity && shape.path) return []

      return [[field, gameplaySaveDefinition(child, entry)]]
    }),
  )
}
