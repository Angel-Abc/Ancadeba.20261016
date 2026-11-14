import { z } from 'zod'
import { createProjectRequestSchema } from './projectCreation.js'
import { projectViewSchema } from './protocol.js'

export const projectRegistryFile = '.ancadeba-projects.json'
export const projectTrashDirectory = '.ancadeba-trash'

/** Management never targets the workspace itself, hidden state, or dependency folders. */
export const managedProjectPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      path
        .split('/')
        .every(
          (part) =>
            Boolean(part) &&
            !part.startsWith('.') &&
            part.toLowerCase() !== 'node_modules' &&
            !/[<>:"\\|?*]/.test(part) &&
            !/[. ]$/.test(part) &&
            part.split('').every((character) => character.charCodeAt(0) >= 32) &&
            !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(
              part,
            ),
        ),
    'Choose a non-root project folder within the workspace',
  )

export const renameProjectFieldsSchema = z.strictObject({
  path: z.union([z.literal(''), managedProjectPathSchema]),
  expectedRevision: z.string().min(1),
  title: createProjectRequestSchema.shape.title.optional(),
  folderName: createProjectRequestSchema.shape.path.optional(),
})

export const renameProjectRequestSchema = renameProjectFieldsSchema.refine(
  ({ title, folderName }) => title !== undefined || folderName !== undefined,
  'Provide a new title or folder name',
)

export const deleteProjectRequestSchema = z.strictObject({
  path: managedProjectPathSchema,
  expectedRevision: z.string().min(1),
  confirm: z.literal(true),
})

export const deletedProjectSchema = z.object({
  trashId: z.uuid(),
  path: managedProjectPathSchema,
  title: z.string(),
  revision: z.string().min(1),
  deletedAt: z.iso.datetime(),
})

export const deletedProjectListSchema = z.object({ projects: z.array(deletedProjectSchema) })

export const restoreProjectRequestSchema = z.strictObject({
  trashId: z.uuid(),
  expectedRevision: z.string().min(1),
  destination: managedProjectPathSchema.optional(),
})

export const projectLocationSchema = projectViewSchema.extend({
  path: z.string(),
  previousPath: z.string(),
})

export type RenameProjectRequest = z.infer<typeof renameProjectRequestSchema>

export type DeleteProjectRequest = z.infer<typeof deleteProjectRequestSchema>

export type RestoreProjectRequest = z.infer<typeof restoreProjectRequestSchema>

export type DeletedProject = z.infer<typeof deletedProjectSchema>

export type ProjectLocation = z.infer<typeof projectLocationSchema>
