import { z } from 'zod'
import { gameIdSchema } from './game.js'
import { bindingAliasSchema, textBindingsSchema, textPlaceholders } from './bindings.js'

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
    text: z.string(),
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

export const buttonComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('button'),
  placement: gridPlacementSchema,
  label: z.string().trim().min(1),
  /** Buttons without an action are rendered disabled. */
  action: buttonActionSchema.optional(),
})

export const sceneComponentSchema = z.discriminatedUnion('type', [
  textComponentSchema,
  buttonComponentSchema,
])

export const sceneSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    title: z.string().trim().min(1),
    description: z.string(),
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
    const ids = new Set<string>()
    scene.components.forEach((component, index) => {
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
export type TextComponentDefinition = z.infer<typeof textComponentSchema>
export type ButtonComponentDefinition = z.infer<typeof buttonComponentSchema>
export type ButtonActionDefinition = z.infer<typeof buttonActionSchema>
export type GridPlacementDefinition = z.infer<typeof gridPlacementSchema>
