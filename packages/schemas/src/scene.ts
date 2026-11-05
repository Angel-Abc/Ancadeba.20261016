import { z } from 'zod'
import { gameIdSchema } from './game.js'
import { translationKeySchema } from './languages.js'
import {
  bindingAliasSchema,
  gameBindingSchema,
  textBindingsSchema,
  textPlaceholders,
} from './bindings.js'
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

export const requestActionSchema = z.object({
  type: z.literal('request-action'),
  action: gameIdSchema,
  enabledWhen: gameBindingSchema.optional(),
})

export const buttonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('new-game'), scene: gameIdSchema }),
  z.object({ type: z.literal('enter-scene'), scene: gameIdSchema }),
  requestActionSchema,
  z.object({
    type: z.literal('move-map'),
    mapView: gameIdSchema,
    direction: z.enum(['north', 'east', 'south', 'west']),
  }),
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

export const actionBarSlotSchema = z
  .object({
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    action: z.discriminatedUnion('type', [
      ...buttonActionSchema.options,
      z.object({
        type: z.literal('inventory-action'),
        inventory: gameIdSchema,
        action: gameIdSchema,
      }),
      z.object({
        type: z.literal('nearby-action'),
        nearby: gameIdSchema,
        action: gameIdSchema,
      }),
    ]),
    inputBinding: z.object({ context: gameIdSchema, input: gameIdSchema }).optional(),
  })
  .refine((slot) => Boolean(slot.label || slot.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const actionBarComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('action-bar'),
    placement: gridPlacementSchema,
    slots: z.record(z.string().regex(/^(?:[1-9]|1[0-5])$/), actionBarSlotSchema),
  })
  .superRefine((bar, context) => {
    const bindings = new Set<string>()

    for (const [id, slot] of Object.entries(bar.slots)) {
      if (!slot.inputBinding) continue
      const key = JSON.stringify([slot.inputBinding.context, slot.inputBinding.input])

      if (bindings.has(key))
        context.addIssue({
          code: 'custom',
          path: ['slots', id, 'inputBinding'],
          message: 'Input bindings must be unique within an action bar',
        })
      bindings.add(key)
    }
  })

export type ActionBarComponentDefinition = z.infer<typeof actionBarComponentSchema>

export type ActionBarSlotDefinition = z.infer<typeof actionBarSlotSchema>

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
    interactive: z.boolean().optional(),
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
    readOnly: z.boolean().optional(),
  })
  .refine((component) => Boolean(component.label || component.labelKey))

export type InventoryComponentDefinition = z.infer<typeof inventoryComponentSchema>

export const nearbyEntrySchema = z
  .object({
    kind: z.enum(['character', 'object']),
    label: z.string().trim().default(''),
    labelKey: translationKeySchema.optional(),
    description: z.string().default(''),
    descriptionKey: translationKeySchema.optional(),
    visibleWhen: gameBindingSchema.optional(),
    actions: z.record(gameIdSchema, requestActionSchema.omit({ type: true })).default({}),
  })
  .refine((entry) => Boolean(entry.label || entry.labelKey), {
    path: ['label'],
    message: 'A label or labelKey is required',
  })

export const nearbyComponentSchema = z
  .object({
    id: gameIdSchema,
    type: z.literal('nearby'),
    placement: gridPlacementSchema,
    label: z.string().trim().default('Nearby'),
    labelKey: translationKeySchema.optional(),
    descriptionTarget: gameIdSchema,
    entries: z.record(gameIdSchema, nearbyEntrySchema),
  })
  .refine((component) => Boolean(component.label || component.labelKey))

export type NearbyComponentDefinition = z.infer<typeof nearbyComponentSchema>

export type NearbyEntryDefinition = z.infer<typeof nearbyEntrySchema>

export const sceneComponentSchema = z.discriminatedUnion('type', [
  textComponentSchema,
  buttonComponentSchema,
  languageSelectComponentSchema,
  graphicComponentSchema,
  mapViewComponentSchema,
  inventoryComponentSchema,
  actionBarComponentSchema,
  nearbyComponentSchema,
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
        compactColumns: z.array(z.number().int().positive()).optional(),
      }),
    }),
    components: z.array(sceneComponentSchema),
  })
  .superRefine((scene, context) => {
    const { rows, columns, compactColumns } = scene.screen.grid

    if (compactColumns && compactColumns.length !== columns)
      context.addIssue({
        code: 'custom',
        path: ['screen', 'grid', 'compactColumns'],
        message: 'Compact column weights must match the number of grid columns',
      })

    if (!scene.title && !scene.titleKey)
      context.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'A title or titleKey is required',
      })
    const ids = new Set<string>()
    let hasActionBar = false
    const descriptionTargets = new Set<string>()
    scene.components.forEach((component, index) => {
      if (component.type === 'nearby') {
        if (scene.type !== 'game')
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Nearby panels require a game scene',
          })

        if (
          !scene.components.some(
            (entry) => entry.id === component.descriptionTarget && entry.type === 'text',
          ) ||
          descriptionTargets.has(component.descriptionTarget)
        )
          context.addIssue({
            code: 'custom',
            path: ['components', index, 'descriptionTarget'],
            message:
              'Choose a text component in this scene that is not already used by another nearby panel',
          })
        descriptionTargets.add(component.descriptionTarget)
      }

      const movementActions =
        component.type === 'action-bar'
          ? Object.entries(component.slots).map(([id, slot]) => ({
              action: slot.action,
              path: ['components', index, 'slots', id, 'action'],
            }))
          : component.type === 'button' && component.action
            ? [{ action: component.action, path: ['components', index, 'action'] }]
            : []

      for (const { action, path } of movementActions) {
        if (action.type !== 'move-map') continue
        const map = scene.components.find((entry) => entry.id === action.mapView)

        if (
          scene.type !== 'game' ||
          map?.type !== 'map-view' ||
          !map.playerSpawn ||
          map.interactive === false
        )
          context.addIssue({
            code: 'custom',
            path: [...path, 'mapView'],
            message:
              'Map movement requires an interactive map view with a player spawn in the same game scene',
          })
      }

      if (component.type === 'action-bar') {
        if (scene.type !== 'game' || hasActionBar)
          context.addIssue({
            code: 'custom',
            path: ['components', index],
            message: 'Only one action bar is allowed per game scene',
          })
        hasActionBar = true
      }

      if (
        scene.type === 'stand-alone' &&
        component.type === 'button' &&
        component.action?.type === 'request-action'
      )
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'action'],
          message: 'Action requests require a game scene',
        })

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

      if (row > rows || rowSpan - 1 > rows - row)
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'placement'],
          message: 'Component exceeds the scene grid rows',
        })

      if (column > columns || columnSpan - 1 > columns - column)
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
