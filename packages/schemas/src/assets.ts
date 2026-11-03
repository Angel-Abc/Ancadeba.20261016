import { z } from 'zod'
import { gameIdSchema as baseIdSchema } from './game.js'
import { gameBindingSchema } from './bindings.js'

export const assetIdSchema = baseIdSchema.refine(
  (id) => !['__proto__', 'constructor', 'prototype'].includes(id),
  'Reserved asset identifier',
)

const gameIdSchema = assetIdSchema

export const assetPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !/[\\:]/.test(path) &&
      !path.split('').some((character) => character.charCodeAt(0) < 32) &&
      path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..'),
    'Use a game-relative path with no parent directories',
  )

export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .toLowerCase()

export const colorsSchema = z.record(gameIdSchema, colorSchema)
const palettesSchema = z.record(gameIdSchema, colorsSchema)
export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() })

export const boundsSchema = pointSchema.extend({
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
})

const paletteFields = { colors: colorsSchema.default({}), palettes: palettesSchema.default({}) }

export const imageAssetSchema = z
  .object({
    format: z.enum(['svg', 'png', 'jpeg', 'webp']),
    source: assetPathSchema,
    bounds: boundsSchema,
    preview: boundsSchema.optional(),
    ...paletteFields,
  })
  .superRefine((image, context) => {
    if (
      image.format !== 'svg' &&
      (Object.keys(image.colors).length || Object.keys(image.palettes).length)
    )
      context.addIssue({
        code: 'custom',
        path: ['colors'],
        message: 'Raster images cannot declare colors or palettes',
      })
  })

export const partPieceSchema = z.object({
  id: gameIdSchema,
  image: gameIdSchema,
  layer: gameIdSchema,
  anchor: gameIdSchema.default('origin'),
  sourceAnchor: pointSchema.default({ x: 0, y: 0 }),
  scale: z.number().positive().finite().default(1),
  rotation: z.number().finite().default(0),
  slots: z.record(gameIdSchema, gameIdSchema).default({}),
})

export const partSchema = z.object({
  bounds: boundsSchema,
  pieces: z.array(partPieceSchema).min(1),
  ...paletteFields,
})

export const compositionSchema = z.object({
  bounds: boundsSchema,
  layers: z.array(gameIdSchema).min(1),
  anchors: z.record(gameIdSchema, pointSchema),
  slots: z.record(
    gameIdSchema,
    z.object({ parts: z.array(gameIdSchema).min(1), default: gameIdSchema.nullable() }),
  ),
})

export const assetCatalogSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    images: z.record(gameIdSchema, imageAssetSchema).default({}),
    parts: z.record(gameIdSchema, partSchema).default({}),
    compositions: z.record(gameIdSchema, compositionSchema).default({}),
  })
  .superRefine((catalog, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message })

    const ids = new Set<string>()

    for (const kind of ['images', 'parts', 'compositions'] as const) {
      for (const id of Object.keys(catalog[kind])) {
        if (ids.has(id)) issue([kind, id], 'Visual IDs must be unique across the catalogue')
        ids.add(id)
      }
    }

    const checkPalettes = (
      kind: string,
      collection: Record<
        string,
        { colors: Record<string, string>; palettes: Record<string, Record<string, string>> }
      >,
    ) => {
      for (const [id, asset] of Object.entries(collection)) {
        for (const [palette, colors] of Object.entries(asset.palettes)) {
          for (const slot of Object.keys(colors))
            if (!Object.hasOwn(asset.colors, slot))
              issue([kind, id, 'palettes', palette, slot], 'Unknown color slot')
        }
      }
    }

    checkPalettes('images', catalog.images)
    checkPalettes('parts', catalog.parts)

    for (const [id, part] of Object.entries(catalog.parts)) {
      const pieceIds = new Set<string>()
      part.pieces.forEach((piece, index) => {
        const path = ['parts', id, 'pieces', index]

        if (pieceIds.has(piece.id)) issue([...path, 'id'], 'Piece IDs must be unique within a part')
        pieceIds.add(piece.id)
        const image = catalog.images[piece.image]

        if (!image) issue([...path, 'image'], 'Missing image')

        for (const [imageSlot, partSlot] of Object.entries(piece.slots)) {
          if (!image || !Object.hasOwn(image.colors, imageSlot))
            issue([...path, 'slots', imageSlot], 'Unknown image color slot')

          if (!Object.hasOwn(part.colors, partSlot))
            issue([...path, 'slots', imageSlot], 'Unknown part color slot')
        }
      })
    }

    for (const [id, composition] of Object.entries(catalog.compositions)) {
      if (new Set(composition.layers).size !== composition.layers.length)
        issue(['compositions', id, 'layers'], 'Layers must be unique')

      for (const [slot, selection] of Object.entries(composition.slots)) {
        const path = ['compositions', id, 'slots', slot]

        if (new Set(selection.parts).size !== selection.parts.length)
          issue([...path, 'parts'], 'Part choices must be unique')

        if (selection.default !== null && !selection.parts.includes(selection.default))
          issue([...path, 'default'], 'Default must be an allowed part')

        for (const partId of selection.parts) {
          const part = catalog.parts[partId]

          if (!part) issue([...path, 'parts'], `Missing part ${partId}`)

          for (const piece of part?.pieces ?? []) {
            if (!composition.layers.includes(piece.layer))
              issue(path, `Unknown layer ${piece.layer} in part ${partId}`)

            if (!Object.hasOwn(composition.anchors, piece.anchor))
              issue(path, `Unknown anchor ${piece.anchor} in part ${partId}`)
          }
        }
      }
    }
  })

const visualBindingSchema = gameBindingSchema.omit({ fallback: true })

const appearanceBindingsSchema = z.object({
  palette: visualBindingSchema.optional(),
  visible: visualBindingSchema.optional(),
  colors: z.record(gameIdSchema, visualBindingSchema).default({}),
})

const appearanceFields = {
  palette: gameIdSchema.optional(),
  colors: colorsSchema.default({}),
  visible: z.boolean().default(true),
  bindings: appearanceBindingsSchema.optional(),
}

export const slotAppearanceSchema = z.object({
  ...appearanceFields,
  part: gameIdSchema.nullable().optional(),
  partBinding: visualBindingSchema.optional(),
})

export const graphicAppearanceSchema = z.object({
  ...appearanceFields,
  slots: z.record(gameIdSchema, slotAppearanceSchema).default({}),
})

export type AssetCatalog = z.infer<typeof assetCatalogSchema>

export type ImageAsset = z.infer<typeof imageAssetSchema>

export type GraphicPart = z.infer<typeof partSchema>

export type GraphicComposition = z.infer<typeof compositionSchema>

export type GraphicAppearance = z.infer<typeof graphicAppearanceSchema>

export type SlotAppearance = z.infer<typeof slotAppearanceSchema>

export type GraphicBounds = z.infer<typeof boundsSchema>

export function graphicHasBindings(appearance: GraphicAppearance): boolean {
  const has = (value: SlotAppearance) =>
    Boolean(
      value.partBinding ||
      value.bindings?.palette ||
      value.bindings?.visible ||
      Object.keys(value.bindings?.colors ?? {}).length,
    )

  return has(appearance) || Object.values(appearance.slots).some(has)
}

/** Validate a visual selection against its catalogue without browser or runtime dependencies. */
export function assertGraphicReference(
  catalog: AssetCatalog,
  visual: string,
  appearance: GraphicAppearance,
): void {
  const image = catalog.images[visual]
  const part = catalog.parts[visual]
  const composition = catalog.compositions[visual]

  if (!image && !part && !composition) throw new Error(`Unknown visual: ${visual}`)

  const check = (
    asset: ImageAsset | GraphicPart,
    selection: Pick<SlotAppearance, 'colors' | 'palette' | 'bindings'>,
  ) => {
    if (selection.palette && !Object.hasOwn(asset.palettes, selection.palette))
      throw new Error(`Unknown palette: ${selection.palette}`)

    for (const slot of new Set([
      ...Object.keys(selection.colors),
      ...Object.keys(selection.bindings?.colors ?? {}),
    ]))
      if (!Object.hasOwn(asset.colors, slot)) throw new Error(`Unknown color slot: ${slot}`)
  }

  if (image || part) {
    check(image ?? part!, appearance)

    if (Object.keys(appearance.slots).length)
      throw new Error('Only compositions have selectable slots')
  } else if (
    appearance.palette ||
    Object.keys(appearance.colors).length ||
    appearance.bindings?.palette ||
    Object.keys(appearance.bindings?.colors ?? {}).length
  )
    throw new Error('Composition colors belong to its slots')

  for (const [slot, selection] of Object.entries(appearance.slots)) {
    const definition = composition?.slots[slot]

    if (!definition) throw new Error(`Unknown composition slot: ${slot}`)
    const selected = selection.part === undefined ? definition.default : selection.part

    if (selected !== null && !definition.parts.includes(selected))
      throw new Error(`Part ${selected} is not allowed in slot ${slot}`)

    for (const id of selected === null || selection.partBinding ? definition.parts : [selected])
      check(catalog.parts[id]!, selection)
  }
}
