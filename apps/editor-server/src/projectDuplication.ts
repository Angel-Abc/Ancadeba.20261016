import {
  EditorError,
  isPrivateProjectEntry,
  maxDuplicateProjectBytes,
  maxDuplicateProjectFiles,
} from '@ancadeba/editor-core'
import type { WorkspaceService } from './workspace.js'

/**
 * Read only this game's regular files; nested games and workspace metadata stay separate.
 * A game.json that the project itself references is a document, not a nested game.
 */
export async function readProjectCopyFiles(
  workspace: Pick<WorkspaceService, 'list' | 'read'>,
  folder: string,
  referencedFiles: ReadonlySet<string>,
): Promise<Record<string, Uint8Array>> {
  // Nested-game detection ignores case, so its exemption must as well.
  const referenced = new Set([...referencedFiles].map((file) => file.toLowerCase()))
  const files = new Map<string, Uint8Array>()
  const pending = ['']
  let bytes = 0
  let count = 0

  for (const directory of pending) {
    const path = [folder, directory].filter(Boolean).join('/')
    const { entries } = await workspace.list(path)

    if (
      directory &&
      !referenced.has(`${directory}/game.json`.toLowerCase()) &&
      entries.some((entry) => entry.type === 'file' && entry.name.toLowerCase() === 'game.json')
    )
      continue

    for (const entry of entries) {
      if (isPrivateProjectEntry(entry.name)) continue
      const file = [directory, entry.name].filter(Boolean).join('/')

      if (++count > maxDuplicateProjectFiles)
        throw new EditorError(
          413,
          'project_too_large',
          'Project duplication and export support at most 10000 files and directories',
        )

      if (entry.type === 'directory') {
        pending.push(file)
        continue
      }

      const contents = await workspace.read([folder, file].filter(Boolean).join('/'))
      bytes += contents.byteLength

      if (bytes > maxDuplicateProjectBytes)
        throw new EditorError(
          413,
          'project_too_large',
          'Project duplication and export support at most 128 MiB',
        )
      files.set(file, contents)
    }
  }

  return Object.fromEntries(files)
}
