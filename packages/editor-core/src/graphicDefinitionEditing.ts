import {
  partSchema,
  partPieceSchema,
  compositionSchema,
  boundsSchema,
  pointSchema,
} from '@ancadeba/schemas'
import { object } from './project.js'
import type { EditorCommand } from './commands.js'

const fields = new Map<string, readonly string[] | null>([
  ['parts', null],
  ['compositions', null],
  ['parts.*', partSchema.keyof().options],
  ['parts.*.pieces.*', partPieceSchema.keyof().options],
  ['parts.*.pieces.*.sourceAnchor', pointSchema.keyof().options],
  ['parts.*.pieces.*.slots', null],
  ['parts.*.bounds', boundsSchema.keyof().options],
  ['parts.*.colors', null],
  ['parts.*.palettes', null],
  ['parts.*.palettes.*', null],
  ['compositions.*', compositionSchema.keyof().options],
  ['compositions.*.bounds', boundsSchema.keyof().options],
  ['compositions.*.anchors', null],
  ['compositions.*.anchors.*', pointSchema.keyof().options],
  ['compositions.*.slots', null],
  ['compositions.*.slots.*', ['parts', 'default']],
])

type DefinitionValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | DefinitionValue[]
  | Record<string, unknown>

function merge(previous: unknown, next: unknown, path: string[]): DefinitionValue {
  if (Array.isArray(next)) {
    const before = Array.isArray(previous) ? previous : []

    return next.map((value, index) =>
      merge(
        object(value).id === undefined
          ? before[index]
          : before.find((entry) => object(entry).id === object(value).id),
        value,
        [...path, '*'],
      ),
    )
  }

  if (
    next === null ||
    next === undefined ||
    typeof next === 'string' ||
    typeof next === 'number' ||
    typeof next === 'boolean'
  )
    return next

  if (typeof next !== 'object') return
  const before = object(previous)
  const known = fields.get(path.join('.'))

  return {
    ...Object.fromEntries(
      Object.entries(before).filter(([name]) => known !== null && !known?.includes(name)),
    ),
    ...Object.fromEntries(
      Object.entries(next).map(([name, value]) => [
        name,
        merge(before[name], value, [...path, known === null ? '*' : name]),
      ]),
    ),
  }
}

/** Preserve extensions by stable asset/piece IDs while removing deleted definitions and dictionary entries. */
export function mergeGraphicDefinitions(
  previous: unknown,
  command: Extract<EditorCommand, { type: 'assets.updateDefinitions' }>,
) {
  return {
    ...object(previous),
    parts: merge(object(previous).parts, command.parts, ['parts']),
    compositions: merge(object(previous).compositions, command.compositions, ['compositions']),
  }
}
