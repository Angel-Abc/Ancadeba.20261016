import { z } from 'zod'
import {
  gameIdSchema,
  sceneSchema,
  imageAssetSchema,
  partSchema,
  compositionSchema,
  graphicComponentSchema,
  assetIdSchema,
} from '@ancadeba/schemas'

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
  z.strictObject({
    type: z.literal('assets.upsertImage'),
    id: assetIdSchema,
    image: imageAssetSchema,
  }),
  z.strictObject({ type: z.literal('assets.upsertPart'), id: assetIdSchema, part: partSchema }),
  z.strictObject({
    type: z.literal('assets.upsertComposition'),
    id: assetIdSchema,
    composition: compositionSchema,
  }),
  z.strictObject({
    type: z.literal('assets.remove'),
    kind: z.enum(['images', 'parts', 'compositions']),
    id: assetIdSchema,
  }),
  z.strictObject({
    type: z.literal('scene.upsertGraphic'),
    sceneId: gameIdSchema,
    component: graphicComponentSchema,
  }),
  z.strictObject({
    type: z.literal('scene.removeGraphic'),
    sceneId: gameIdSchema,
    componentId: gameIdSchema,
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

export const assetImportMetadataSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  id: assetIdSchema,
  format: imageAssetSchema.shape.format,
})

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
    {
      type: 'assets.upsertImage',
      example: {
        type: 'assets.upsertImage',
        id: 'icon',
        image: {
          format: 'svg',
          source: 'assets/icon.svg',
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          colors: {},
          palettes: {},
        },
      },
    },
    {
      type: 'assets.upsertPart',
      example: {
        type: 'assets.upsertPart',
        id: 'shirt',
        part: {
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          pieces: [{ id: 'front', image: 'icon', layer: 'body', anchor: 'origin' }],
          colors: {},
          palettes: {},
        },
      },
    },
    {
      type: 'assets.upsertComposition',
      example: {
        type: 'assets.upsertComposition',
        id: 'portrait',
        composition: {
          bounds: { x: 0, y: 0, width: 32, height: 32 },
          layers: ['body'],
          anchors: { origin: { x: 0, y: 0 } },
          slots: { body: { parts: ['shirt'], default: 'shirt' } },
        },
      },
    },
    { type: 'assets.remove', example: { type: 'assets.remove', kind: 'images', id: 'unused' } },
    {
      type: 'scene.upsertGraphic',
      example: {
        type: 'scene.upsertGraphic',
        sceneId: 'shop',
        component: {
          id: 'portrait',
          type: 'graphic',
          placement: { row: 1, column: 1 },
          visual: 'icon',
          alt: 'Portrait',
        },
      },
    },
    {
      type: 'scene.removeGraphic',
      example: { type: 'scene.removeGraphic', sceneId: 'shop', componentId: 'portrait' },
    },
  ],
}
