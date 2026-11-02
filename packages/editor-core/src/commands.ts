import { z } from 'zod'
import { gameIdSchema, sceneSchema } from '@ancadeba/schemas'

const metadata = {
  title: z.string().trim().min(1),
  description: z.string(),
}
export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('game.updateMetadata'),
    ...metadata,
    version: z.string().trim().min(1),
  }),
  z.strictObject({
    type: z.literal('scene.create'),
    scene: sceneSchema.passthrough().safeExtend({
      screen: sceneSchema.shape.screen
        .passthrough()
        .extend({ grid: sceneSchema.shape.screen.shape.grid.passthrough() }),
    }),
  }),
  z.strictObject({
    type: z.literal('scene.updateMetadata'),
    sceneId: gameIdSchema,
    ...metadata,
  }),
  z.strictObject({
    type: z.literal('scene.updateLayout'),
    sceneId: gameIdSchema,
    rows: z.number().int().positive(),
    columns: z.number().int().positive(),
  }),
])

// Paths are further checked by the server's workspace boundary.
export const commandRequestSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  command: commandSchema,
})
export type EditorCommand = z.infer<typeof commandSchema>
export type CommandRequest = z.infer<typeof commandRequestSchema>

const scene = {
  'schema-version': '1.0.0',
  id: 'shop',
  title: 'Shop',
  description: '',
  type: 'stand-alone',
  screen: { type: 'grid', grid: { rows: 12, columns: 16 } },
  components: [],
}
export const capabilities = {
  version: 1,
  requestSchema: z.toJSONSchema(commandRequestSchema),
  commands: [
    {
      type: 'game.updateMetadata',
      example: { type: 'game.updateMetadata', title: 'My game', description: '', version: '1.0.0' },
    },
    { type: 'scene.create', example: { type: 'scene.create', scene } },
    {
      type: 'scene.updateMetadata',
      example: { type: 'scene.updateMetadata', sceneId: 'shop', title: 'Shop', description: '' },
    },
    {
      type: 'scene.updateLayout',
      example: { type: 'scene.updateLayout', sceneId: 'shop', rows: 12, columns: 16 },
    },
  ],
}
