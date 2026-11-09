import { z } from 'zod'
import { gameLanguagesSchema, translationKeySchema } from './languages.js'

// IDs are also single filename segments when resolving resource references.
export const gameIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)
export const stylesheetPathSchema = z.string().regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.css$/)

const uniqueFileIds = (ids: string[]) =>
  new Set(ids.map((id) => id.toLowerCase())).size === ids.length

export const gameSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    title: z.string().trim().default(''),
    description: z.string().default(''),
    titleKey: translationKeySchema.optional(),
    descriptionKey: translationKeySchema.optional(),
    languages: gameLanguagesSchema.optional(),
    rules: z
      .array(gameIdSchema)
      .refine(uniqueFileIds, { message: 'Rule references must be unique' })
      .optional(),
    dialogues: z
      .array(gameIdSchema)
      .refine(uniqueFileIds, { message: 'Dialogue references must be unique' })
      .optional(),
    quests: z
      .array(gameIdSchema)
      .refine(uniqueFileIds, { message: 'Quest references must be unique' })
      .optional(),
    version: z.string().trim().min(1),
    'initial-scene': gameIdSchema.optional(),
    stylesheet: stylesheetPathSchema.optional(),
    assets: gameIdSchema.optional(),
    inventory: z
      .array(gameIdSchema)
      .refine(uniqueFileIds, { message: 'Inventory references must be unique' })
      .optional(),
    input: gameIdSchema.optional(),
    leveling: z
      .array(gameIdSchema)
      .refine(uniqueFileIds, { message: 'Leveling references must be unique' })
      .optional(),
    combat: z
      .array(gameIdSchema)
      .refine(uniqueFileIds, { message: 'Combat references must be unique' })
      .optional(),
    combatLibraries: z
      .array(gameIdSchema)
      .refine(uniqueFileIds, { message: 'Combat library references must be unique' })
      .optional(),
    maps: z
      .array(gameIdSchema)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Map references must be unique',
      })
      .optional(),
    scenes: z.array(gameIdSchema).refine((ids) => new Set(ids).size === ids.length, {
      message: 'Scene references must be unique',
    }),
  })
  .refine((game) => Boolean(game.title || game.titleKey), {
    path: ['title'],
    message: 'A title or titleKey is required',
  })
  .refine(
    (game) => game['initial-scene'] === undefined || game.scenes.includes(game['initial-scene']),
    {
      path: ['initial-scene'],
      message: 'Initial scene must reference a scene in the manifest',
    },
  )

export type GameDefinition = z.infer<typeof gameSchema>

export function ruleFile(id: string): string {
  return `rules/${id}.json`
}

export function inventoryFile(id: string): string {
  return `inventory/${id}.json`
}

export function mapFile(id: string): string {
  return `maps/${id}.json`
}

export function assetCatalogFile(id: string): string {
  return `assets/${id}.json`
}

export function inputFile(id: string): string {
  return `input/${id}.json`
}
