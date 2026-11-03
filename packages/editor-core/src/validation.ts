import type { z } from 'zod'
import { gameSchema, inputSchema, sceneSchema } from '@ancadeba/schemas'
import type { Diagnostic, ProjectDocuments } from './project.js'

export function validateProject(
  documents: ProjectDocuments,
  sourceDiagnostics: readonly Diagnostic[] = [],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...sourceDiagnostics]

  const check = <T>(file: string, schema: z.ZodType<T>) => {
    const result = schema.safeParse(documents[file])

    if (!result.success && !sourceDiagnostics.some((diagnostic) => diagnostic.file === file)) {
      diagnostics.push(
        ...result.error.issues.map((issue) => ({
          code: 'invalid_document',
          file,
          path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
          message: issue.message,
        })),
      )
    }

    return result
  }

  const game = check('game.json', gameSchema)

  if (!game.success) return diagnostics

  for (const id of game.data.scenes) {
    const file = `scenes/${id}.json`
    const scene = check(file, sceneSchema)

    if (scene.success && scene.data.id !== id) {
      diagnostics.push({
        code: 'scene_id_mismatch',
        file,
        path: ['id'],
        message: `Expected scene ID ${id}`,
      })
    }
  }

  if (game.data.input) check(game.data.input, inputSchema)

  return diagnostics
}
