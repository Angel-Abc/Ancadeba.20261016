import { gameIdSchema, sceneComponentSchema } from '@ancadeba/schemas'
import { z } from 'zod'

/** Validate known fields while retaining the complete JSON source, including extensions. */
export const componentSourceSchema = z
  .record(z.string(), z.json())
  .superRefine((source, context) => {
    const result = sceneComponentSchema.safeParse(source)

    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  })

export const componentCopyRequestSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  sceneId: gameIdSchema,
  componentId: gameIdSchema,
})

export const componentClipboardSchema = z.object({
  revision: z.string().min(1),
  component: componentSourceSchema,
})

export type ComponentCopyRequest = z.infer<typeof componentCopyRequestSchema>

export type ComponentClipboard = z.infer<typeof componentClipboardSchema>
