import { z } from 'zod'
import { gameIdSchema } from './game.js'
import { translationKeySchema } from './languages.js'
import { bindingAliasSchema, textBindingsSchema, textPlaceholders } from './bindings.js'
import { graphicAppearanceSchema, graphicHasBindings, assetIdSchema } from './assets.js'
import { mapPositionSchema, mapViewportSchema } from './map.js'
import { inventoryPreviewSchema } from './inventory.js'

export const gridPlacementSchema = z.object({
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  rowSpan: z.number().int().positive().default(1),
  columnSpan: z.number().int().positive().default(1),
})

export const textComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('text'),
    placement: gridPlacementSchema,
    text: z.string().default(''),
    textKey: translationKeySchema.optional(),
    bindings: textBindingsSchema.optional(),
    presentation: z
      .object({
        variant: z.enum(['body', 'heading']).default('body'),
        align: z.enum(['start', 'center', 'end']).default('start'),
      })
      .default({ variant: 'body', align: 'start' }),
  })
  .superRefine((component, context) => {
    if (component.bindings === undefined) return

    for (const { alias } of textPlaceholders(component.text)) {
      if (!bindingAliasSchema.safeParse(alias).success || !Object.hasOwn(component.bindings, alias))
        context.addIssue({
          code: 'custom',
          path: ['text'],
          message: `Undeclared or invalid text binding: ${alias}`,
        })
    }
  })

export const buttonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new-game'), scene: gameIdSchema }),
  z.object({ type: z.literal('enter-scene'), scene: gameIdSchema }),
])

export const buttonComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('button'),
    placement: gridPlacementSchema,
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    /** Buttons without an action are rendered disabled. */
    action: buttonActionSchema.optional(),
  })
  .refine((button) => Boolean(button.label || button.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const languageSelectComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('language-select'),
    placement: gridPlacementSchema,
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const graphicComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('graphic'),
  placement: gridPlacementSchema,
  visual: assetIdSchema,
  alt: z.string(),
  altKey: translationKeySchema.optional(),
  fit: z.enum(['contain', 'cover']).default('contain'),
  appearance: graphicAppearanceSchema.default({ colors: {}, visible: true, slots: {} }),
})

export const mapViewComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('map-view'),
    placement: gridPlacementSchema,
    map: gameIdSchema,
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    viewport: mapViewportSchema,
    playerSpawn: mapPositionSchema.optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const inventoryComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('inventory'),
    placement: gridPlacementSchema,
    label: z.string().trim().default('Inventory'),
    labelKey: translationKeySchema.optional(),
    owners: z
      .array(gameIdSchema)
      .min(1)
      .refine((owners) => new Set(owners).size === owners.length),
    previews: z.record(gameIdSchema, inventoryPreviewSchema).default({}),
  })
  .refine((component) => Boolean(component.label || component.labelKey))

export type InventoryComponentDefinition = z.infer<typeof inventoryComponentSchema>

export const sceneComponentSchema = z.discriminatedUnion('type', [
  textComponentSchema,
  buttonComponentSchema,
  languageSelectComponentSchema,
  graphicComponentSchema,
  mapViewComponentSchema,
  inventoryComponentSchema,
])

export const sceneSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    title: z.string().trim().default(''),
    description: z.string().default(''),
    titleKey: translationKeySchema.optional(),
    descriptionKey: translationKeySchema.optional(),
    type: z.enum(['stand-alone', 'game']),
    screen: z.object({
      type: z.literal('grid'),
      grid: z.object({
        rows: z.number().int().positive(),
        columns: z.number().int().positive(),
      }),
    }),
    components: z.array(sceneComponentSchema),
  })
  .superRefine((scene, context) => {
    if (!scene.title && !scene.titleKey)
      context.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'A title or titleKey is required',
      })
    const ids = new Set<string>()
    scene.components.forEach((component, index) => {
      if (scene.type === 'stand-alone' && component.type === 'inventory')
        context.addIssue({
          code: 'custom',
          path: ['components', index],
          message: 'Inventory panels require a game scene',
        })

      if (
        scene.type === 'stand-alone' &&
        component.type === 'graphic' &&
        graphicHasBindings(component.appearance)
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'appearance'],
          message: 'Game bindings require a game scene',
        })

      if (
        scene.type === 'stand-alone' &&
        component.type === 'text' &&
        Object.keys(component.bindings ?? {}).length > 0
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'bindings'],
          message: 'Game bindings require a game scene',
        })

      if (ids.has(component.id))
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'id'],
          message: 'Component IDs must be unique within a scene',
        })
      ids.add(component.id)
      const { row, column, rowSpan, columnSpan } = component.placement

      if (row > scene.screen.grid.rows || rowSpan - 1 > scene.screen.grid.rows - row)
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'placement'],
          message: 'Component exceeds the scene grid rows',
        })

      if (column > scene.screen.grid.columns || columnSpan - 1 > scene.screen.grid.columns - column)
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'placement'],
          message: 'Component exceeds the scene grid columns',
        })
    })
  })

export type SceneDefinition = z.infer<typeof sceneSchema>

export type SceneComponentDefinition = z.infer<typeof sceneComponentSchema>

export type GraphicComponentDefinition = z.infer<typeof graphicComponentSchema>

export type MapViewComponentDefinition = z.infer<typeof mapViewComponentSchema>

export type TextComponentDefinition = z.infer<typeof textComponentSchema>

export type ButtonComponentDefinition = z.infer<typeof buttonComponentSchema>

export type LanguageSelectComponentDefinition = z.infer<typeof languageSelectComponentSchema>

export type ButtonActionDefinition = z.infer<typeof buttonActionSchema>

export type GridPlacementDefinition = z.infer<typeof gridPlacementSchema>
