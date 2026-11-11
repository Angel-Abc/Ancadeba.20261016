import { EditorError, projectRepairRequestSchema, validateProject } from '@ancadeba/editor-core'
import { stylesheetPathSchema } from '@ancadeba/schemas'
import type { EditorProjectRepository } from './editorProjectRepository.js'

/** Restrict repair to definitions already inspected for this project, including missing references. */
export async function prepareProjectRepair(repository: EditorProjectRepository, input: unknown) {
  const parsed = projectRepairRequestSchema.safeParse(input)

  if (!parsed.success)
    throw new EditorError(400, 'invalid_request', 'Invalid project repair request')
  const request = parsed.data

  if (Buffer.byteLength(request.text, 'utf8') > 4 * 1024 * 1024)
    throw new EditorError(413, 'repair_too_large', 'Repair text exceeds the 4 MiB limit')

  if (!repository.previewRepair || !repository.readHistoryFiles || !repository.restoreHistoryFiles)
    throw new EditorError(503, 'unsupported_repair', 'Project repair is unavailable')
  const current = await repository.load(request.path)

  if (current.revision !== request.expectedRevision)
    throw new EditorError(
      409,
      'revision_conflict',
      'Project changed. Reload before checking or saving a repair.',
    )

  if (!validateProject(current.documents, current.sourceDiagnostics).length)
    throw new EditorError(409, 'repair_unavailable', 'This project has no diagnostics to repair')

  if (
    !Object.hasOwn(current.sourceTexts ?? {}, request.file) ||
    !(request.file.endsWith('.json') || stylesheetPathSchema.safeParse(request.file).success)
  )
    throw new EditorError(400, 'invalid_repair_file', 'Choose an inspected project definition')

  if (request.file.endsWith('.json')) {
    try {
      JSON.parse(request.text)
    } catch (error) {
      throw new EditorError(
        422,
        'invalid_json',
        error instanceof Error ? error.message : 'Invalid JSON',
      )
    }
  }

  const candidate = await repository.previewRepair(request.path, request.file, request.text)

  return { request, current, candidate }
}
