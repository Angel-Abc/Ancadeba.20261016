import { z } from 'zod'
import { gameLanguagesSchema, translationKeySchema } from './languages.js'

// IDs are also single filename segments when resolving scene references.
export const gameIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)

export const gameSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    title: z.string().trim().default(''),
    description: z.string().default(''),
    titleKey: translationKeySchema.optional(),
    descriptionKey: translationKeySchema.optional(),
    languages: gameLanguagesSchema.optional(),
    version: z.string().trim().min(1),
    'initial-scene': gameIdSchema.optional(),
    // Older projects sometimes carried an ignored asset list as extension metadata.
    assets: z.union([z.string().regex(/^[a-zA-Z0-9_-]+\.json$/), z.array(z.string())]).optional(),
    inventory: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+\.json$/)
      .optional(),
    input: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+\.json$/)
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
