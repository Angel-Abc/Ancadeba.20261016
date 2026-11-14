import { z } from 'zod'
import { createProjectRequestSchema } from './projectCreation.js'
import { managedProjectPathSchema } from './projectManagement.js'

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

const excludedNames = new Set([
  '.git',
  '.hg',
  '.svn',
  '.codex',
  '.agents',
  'node_modules',
  '.ds_store',
  'thumbs.db',
])

/** Portable regular-file paths; private workspace state and local secrets never travel. */
export const projectArchivePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path.split('/').every((part) => {
        const name = part.toLowerCase()

        return (
          part.length > 0 &&
          part.length <= 255 &&
          part !== '.' &&
          part !== '..' &&
          !/[<>:"\\|?*]/.test(part) &&
          !/[. ]$/.test(part) &&
          part.split('').every((character) => character.charCodeAt(0) >= 32) &&
          !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(
            part,
          ) &&
          !excludedNames.has(name) &&
          name !== '.env' &&
          !name.startsWith('.env.') &&
          !name.startsWith('.ancadeba-') &&
          !name.startsWith('.game-export-')
        )
      }),
    'Archive contains an unsafe, private, or unsupported path',
  )

export type ProjectImportRequest = z.infer<typeof projectImportRequestSchema>

export type ProjectExportRequest = z.infer<typeof projectExportRequestSchema>
