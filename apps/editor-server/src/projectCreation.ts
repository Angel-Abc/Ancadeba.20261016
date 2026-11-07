import { EditorError, type ProjectDocuments } from '@ancadeba/editor-core'
import type { ProjectWorkspace } from './editorProjectRepository.js'
import { workspaceError } from './workspace.js'

/** Publishes the manifest last and rolls back only unchanged files in our new directory. */
export async function createWorkspaceProject(
  workspace: ProjectWorkspace,
  folder: string,
  documents: ProjectDocuments,
): Promise<void> {
  if (!workspace.createDirectory || !workspace.removeDirectory)
    throw new EditorError(503, 'unsupported_creation', 'Project creation is unavailable')

  const files = Object.entries(documents)
    .sort(([a], [b]) => Number(a === 'game.json') - Number(b === 'game.json'))
    .map(
      ([file, value]) =>
        [
          `${folder}/${file}`,
          Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`),
        ] as const,
    )

  try {
    // Exclusive reservation also protects existing empty folders and concurrent creators.
    await workspace.createDirectory(folder)
  } catch (error) {
    if (workspaceError(error).status === 409)
      throw new EditorError(
        409,
        'project_exists',
        'Choose a new folder; this destination already exists',
      )
    throw error
  }

  try {
    await workspace.createDirectory(`${folder}/scenes`)

    for (const [file, bytes] of files) await workspace.create(file, bytes)
  } catch (error) {
    try {
      const saved = await Promise.all(
        files.map(async ([file, bytes]) => {
          try {
            return Buffer.from(await workspace.read(file)).equals(bytes)
          } catch (readError) {
            if (workspaceError(readError).status === 404) return false
            throw readError
          }
        }),
      )

      // Publication can succeed before temporary-file cleanup reports an error.
      if (saved.every(Boolean)) return

      for (const [file, bytes] of [...files].reverse()) {
        try {
          await workspace.removeCreated(file, bytes)
        } catch (cleanupError) {
          if (workspaceError(cleanupError).status !== 404) throw cleanupError
        }
      }

      try {
        await workspace.removeDirectory(`${folder}/scenes`)
      } catch (cleanupError) {
        if (workspaceError(cleanupError).status !== 404) throw cleanupError
      }

      await workspace.removeDirectory(folder)
    } catch {
      throw new EditorError(
        500,
        'project_cleanup_failed',
        `Project creation may have saved files in ${folder}. Inspect that folder before retrying.`,
      )
    }

    throw error
  }
}
