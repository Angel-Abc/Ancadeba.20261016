import { z } from 'zod'

interface DraftParticipant {
  name: string
  capture(): unknown
  restore(value: unknown): void
}

export interface EditorDraftValues {
  [name: string]: unknown
}

// DOM ownership keeps registrations isolated between editor instances and releases removed forms.
const participants = new WeakMap<HTMLElement, DraftParticipant>()

const fieldSchema = z.object({
  index: z.number().int().nonnegative(),
  tag: z.string(),
  type: z.string(),
  value: z.string(),
  checked: z.boolean(),
})

const snapshotSchema = z.object({ model: z.unknown(), fields: z.array(fieldSchema) })

function draftFields(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll?.<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input:not([type="file"]), select, textarea',
    ) ?? [],
  ).filter(
    (field) =>
      ['input', 'select', 'textarea'].includes(field.tagName?.toLowerCase()) &&
      field.type !== 'file' &&
      (!field.closest || field.closest('[data-editor-draft]') === root),
  )
}

function restoreFields(root: HTMLElement, values: z.infer<typeof fieldSchema>[]) {
  for (const saved of values) {
    const field = draftFields(root)[saved.index]

    if (!field || field.tagName !== saved.tag || field.type !== saved.type) continue
    const checkChanged = 'checked' in field && field.checked !== saved.checked

    if (field.value === saved.value && !checkChanged) continue
    field.value = saved.value

    if ('checked' in field) field.checked = saved.checked
    field.dispatchEvent(
      new Event(field.tagName.toLowerCase() === 'select' ? 'change' : 'input', { bubbles: true }),
    )
  }
}

/** Drafts may have unfinished values, but must retain their model's structure and discriminants. */
function structuralSchema(schema: z.core.$ZodType): z.core.$ZodType {
  if (schema instanceof z.ZodObject)
    return z.object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [key, structuralSchema(field)]),
      ),
    )

  if (schema instanceof z.ZodArray) return z.array(structuralSchema(schema.element))

  if (schema instanceof z.ZodRecord) {
    const key = schema.keyType instanceof z.ZodString ? z.string() : schema.keyType
    const value = structuralSchema(schema.valueType)

    return schema.def.partial ? z.partialRecord(key, value) : z.record(key, value)
  }

  if (schema instanceof z.ZodOptional) return z.optional(structuralSchema(schema.unwrap()))

  if (schema instanceof z.ZodNullable) return z.nullable(structuralSchema(schema.unwrap()))

  if (schema instanceof z.ZodDefault) return structuralSchema(schema.unwrap())

  if (schema instanceof z.ZodPrefault) return structuralSchema(schema.unwrap())

  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion)
    return z.union(schema.options.map((option) => structuralSchema(option)))

  if (schema instanceof z.ZodString) return z.string()

  if (schema instanceof z.ZodNumber) return z.union([z.number(), z.nan()])

  return schema
}

export function registerEditorDraft<T extends z.ZodType>(
  root: HTMLElement,
  name: string,
  schema: T,
  capture: () => z.output<T> | undefined,
  restore: (value: z.output<T>) => void,
): void {
  // SAFETY: structuralSchema preserves output types, optionality and discriminants, relaxing only value checks.
  const structure = structuralSchema(schema) as z.ZodType<z.output<T>>
  root.setAttribute('data-editor-draft', name)
  participants.set(root, {
    name,
    capture: () => {
      const model = capture()

      return model === undefined
        ? undefined
        : {
            model,
            fields: draftFields(root).map((field, index) => ({
              index,
              tag: field.tagName,
              type: field.type,
              value: field.value,
              checked: 'checked' in field && field.checked,
            })),
          }
    },
    restore: (value) => {
      const saved = snapshotSchema.parse(value)
      restore(structure.parse(saved.model))
      // Pending identifiers and partially typed numeric text can live outside the main model.
      restoreFields(root, saved.fields)
    },
  })
}

/** Small legacy forms own their draft in event closures; replay only field edits, never actions. */
export function registerFormDraft(root: HTMLElement, name: string, dirty: () => boolean): void {
  const controls = () =>
    Array.from(
      root.querySelectorAll?.<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input:not([type="file"]), select, textarea',
      ) ?? [],
    )

  registerEditorDraft(
    root,
    name,
    z.array(z.object({ value: z.string(), checked: z.boolean() })),
    () =>
      dirty()
        ? controls().map((control) => ({
            value: control.value,
            checked: 'checked' in control && control.checked,
          }))
        : undefined,
    (saved) => {
      for (const [index, value] of saved.entries()) {
        const control = controls()[index]

        if (!control) continue
        control.value = value.value

        if ('checked' in control) control.checked = value.checked
        control.dispatchEvent(
          new Event(control.tagName.toLowerCase() === 'select' ? 'change' : 'input', {
            bubbles: true,
          }),
        )
      }
    },
  )
}

function ownedRoots(root: HTMLElement): HTMLElement[] {
  return [root, ...Array.from(root.querySelectorAll?.<HTMLElement>('[data-editor-draft]') ?? [])]
}

export function captureEditorDrafts(root: HTMLElement): EditorDraftValues {
  const values: EditorDraftValues = {}

  for (const element of ownedRoots(root)) {
    const participant = participants.get(element)
    const value = participant?.capture()

    if (participant && value !== undefined) values[participant.name] = value
  }

  return values
}

/** Parents can rebuild nested forms while restoring, so discover remaining participants again. */
export function restoreEditorDrafts(root: HTMLElement, values: Record<string, unknown>): string[] {
  const pending = new Map(Object.entries(values))
  let restored = true

  while (restored && pending.size) {
    restored = false

    for (const element of ownedRoots(root)) {
      const participant = participants.get(element)

      if (!participant || !pending.has(participant.name)) continue

      try {
        participant.restore(pending.get(participant.name))
        pending.delete(participant.name)
        restored = true
        break
      } catch {
        // A damaged or obsolete participant must not prevent recovery of the other editors.
      }
    }
  }

  return [...pending.keys()]
}
