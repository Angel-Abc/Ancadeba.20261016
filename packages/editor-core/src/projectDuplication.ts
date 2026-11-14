import { z } from 'zod'
import { gameSchema } from '@ancadeba/schemas'
import { createProjectRequestSchema } from './projectCreation.js'
import { object } from './project.js'

export const maxDuplicateProjectBytes = 128 * 1024 * 1024
export const maxDuplicateProjectFiles = 10_000

export const duplicateProjectRequestSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  destination: createProjectRequestSchema.shape.path,
  title: createProjectRequestSchema.shape.title,
})

export type DuplicateProjectRequest = z.infer<typeof duplicateProjectRequestSchema>

/** A copy has its own identity and title; other authored metadata remains intact. */
export function duplicateProjectManifest(
  source: unknown,
  request: Pick<DuplicateProjectRequest, 'destination' | 'title'>,
) {
  const original = gameSchema.parse(source)

  return {
    ...Object.fromEntries(Object.entries(object(source)).filter(([key]) => key !== 'titleKey')),
    id: request.destination === original.id ? `${request.destination}-copy` : request.destination,
    title: request.title,
  }
}
