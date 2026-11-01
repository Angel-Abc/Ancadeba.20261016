import { z } from 'zod'
import { gameIdSchema } from './game.js'

export const gridPlacementSchema = z.object({
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  rowSpan: z.number().int().positive().default(1),
  columnSpan: z.number().int().positive().default(1),
})

export const textComponentSchema = z.object({
  id: gameIdSchema,
  type: z.literal('text'),
  placement: gridPlacementSchema,
  text: z.string(),
  presentation: z
    .object({
      variant: z.enum(['body', 'heading']).default('body'),
      align: z.enum(['start', 'center', 'end']).default('start'),
    })
    .default({ variant: 'body', align: 'start' }),
})

export const sceneComponentSchema = textComponentSchema

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
export type GridPlacementDefinition = z.infer<typeof gridPlacementSchema>
