import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { gameSchema, sceneSchema } from '@ancadeba/schemas'
import {
  EditorError,
  deletedProjectSchema,
  projectTrashDirectory,
  object,
  type ProjectSnapshot,
  type RenameProjectRequest,
  type DeleteProjectRequest,
  type RestoreProjectRequest,
  type DeletedProject,
} from '@ancadeba/editor-core'
import type { ProjectWorkspace } from './editorProjectRepository.js'
import type { ProjectStorage } from './projectStorage.js'
import { restoreHistoryFiles, sameBytes, type HistoryFile } from './historyFiles.js'
import { workspaceError } from './workspace.js'
import { hasRecoveryResources } from './manifestRecovery.js'

const trashRecordSchema = deletedProjectSchema.extend({
  version: z.literal(1),
  storageKey: z.string(),
})

const ignoredDirectories = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.codex',
  '.agents',
  projectTrashDirectory,
])

/** Filesystem transactions for project directories; callers hold the editor coordinator. */
export class ProjectDirectoryManagement {
  constructor(
    private readonly workspace: ProjectWorkspace,
    private readonly load: (path: string) => Promise<ProjectSnapshot>,
    private readonly storage: ProjectStorage | undefined,
  ) {}

  private async current(path: string, revision: string): Promise<ProjectSnapshot> {
    const snapshot = await this.load(path)

    if (
      snapshot.sourceTexts?.['game.json'] == null &&
      !hasRecoveryResources(await this.workspace.list(path))
    )
      throw new EditorError(
        404,
        'project_not_found',
        'Choose a project containing game.json or recoverable game resources',
      )

    if (snapshot.revision !== revision)
      throw new EditorError(409, 'revision_conflict', 'Project changed. Reload before continuing.')

    return snapshot
  }

  private async noNestedProjects(path: string, snapshot: ProjectSnapshot): Promise<void> {
    const pending = ['']

    for (const directory of pending) {
      const { entries } = await this.workspace.list(directory ? `${path}/${directory}` : path)

      if (
        directory &&
        entries.some(
          (entry) => entry.type === 'file' && entry.name.toLowerCase() === 'game.json',
        ) &&
        !Object.hasOwn(snapshot.documents, `${directory}/game.json`)
      ) {
        let isScene = false

        try {
          isScene = sceneSchema.safeParse(
            JSON.parse(
              Buffer.from(await this.workspace.read(`${path}/${directory}/game.json`)).toString(
                'utf8',
              ),
            ),
          ).success
        } catch {
          /* A damaged nested manifest remains protected. */
        }

        if (!isScene)
          throw new EditorError(
            409,
            'nested_projects',
            'This folder contains nested projects. Move or delete them separately first.',
          )
      }

      for (const entry of entries)
        if (entry.type === 'directory' && !ignoredDirectories.has(entry.name.toLowerCase()))
          pending.push(directory ? `${directory}/${entry.name}` : entry.name)
    }
  }

  private requireMoves(): void {
    if (
      !this.workspace.moveDirectory ||
      !this.workspace.createDirectory ||
      !this.workspace.removeDirectory ||
      !this.storage
    )
      throw new EditorError(
        503,
        'unsupported_project_management',
        'Project folder management is unavailable',
      )
  }

  async rename(request: RenameProjectRequest): Promise<string> {
    const source = await this.current(request.path, request.expectedRevision)

    const destination =
      request.folderName === undefined
        ? request.path
        : [...request.path.split('/').slice(0, -1), request.folderName].join('/')

    if (request.path === '' && request.folderName !== undefined)
      throw new EditorError(403, 'protected_project', 'The workspace root folder cannot be renamed')

    if (destination !== request.path) {
      this.requireMoves()
      await this.noNestedProjects(request.path, source)
    }

    let manifest: HistoryFile | undefined

    if (request.title !== undefined) {
      const text = source.sourceTexts?.['game.json']
      const parsed = gameSchema.safeParse(source.documents['game.json'])

      if (text === undefined || text === null || !parsed.success)
        throw new EditorError(422, 'invalid_project', 'Repair game.json before changing its title')
      const metadata = { ...object(source.documents['game.json']) }
      metadata.title = request.title
      delete metadata.titleKey
      manifest = {
        file: 'game.json',
        before: Buffer.from(text),
        after: Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
      }
    }

    let moved = false
    let manifestAttempted = false

    try {
      if (destination !== request.path) {
        await this.workspace.moveDirectory!(request.path, destination)
        moved = true
        const saved = await this.current(destination, request.expectedRevision)
        await this.noNestedProjects(destination, saved)
      }

      if (manifest) {
        manifestAttempted = true
        await restoreHistoryFiles(this.workspace, destination, [manifest])
      }

      if (moved)
        await this.storage!.relocate(request.path, destination, source.storageKey ?? request.path)

      return destination
    } catch (error) {
      try {
        if (manifest && manifestAttempted) {
          const current = await this.workspace.read(
            `${destination ? `${destination}/` : ''}game.json`,
          )

          if (sameBytes(current, manifest.after))
            await restoreHistoryFiles(this.workspace, destination, [
              { file: manifest.file, before: manifest.after, after: manifest.before },
            ])
          else if (!sameBytes(current, manifest.before))
            throw new Error('The manifest changed outside this rename')
        }

        if (moved) await this.workspace.moveDirectory!(destination, request.path)
      } catch {
        throw new EditorError(
          500,
          'project_rename_uncertain',
          `Could not confirm rename rollback. Inspect ${request.path || 'the workspace root'} and ${destination || 'the workspace root'} before retrying.`,
        )
      }

      throw error
    }
  }

  private async readTrash(trashId: string) {
    const folder = `${projectTrashDirectory}/${trashId}`
    const bytes = await this.workspace.read(`${folder}/record.json`)

    try {
      const record = trashRecordSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))

      if (record.trashId !== trashId) throw new Error('Wrong trash ID')

      return { folder, bytes, record }
    } catch {
      throw new EditorError(
        409,
        'invalid_trash_entry',
        'The deleted project record is damaged. Inspect the project trash before restoring.',
      )
    }
  }

  private async cleanupRecord(folder: string, bytes: Uint8Array): Promise<void> {
    await this.workspace.removeCreated(`${folder}/record.json`, bytes)
    await this.workspace.removeDirectory!(folder)
  }

  async delete(request: DeleteProjectRequest): Promise<DeletedProject> {
    this.requireMoves()
    const source = await this.current(request.path, request.expectedRevision)
    await this.noNestedProjects(request.path, source)

    const record = trashRecordSchema.parse({
      version: 1,
      trashId: randomUUID(),
      path: request.path,
      title: gameSchema.safeParse(source.documents['game.json']).data?.title || request.path,
      revision: source.revision,
      deletedAt: new Date().toISOString(),
      storageKey: source.storageKey ?? request.path,
    })

    try {
      await this.workspace.createDirectory!(projectTrashDirectory)
    } catch (error) {
      if (workspaceError(error).status !== 409) throw error
      await this.workspace.list(projectTrashDirectory)
    }

    const folder = `${projectTrashDirectory}/${record.trashId}`
    await this.workspace.createDirectory!(folder)
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
    let moved = false

    try {
      await this.workspace.create(`${folder}/record.json`, bytes)
      await this.workspace.moveDirectory!(request.path, `${folder}/project`)
      moved = true
      const saved = await this.current(`${folder}/project`, request.expectedRevision)
      await this.noNestedProjects(`${folder}/project`, saved)
      await this.storage!.release(request.path)

      return deletedProjectSchema.parse(record)
    } catch (error) {
      try {
        if (moved) await this.workspace.moveDirectory!(`${folder}/project`, request.path)

        try {
          await this.cleanupRecord(folder, bytes)
        } catch (cleanupError) {
          if (workspaceError(cleanupError).status !== 404) throw cleanupError
          await this.workspace.removeDirectory!(folder)
        }
      } catch {
        throw new EditorError(
          500,
          'project_deletion_uncertain',
          `Deletion may have moved files to ${folder}/project. Inspect that folder and ${request.path} before retrying.`,
        )
      }

      throw error
    }
  }

  async listDeleted(): Promise<DeletedProject[]> {
    this.requireMoves()
    let entries

    try {
      entries = (await this.workspace.list(projectTrashDirectory)).entries
    } catch (error) {
      if (workspaceError(error).status === 404) return []
      throw error
    }

    const result: DeletedProject[] = []

    for (const entry of entries) {
      if (entry.type !== 'directory' || !z.uuid().safeParse(entry.name).success) continue

      try {
        const { folder, record } = await this.readTrash(entry.name)
        const current = await this.load(`${folder}/project`)
        result.push(deletedProjectSchema.parse({ ...record, revision: current.revision }))
      } catch {
        /* Incomplete or damaged records remain on disk for manual recovery. */
      }
    }

    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  async restore(request: RestoreProjectRequest): Promise<{ path: string; previousPath: string }> {
    this.requireMoves()
    const { folder, bytes, record } = await this.readTrash(request.trashId)
    const trashPath = `${folder}/project`
    await this.current(trashPath, request.expectedRevision)
    const destination = request.destination ?? record.path
    let moved = false

    try {
      await this.workspace.moveDirectory!(trashPath, destination)
      moved = true
      await this.current(destination, request.expectedRevision)
      await this.storage!.restore(destination, record.storageKey)
    } catch (error) {
      if (moved) {
        try {
          await this.workspace.moveDirectory!(destination, trashPath)
        } catch {
          throw new EditorError(
            500,
            'project_restore_uncertain',
            `Could not confirm restore rollback. Inspect ${destination} and ${trashPath} before retrying.`,
          )
        }
      }

      throw error
    }

    try {
      await this.cleanupRecord(folder, bytes)
    } catch {
      /* The restored project is committed; orphan metadata is not listed as a deleted project. */
    }

    return { path: destination, previousPath: record.path }
  }
}
