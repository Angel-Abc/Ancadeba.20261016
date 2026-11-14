import {
  EditorError,
  maxDuplicateProjectBytes,
  maxDuplicateProjectFiles,
} from '@ancadeba/editor-core'
import type { WorkspaceService } from './workspace.js'

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

/** Read only this game's regular files; nested games and workspace metadata stay separate. */
export async function readProjectCopyFiles(
  workspace: Pick<WorkspaceService, 'list' | 'read'>,
  folder: string,
  referencedFiles: ReadonlySet<string> = new Set(),
): Promise<Record<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  const pending = ['']
  let bytes = 0
  let count = 0

  for (const directory of pending) {
    const path = [folder, directory].filter(Boolean).join('/')
    const { entries } = await workspace.list(path)

    if (
      directory &&
      !referencedFiles.has(`${directory}/game.json`) &&
      entries.some((entry) => entry.type === 'file' && entry.name.toLowerCase() === 'game.json')
    )
      continue

    for (const entry of entries) {
      const name = entry.name.toLowerCase()

      if (
        excludedNames.has(name) ||
        name === '.env' ||
        name.startsWith('.env.') ||
        name.startsWith('.ancadeba-') ||
        name.startsWith('.game-export-')
      )
        continue
      const file = [directory, entry.name].filter(Boolean).join('/')

      if (++count > maxDuplicateProjectFiles)
        throw new EditorError(
          413,
          'project_too_large',
          'Project duplication supports at most 10000 files and directories',
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
          'Project duplication supports at most 128 MiB',
        )
      files.set(file, contents)
    }
  }

  return Object.fromEntries(files)
}
