import { z } from 'zod'
import { gameIdSchema } from './game.js'

export const sceneSchema = z.object({
  'schema-version': z.literal('1.0.0'),
  id: gameIdSchema,
  title: z.string().trim().min(1),
  description: z.string(),
  type: z.literal('stand-alone'),
  screen: z.object({
    type: z.literal('grid'),
    grid: z.object({
      rows: z.number().int().positive(),
      columns: z.number().int().positive(),
    }),
  }),
  // Component definitions will be introduced with their own schemas.
  components: z.array(z.never()),
})

export type SceneDefinition = z.infer<typeof sceneSchema>
