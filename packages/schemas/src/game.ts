import { z } from 'zod'

// IDs are also single filename segments when resolving scene references.
export const gameIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)

export const gameSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    title: z.string().trim().min(1),
    description: z.string(),
    version: z.string().trim().min(1),
    'initial-scene': gameIdSchema.optional(),
    input: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+\.json$/)
      .optional(),
    scenes: z.array(gameIdSchema).refine((ids) => new Set(ids).size === ids.length, {
      message: 'Scene references must be unique',
    }),
  })
  .refine(
    (game) => game['initial-scene'] === undefined || game.scenes.includes(game['initial-scene']),
    {
      path: ['initial-scene'],
      message: 'Initial scene must reference a scene in the manifest',
    },
  )

export type GameDefinition = z.infer<typeof gameSchema>
