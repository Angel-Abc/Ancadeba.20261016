import { z } from 'zod'
import { gameIdSchema } from './game.js'
import {
  combatDefinitionSchema,
  combatFieldsSchema,
  combatMoveSchema,
  type CombatDefinition,
  type CombatMoveDefinition,
} from './combat.js'
import { combatStatusSchema } from './combatAbilities.js'
import { assertGraphicReference, graphicAppearanceSchema, type AssetCatalog } from './assets.js'
import type { GameTranslation } from './localization.js'

const entryId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine(
    (id) => !['__proto__', 'constructor', 'prototype'].includes(id),
    'Reserved combat identifier',
  )

export const combatReferenceSchema = z.object({ library: gameIdSchema, id: entryId })

export const combatSourceSchema = combatFieldsSchema.extend({
  moves: z.record(entryId, combatMoveSchema).default({}),
  sharedMoves: z.array(combatReferenceSchema).optional(),
  sharedStatuses: z.array(combatReferenceSchema).optional(),
})

export function moveStatusIds(move: CombatMoveDefinition): string[] {
  return move.type === 'ability'
    ? [
        ...new Set(
          move.effects.flatMap((effect) =>
            effect.type === 'apply-status' || effect.type === 'remove-status'
              ? [effect.status]
              : [],
          ),
        ),
      ]
    : []
}

export const combatLibrarySchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    moves: z.record(entryId, combatMoveSchema).default({}),
    statuses: z.record(entryId, combatStatusSchema).default({}),
  })
  .superRefine((library, context) => {
    for (const [id, move] of Object.entries(library.moves))
      for (const status of moveStatusIds(move))
        if (!Object.hasOwn(library.statuses, status))
          context.addIssue({
            code: 'custom',
            path: ['moves', id, 'effects'],
            message: `Unknown library status: ${status}`,
          })
  })

export type CombatSource = z.infer<typeof combatSourceSchema>

export type CombatLibrary = z.infer<typeof combatLibrarySchema>

export type CombatReference = z.infer<typeof combatReferenceSchema>

export const combatOriginSchema = z.object({
  file: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  library: gameIdSchema.optional(),
})

export const combatOriginsSchema = z.object({
  moves: z.record(z.string(), combatOriginSchema),
  statuses: z.record(z.string(), combatOriginSchema),
})

export type CombatOrigins = z.infer<typeof combatOriginsSchema>

export interface CombatLibraryIssue {
  file: string
  path: (string | number)[]
  message: string
}

export function combatLibraryFile(id: string): string {
  return `combat-libraries/${id}.json`
}

/** Definitions contain only JSON values. Session state must never be written into them. */
export function freezeCombatDefinition(definition: CombatDefinition): CombatDefinition {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return

    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }

  freeze(definition)

  return definition
}

/** Pure source-to-runtime resolution. Authored references are never materialized back into source. */
export function resolveCombatSource(
  source: CombatSource,
  libraries: ReadonlyMap<string, CombatLibrary>,
  file = `combat/${source.id}.json`,
) {
  const moves = { ...source.moves }
  const statuses = { ...source.statuses }
  const origins: CombatOrigins = { moves: {}, statuses: {} }
  const issues: CombatLibraryIssue[] = []

  for (const id of Object.keys(moves)) origins.moves[id] = { file, path: ['moves', id] }

  for (const id of Object.keys(statuses)) origins.statuses[id] = { file, path: ['statuses', id] }

  const addStatus = (ref: CombatReference, path: (string | number)[]) => {
    const library = libraries.get(ref.library)
    const status = library?.statuses[ref.id]

    if (!status) {
      issues.push({
        file,
        path,
        message: `Missing shared status ${ref.library}/${ref.id} (${combatLibraryFile(ref.library)})`,
      })

      return
    }

    const old = origins.statuses[ref.id]

    if (old && old.library !== ref.library) {
      issues.push({
        file,
        path,
        message: `Status ID ${ref.id} conflicts with ${old.file}; imported from ${combatLibraryFile(ref.library)}`,
      })

      return
    }

    statuses[ref.id] = status
    origins.statuses[ref.id] = {
      library: ref.library,
      file: combatLibraryFile(ref.library),
      path: ['statuses', ref.id],
    }
  }

  for (const key of ['sharedMoves', 'sharedStatuses'] as const) {
    const seen = new Set<string>()

    for (const [index, ref] of (source[key] ?? []).entries()) {
      const path = [key, index]
      const identity = `${ref.library}/${ref.id}`

      if (seen.has(identity)) {
        issues.push({ file, path, message: `Duplicate shared reference: ${identity}` })
        continue
      }

      seen.add(identity)

      if (key === 'sharedStatuses') {
        addStatus(ref, path)
        continue
      }

      const move = libraries.get(ref.library)?.moves[ref.id]

      if (!move) {
        issues.push({
          file,
          path,
          message: `Missing shared move ${identity} (${combatLibraryFile(ref.library)})`,
        })
        continue
      }

      if (Object.hasOwn(moves, ref.id)) {
        issues.push({
          file,
          path,
          message: `Move ID ${ref.id} conflicts with ${origins.moves[ref.id]?.file}; imported from ${combatLibraryFile(ref.library)}`,
        })
        continue
      }

      moves[ref.id] = move
      origins.moves[ref.id] = {
        library: ref.library,
        file: combatLibraryFile(ref.library),
        path: ['moves', ref.id],
      }

      for (const id of moveStatusIds(move)) addStatus({ library: ref.library, id }, path)
    }
  }

  const resolved = combatDefinitionSchema.safeParse({ ...source, moves, statuses })

  if (!resolved.success)
    for (const issue of resolved.error.issues)
      issues.push({
        file,
        path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
        message: issue.message,
      })

  return {
    definition:
      !issues.length && resolved.success ? freezeCombatDefinition(resolved.data) : undefined,
    origins,
    issues,
  }
}

/** Validate every library entry, including definitions not yet imported by any encounter. */
export function combatLibraryIssues(
  library: CombatLibrary,
  assets?: AssetCatalog,
  translation?: GameTranslation,
): CombatLibraryIssue[] {
  const issues: CombatLibraryIssue[] = []
  const file = combatLibraryFile(library.id)

  for (const kind of ['moves', 'statuses'] as const)
    for (const [id, entry] of Object.entries(library[kind])) {
      for (const key of ['labelKey', 'descriptionKey'] as const)
        if (entry[key] && (!translation || !Object.hasOwn(translation.fallback, entry[key])))
          issues.push({
            file,
            path: [kind, id, key],
            message: `Missing combat translation: ${entry[key]}`,
          })

      if ('icon' in entry && entry.icon)
        try {
          if (!assets) throw new Error('Status icons require an asset catalogue')
          assertGraphicReference(assets, entry.icon, graphicAppearanceSchema.parse({}))
        } catch (error) {
          issues.push({
            file,
            path: [kind, id, 'icon'],
            message: error instanceof Error ? error.message : String(error),
          })
        }
    }

  return issues
}
