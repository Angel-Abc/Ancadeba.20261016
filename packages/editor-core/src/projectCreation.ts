import { gameIdSchema, gameSchema, sceneSchema } from '@ancadeba/schemas'
import { z } from 'zod'
import type { ProjectDocuments } from './project.js'

/** New games live in a new, single folder beneath the configured workspace. */
export const createProjectRequestSchema = z.strictObject({
  path: gameIdSchema.max(64),
  title: z.string().trim().min(1).max(200),
  description: z.string().default(''),
})

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>

/** A playable starting point, independent of filesystem and browser services. */
export function createStarterProject(request: CreateProjectRequest): ProjectDocuments {
  const { path, title, description } = createProjectRequestSchema.parse(request)
  const screen = { type: 'grid', grid: { rows: 12, columns: 16 } }

  return {
    'game.json': gameSchema.parse({
      'schema-version': '1.0.0',
      id: path,
      title,
      description,
      version: '1.0.0',
      stylesheet: 'theme.css',
      'initial-scene': 'start',
      scenes: ['start', 'adventure'],
    }),
    'scenes/start.json': sceneSchema.parse({
      'schema-version': '1.0.0',
      id: 'start',
      title: 'Start',
      type: 'stand-alone',
      screen,
      components: [
        {
          id: 'title',
          type: 'text',
          text: title,
          placement: { row: 2, column: 2, rowSpan: 3, columnSpan: 14 },
          presentation: { variant: 'heading', align: 'center' },
        },
        {
          id: 'description',
          type: 'text',
          text: description || 'Your adventure begins here.',
          placement: { row: 5, column: 2, rowSpan: 3, columnSpan: 14 },
        },
        {
          id: 'play',
          type: 'button',
          label: 'New game',
          placement: { row: 9, column: 5, rowSpan: 2, columnSpan: 8 },
          action: { type: 'new-game', scene: 'adventure' },
        },
      ],
    }),
    'theme.css': `.ancadeba-scene {
  --ge-scene-font-size: clamp(14px, 3cqw, 22px);
  --ge-scene-heading-size: clamp(20px, 5cqw, 36px);
  --ge-scene-text-padding: 0.5em;
}

.ancadeba-button {
  --ge-scene-text-padding: 0.25em;
}
`,
    'scenes/adventure.json': sceneSchema.parse({
      'schema-version': '1.0.0',
      id: 'adventure',
      title: 'Adventure',
      type: 'game',
      screen,
      components: [
        {
          id: 'narrative',
          type: 'text',
          text: 'Edit this scene to tell your story.',
          placement: { row: 2, column: 2, rowSpan: 6, columnSpan: 14 },
        },
        {
          id: 'menu',
          type: 'button',
          label: 'Main menu',
          placement: { row: 9, column: 5, rowSpan: 2, columnSpan: 8 },
          action: { type: 'enter-scene', scene: 'start' },
        },
      ],
    }),
  }
}
