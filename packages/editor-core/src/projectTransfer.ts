import { z } from 'zod'
import { createProjectRequestSchema } from './projectCreation.js'
import { managedProjectPathSchema } from './projectManagement.js'
import { isPortablePathSegment, isPrivateProjectEntry } from './portablePaths.js'

export const maxProjectArchiveBytes = 128 * 1024 * 1024
export const maxProjectUnpackedBytes = 128 * 1024 * 1024
export const maxProjectArchiveEntries = 10_000

export const projectImportRequestSchema = z.strictObject({
  destination: createProjectRequestSchema.shape.path,
})

export const projectExportRequestSchema = z.strictObject({
  path: z.union([z.literal(''), managedProjectPathSchema]),
  expectedRevision: z.string().min(1),
})

/** Finder and Explorer add these to hand-made ZIPs; importers skip them as non-project files. */
export function isProjectArchiveClutter(path: string): boolean {
  const parts = path.toLowerCase().split('/')

  return parts[0] === '__macosx' || ['.ds_store', 'thumbs.db'].includes(parts.at(-1) ?? '')
}

/** Portable regular-file paths; private workspace state and local secrets never travel. */
export const projectArchivePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path
        .split('/')
        .every(
          (part) =>
            part.length <= 255 && isPortablePathSegment(part) && !isPrivateProjectEntry(part),
        ),
    'Archive contains an unsafe, private, or unsupported path',
  )

export type ProjectImportRequest = z.infer<typeof projectImportRequestSchema>

export type ProjectExportRequest = z.infer<typeof projectExportRequestSchema>
