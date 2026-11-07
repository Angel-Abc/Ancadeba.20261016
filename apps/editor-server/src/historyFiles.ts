import { EditorError } from '@ancadeba/editor-core'
import type { ProjectWorkspace } from './editorProjectRepository.js'
import { workspaceError } from './workspace.js'

export interface HistoryFile {
  file: string
  before: Uint8Array | undefined
  after: Uint8Array | undefined
}

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && Buffer.from(a).equals(b)
}

export async function readHistoryFiles(
  workspace: ProjectWorkspace,
  folder: string,
  files: readonly string[],
) {
  const result: Record<string, Uint8Array | undefined> = {}

  for (const file of new Set(files)) {
    try {
      result[file] = await workspace.read(folder ? `${folder}/${file}` : file)
    } catch (error) {
      if (workspaceError(error).status !== 404) throw error
      result[file] = undefined
    }
  }

  return result
}

/** Replays server-owned bytes, publishing referenced files before the manifest and removing files last. */
export async function restoreHistoryFiles(
  workspace: ProjectWorkspace,
  folder: string,
  files: readonly HistoryFile[],
): Promise<void> {
  const read = (file: string) =>
    readHistoryFiles(workspace, folder, [file]).then((values) => values[file])

  const path = (file: string) => (folder ? `${folder}/${file}` : file)

  const check = async (record: HistoryFile) => {
    if (!sameBytes(await read(record.file), record.before))
      throw new EditorError(
        409,
        'revision_conflict',
        'A history file changed. Reload before retrying.',
      )
  }

  for (const record of files) await check(record)

  const publish = async (records: readonly HistoryFile[]) => {
    const writes = records
      .filter(({ after }) => after !== undefined)
      .sort((a, b) => Number(a.file === 'game.json') - Number(b.file === 'game.json'))

    for (const record of [...writes, ...records.filter(({ after }) => after === undefined)]) {
      await check(record)

      if (sameBytes(record.before, record.after)) continue

      if (record.after === undefined)
        await workspace.removeCreated(path(record.file), record.before!)
      else if (record.before === undefined) await workspace.create(path(record.file), record.after)
      else await workspace.write(path(record.file), record.after)
    }
  }

  try {
    await publish(files)
  } catch (error) {
    try {
      const current = await readHistoryFiles(
        workspace,
        folder,
        files.map(({ file }) => file),
      )

      if (files.every((record) => sameBytes(current[record.file], record.after))) return

      if (
        files.some(
          (record) =>
            !sameBytes(current[record.file], record.before) &&
            !sameBytes(current[record.file], record.after),
        )
      )
        throw new Error('History files changed outside this save')
      await publish(
        files.map((record) => ({
          file: record.file,
          before: current[record.file],
          after: record.before,
        })),
      )
    } catch {
      throw new EditorError(
        500,
        'history_restore_uncertain',
        'Could not confirm undo/redo rollback. Reload and inspect the project before retrying.',
      )
    }

    throw error
  }
}
