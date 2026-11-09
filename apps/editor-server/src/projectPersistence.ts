import { EditorError, type CommandResult } from '@ancadeba/editor-core'
import type { ProjectWorkspace } from './editorProjectRepository.js'
import { workspaceError } from './workspace.js'

function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && Buffer.from(a).equals(b)
}

/** Publishes references and the manifest before removing old files, with guarded rollback. */
export async function saveProjectStructureChanges(
  workspace: ProjectWorkspace,
  folder: string,
  change: CommandResult,
): Promise<void> {
  const path = (file: string) => (folder ? `${folder}/${file}` : file)

  const kind = change.changedFiles.some((file) => file.startsWith('scenes/'))
    ? 'scene'
    : change.changedFiles.some((file) => file.endsWith('.css'))
      ? 'stylesheet'
      : 'definition'

  const read = async (file: string) => {
    try {
      return await workspace.read(path(file))
    } catch (error) {
      if (workspaceError(error).status === 404) return undefined
      throw error
    }
  }

  const records = []

  for (const file of change.changedFiles) {
    const before = await read(file)

    if (change.createdFiles?.includes(file) && before !== undefined)
      throw new EditorError(409, `${kind}_exists`, `A file already exists for that ${kind} ID`)

    if (change.removedFiles?.includes(file) && before === undefined)
      throw new EditorError(404, `${kind}_not_found`, `The ${kind} file no longer exists`)
    records.push({
      file,
      before,
      after: change.removedFiles?.includes(file)
        ? undefined
        : Buffer.from(
            typeof change.project.documents[file] === 'string'
              ? change.project.documents[file]
              : `${JSON.stringify(change.project.documents[file], null, 2)}\n`,
          ),
    })
  }

  const writes = records
    .filter(({ after }) => after !== undefined)
    .sort((a, b) => Number(a.file === 'game.json') - Number(b.file === 'game.json'))

  try {
    for (const record of writes) {
      if (record.before === undefined) await workspace.create(path(record.file), record.after!)
      else await workspace.write(path(record.file), record.after!)
    }

    for (const record of records.filter(({ after }) => after === undefined))
      await workspace.removeCreated(path(record.file), record.before!)
  } catch (error) {
    try {
      const current = await Promise.all(records.map(({ file }) => read(file)))

      if (records.every((record, index) => same(current[index], record.after))) return

      if (
        records.some(
          (record, index) =>
            !same(current[index], record.before) && !same(current[index], record.after),
        )
      )
        throw new Error('Files changed outside this save')

      // Restore originals and their references before removing any newly published file.
      const originals = records
        .filter(({ before }) => before !== undefined)
        .sort((a, b) => Number(a.file === 'game.json') - Number(b.file === 'game.json'))

      for (const record of originals) {
        const observed = await read(record.file)

        if (same(observed, record.before)) continue

        if (!same(observed, record.after)) throw new Error('File changed before rollback')

        if (observed === undefined) await workspace.create(path(record.file), record.before!)
        else await workspace.write(path(record.file), record.before!)
      }

      for (const record of records.filter(({ before }) => before === undefined)) {
        if ((await read(record.file)) === undefined) continue
        await workspace.removeCreated(path(record.file), record.after!)
      }
    } catch {
      throw new EditorError(
        500,
        `${kind}_publication_failed`,
        `Could not confirm ${kind} rollback. Reload and inspect the project before retrying.`,
      )
    }

    throw error
  }
}
