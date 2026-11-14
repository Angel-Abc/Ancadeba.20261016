import { dialogueFile, questFile, levelingFile } from '@ancadeba/schemas'
import { createHash } from 'node:crypto'
import {
  gameSchema,
  sceneSchema,
  assetCatalogSchema,
  assetCatalogFile,
  inputFile,
  ruleFile,
  inventoryFile,
  combatFile,
  combatLibraryFile,
} from '@ancadeba/schemas'
import { validateImageSource } from '@ancadeba/game-runtime'
import {
  EditorError,
  type CommandResult,
  type ProjectSnapshot,
  type Diagnostic,
  type ProjectDocuments,
  type DuplicateProjectRequest,
  duplicateProjectManifest,
  validateProject,
  type RenameProjectRequest,
  type DeleteProjectRequest,
  type RestoreProjectRequest,
  type DeletedProject,
  type ProjectImportRequest,
} from '@ancadeba/editor-core'
import { WorkspaceError, workspaceError, type WorkspaceService } from './workspace.js'
import {
  createWorkspaceProject,
  createWorkspaceProjectFiles,
  requireUnusedProjectFolder,
} from './projectCreation.js'
import { readProjectCopyFiles } from './projectDuplication.js'
import { saveProjectStructureChanges } from './projectPersistence.js'
import { readHistoryFiles, restoreHistoryFiles, type HistoryFile } from './historyFiles.js'
import { projectStylesheets } from './projectStylesheets.js'
import { suggestRecoveryManifest } from './manifestRecovery.js'
import { ProjectStorage } from './projectStorage.js'
import { ProjectDirectoryManagement } from './projectDirectoryManagement.js'
import { readProjectArchive, writeProjectArchive } from './projectArchive.js'
import { ProjectArchiveWorkspace } from './projectArchiveWorkspace.js'

export interface ProjectWorkspace extends WorkspaceService {
  createDirectory?(path: string): Promise<void>
  removeDirectory?(path: string): Promise<void>
  moveDirectory?(from: string, to: string): Promise<void>
  create(path: string, contents: Uint8Array): Promise<void>
  removeCreated(path: string, contents: Uint8Array): Promise<void>
}

export interface EditorProjectRepository {
  previewRepair?(folder: string, file: string, text: string): Promise<ProjectSnapshot>
  readHistoryFiles?(
    folder: string,
    files: readonly string[],
  ): Promise<Record<string, Uint8Array | undefined>>
  restoreHistoryFiles?(folder: string, files: readonly HistoryFile[]): Promise<void>
  create?(folder: string, documents: ProjectDocuments): Promise<void>
  duplicate?(request: DuplicateProjectRequest): Promise<void>
  importProject?(request: ProjectImportRequest, archive: Uint8Array): Promise<void>
  exportProject?(folder: string, source: ProjectSnapshot): Promise<Uint8Array>
  rename?(request: RenameProjectRequest): Promise<string>
  delete?(request: DeleteProjectRequest): Promise<DeletedProject>
  listDeleted?(): Promise<DeletedProject[]>
  restoreProject?(request: RestoreProjectRequest): Promise<{ path: string; previousPath: string }>
  load(folder: string, overrides?: ReadonlyMap<string, string>): Promise<ProjectSnapshot>
  save(folder: string, change: CommandResult): Promise<void>
  validateAssets?(
    folder: string,
    project: ProjectSnapshot,
    overrides?: ReadonlyMap<string, Uint8Array>,
  ): Promise<Diagnostic[]>
  createAsset?(folder: string, file: string, bytes: Uint8Array): Promise<void>
}

export function projectPath(folder: string, file: string): string {
  return folder ? `${folder}/${file}` : file
}

export class WorkspaceProjectRepository implements EditorProjectRepository {
  private readonly storage: ProjectStorage | undefined
  private readonly directories: ProjectDirectoryManagement

  constructor(private readonly workspace: ProjectWorkspace) {
    this.storage = workspace.moveDirectory ? new ProjectStorage(workspace) : undefined
    this.directories = new ProjectDirectoryManagement(
      workspace,
      (path) => this.load(path),
      this.storage,
    )
  }

  rename(request: RenameProjectRequest): Promise<string> {
    return this.directories.rename(request)
  }
  delete(request: DeleteProjectRequest): Promise<DeletedProject> {
    return this.directories.delete(request)
  }
  listDeleted(): Promise<DeletedProject[]> {
    return this.directories.listDeleted()
  }
  restoreProject(request: RestoreProjectRequest) {
    return this.directories.restore(request)
  }

  previewRepair(folder: string, file: string, text: string): Promise<ProjectSnapshot> {
    return this.load(folder, new Map([[file, text]]))
  }

  readHistoryFiles(folder: string, files: readonly string[]) {
    return readHistoryFiles(this.workspace, folder, files)
  }

  restoreHistoryFiles(folder: string, files: readonly HistoryFile[]): Promise<void> {
    return restoreHistoryFiles(this.workspace, folder, files)
  }

  create(folder: string, documents: ProjectDocuments): Promise<void> {
    return createWorkspaceProject(
      this.workspace,
      folder,
      documents,
      () => this.storage?.registerNew(folder) ?? Promise.resolve(),
    )
  }

  async duplicate(request: DuplicateProjectRequest): Promise<void> {
    const referenced = await this.load(request.path)

    const files = await readProjectCopyFiles(
      this.workspace,
      request.path,
      new Set(Object.keys(referenced.documents)),
    )

    let source: unknown

    try {
      source = JSON.parse(Buffer.from(files['game.json'] ?? []).toString('utf8'))
    } catch {
      throw new EditorError(
        409,
        'revision_conflict',
        'The source changed. Reload before duplicating.',
      )
    }

    const text = `${JSON.stringify(duplicateProjectManifest(source, request), null, 2)}\n`
    files['game.json'] = Buffer.from(text)
    await createWorkspaceProjectFiles(this.workspace, request.destination, files, async () => {
      const source = await this.load(
        request.path,
        new Map(),
        request.path === '' ? request.destination : undefined,
      )

      if (source.revision !== request.expectedRevision)
        throw new EditorError(
          409,
          'revision_conflict',
          'The source changed. Reload before duplicating.',
        )
      const candidate = await this.load(request.destination, new Map([['game.json', text]]))
      const diagnostics = validateProject(candidate.documents, candidate.sourceDiagnostics)

      if (diagnostics.length)
        throw new EditorError(
          422,
          'invalid_project',
          'The copied files do not form a complete game',
          diagnostics,
        )
      await this.storage?.registerNew(request.destination)
    })
  }

  private async archiveSnapshot(
    files: Readonly<Record<string, Uint8Array>>,
    describeFailure: (diagnostics: readonly Diagnostic[]) => string,
  ): Promise<ProjectSnapshot> {
    const snapshot = await new WorkspaceProjectRepository(new ProjectArchiveWorkspace(files)).load(
      '',
    )

    const diagnostics = validateProject(snapshot.documents, snapshot.sourceDiagnostics)

    if (diagnostics.length)
      throw new EditorError(422, 'invalid_project', describeFailure(diagnostics), diagnostics)

    return snapshot
  }

  async importProject(request: ProjectImportRequest, archive: Uint8Array): Promise<void> {
    // An occupied folder is reported before the archive is unpacked and validated.
    await requireUnusedProjectFolder(this.workspace, request.destination)
    const files = await readProjectArchive(archive)

    const snapshot = await this.archiveSnapshot(
      files,
      () => 'The ZIP must contain a complete editable game project',
    )

    // A second game manifest belongs in a separate project, rather than inside this import.
    for (const path of Object.keys(files)) {
      if (
        path !== 'game.json' &&
        path.toLowerCase().endsWith('/game.json') &&
        !Object.hasOwn(snapshot.documents, path)
      )
        throw new EditorError(
          400,
          'nested_projects',
          'Import one project at a time; nested games are unsupported',
        )
    }

    const manifest = Buffer.from(files['game.json']!).toString('utf8')
    await createWorkspaceProjectFiles(this.workspace, request.destination, files, async () => {
      const candidate = await this.load(request.destination, new Map([['game.json', manifest]]))
      const diagnostics = validateProject(candidate.documents, candidate.sourceDiagnostics)

      if (diagnostics.length)
        throw new EditorError(
          422,
          'invalid_project',
          'Imported files changed before publication',
          diagnostics,
        )
      await this.storage?.registerNew(request.destination)
    })
  }

  async exportProject(folder: string, source: ProjectSnapshot): Promise<Uint8Array> {
    const files = await readProjectCopyFiles(
      this.workspace,
      folder,
      new Set(Object.keys(source.documents)),
    )

    // Archives are case-sensitive; a case-insensitive disk can hide mismatched references.
    const captured = await this.archiveSnapshot(files, (diagnostics) => {
      const saved = new Map(Object.keys(files).map((file) => [file.toLowerCase(), file]))

      const mismatches = new Set(
        diagnostics.flatMap(({ file }) => {
          const actual = saved.get(file.toLowerCase())

          return actual && actual !== file ? [`${file} is saved as ${actual}`] : []
        }),
      )

      return mismatches.size
        ? `Project ZIPs need file names that match their references exactly, including capitalization: ${[...mismatches].join('; ')}`
        : 'The saved files do not form a complete project that can be exported'
    })

    // The revision covers every authored file, so matching it proves these bytes are current.
    if (captured.revision !== source.revision)
      throw new EditorError(
        409,
        'revision_conflict',
        'The project changed while its ZIP was being prepared. Reload before exporting.',
      )

    return writeProjectArchive(files)
  }

  async load(
    folder: string,
    overrides: ReadonlyMap<string, string> = new Map(),
    excludedStylesheetDirectory?: string,
  ): Promise<ProjectSnapshot> {
    const documents: Record<string, unknown> = {}
    const sources: [string, string | null][] = []
    const sourceDiagnostics: Diagnostic[] = []
    const sourceTexts: Record<string, string | null> = {}
    let recoveryManifest: string | undefined

    const read = async (file: string, { json = true } = {}) => {
      let bytes: Uint8Array

      try {
        const override = overrides.get(file)
        bytes =
          override === undefined
            ? await this.workspace.read(projectPath(folder, file))
            : Buffer.from(override)
      } catch (error) {
        if (workspaceError(error).status !== 404) throw error
        sourceDiagnostics.push({
          code: 'missing_file',
          file,
          path: [],
          message: 'Referenced file does not exist',
        })
        sources.push([file, null])
        sourceTexts[file] = null

        if (json) documents[file] = null

        return
      }

      sources.push([file, Buffer.from(bytes).toString('base64')])
      sourceTexts[file] = Buffer.from(bytes).toString('utf8')

      if (!json) {
        documents[file] = Buffer.from(bytes).toString('utf8')

        return
      }

      try {
        documents[file] = JSON.parse(Buffer.from(bytes).toString('utf8'))
      } catch {
        sourceDiagnostics.push({
          code: 'invalid_json',
          file,
          path: [],
          message: 'File contains invalid JSON',
        })
        documents[file] = null
      }
    }

    await read('game.json')

    if (sourceTexts['game.json'] === null) {
      const listing = await this.workspace.list(folder)
      recoveryManifest = await suggestRecoveryManifest(this.workspace, folder, listing)
      // Suggested title/ID depend on the folder name, not the saved files being guarded.
      sources.push([
        '<recovery-manifest>',
        JSON.stringify({ ...JSON.parse(recoveryManifest), id: 'recovered-game', title: '' }),
      ])
    }

    const game = gameSchema.safeParse(documents['game.json'])

    if (game.success) {
      for (const id of game.data.scenes) await read(`scenes/${id}.json`)

      for (const id of game.data.maps ?? []) await read(`maps/${id}.json`)

      if (game.data.input) await read(inputFile(game.data.input))

      for (const id of game.data.inventory ?? []) await read(inventoryFile(id))

      for (const id of game.data.rules ?? []) await read(ruleFile(id))

      for (const id of game.data.dialogues ?? []) await read(dialogueFile(id))

      for (const id of game.data.quests ?? []) await read(questFile(id))

      for (const id of game.data.leveling ?? []) await read(levelingFile(id))

      for (const id of game.data.combat ?? []) await read(combatFile(id))

      for (const id of game.data.combatLibraries ?? []) await read(combatLibraryFile(id))

      if (game.data.stylesheet) await read(game.data.stylesheet, { json: false })

      for (const file of await projectStylesheets(
        this.workspace,
        folder,
        excludedStylesheetDirectory,
      )) {
        if (file === game.data.stylesheet) continue

        try {
          await read(file, { json: false })
        } catch (error) {
          if (![400, 403, 404, 409].includes(workspaceError(error).status)) throw error
        }
      }

      if (game.data.assets) {
        const file = assetCatalogFile(game.data.assets)

        await read(file)
        const catalog = assetCatalogSchema.safeParse(documents[file])

        if (catalog.success) {
          for (const [id, image] of Object.entries(catalog.data.images)) {
            try {
              const bytes = await this.workspace.read(projectPath(folder, image.source))
              sources.push([image.source, createHash('sha256').update(bytes).digest('hex')])
              validateImageSource(
                image,
                bytes,
                image.format === 'svg' ? Buffer.from(bytes).toString('utf8') : '',
              )
            } catch (error) {
              sources.push([image.source, null])
              sourceDiagnostics.push({
                code: 'invalid_asset_source',
                file: image.source,
                path: ['images', id],
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      }

      for (const language of game.data.languages?.available ?? []) {
        await read(`languages/${language}/messages.json`)
      }
    }

    return {
      ...(this.storage ? { storageKey: await this.storage.get(folder) } : {}),
      revision: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
      documents,
      sourceDiagnostics,
      sourceTexts,
      ...(recoveryManifest === undefined ? {} : { recoveryManifest }),
    }
  }

  async save(folder: string, change: CommandResult): Promise<void> {
    if (change.createdFiles || change.removedFiles) {
      await saveProjectStructureChanges(this.workspace, folder, change)

      return
    }

    if (
      change.changedFiles.some(
        (file) =>
          file.startsWith('combat/') ||
          file.startsWith('combat-libraries/') ||
          file.startsWith('leveling/') ||
          file.startsWith('dialogues/') ||
          file.startsWith('quests/'),
      )
    ) {
      await this.saveDefinitions(folder, change)

      return
    }

    const encode = (file: string) =>
      Buffer.from(`${JSON.stringify(change.project.documents[file], null, 2)}\n`)

    const newScene = change.changedFiles.find((file) => file !== 'game.json')

    if (change.changedFiles.length === 2 && newScene?.startsWith('scenes/')) {
      const path = projectPath(folder, newScene)
      const bytes = encode(newScene)
      const manifestPath = projectPath(folder, 'game.json')
      const manifestBytes = encode('game.json')
      const sceneId = sceneSchema.parse(change.project.documents[newScene]).id

      try {
        await this.workspace.create(path, bytes)
      } catch (error) {
        if (error instanceof WorkspaceError && error.status === 409) {
          throw new EditorError(409, 'scene_exists', 'A file already exists for that scene ID')
        }

        throw error
      }

      try {
        await this.workspace.write(manifestPath, manifestBytes)
      } catch (error) {
        try {
          // A write can fail after publication (for example during temporary-file cleanup).
          // Confirm the manifest before removing a scene that might already be referenced.
          const currentBytes = await this.workspace.read(manifestPath)

          if (Buffer.from(currentBytes).equals(manifestBytes)) return

          const manifest = gameSchema.safeParse(
            JSON.parse(Buffer.from(currentBytes).toString('utf8')),
          )

          if (!manifest.success || manifest.data.scenes.includes(sceneId)) {
            throw new Error('Cannot confirm that the manifest does not reference the scene')
          }

          await this.workspace.removeCreated(path, bytes)
        } catch {
          throw new EditorError(
            500,
            'scene_cleanup_failed',
            'Could not confirm scene rollback. Reload the project before retrying.',
          )
        }

        throw error
      }
    } else if (change.changedFiles.length === 2 && newScene) {
      const path = projectPath(folder, newScene)
      const bytes = encode(newScene)
      const manifestPath = projectPath(folder, 'game.json')
      const manifestBytes = encode('game.json')

      const createsRules = newScene.startsWith('rules/')

      await this.workspace.create(path, bytes)

      try {
        await this.workspace.write(manifestPath, manifestBytes)
      } catch (error) {
        try {
          const current = await this.workspace.read(manifestPath)

          if (Buffer.from(current).equals(manifestBytes)) return

          const manifest = gameSchema.parse(JSON.parse(Buffer.from(current).toString('utf8')))

          const references = [
            manifest.assets && assetCatalogFile(manifest.assets),
            manifest.input && inputFile(manifest.input),
            ...(manifest.rules ?? []).map(ruleFile),
          ]

          if (
            references.some(
              (file) => typeof file === 'string' && file.toLowerCase() === newScene.toLowerCase(),
            )
          )
            throw new Error('The manifest references the new file')

          await this.workspace.removeCreated(path, bytes)
        } catch {
          throw new EditorError(
            500,
            createsRules
              ? 'rules_publication_failed'
              : newScene.startsWith('input/')
                ? 'input_publication_failed'
                : 'asset_publication_failed',
            `Could not confirm rollback of ${newScene}. Reload the project before retrying.`,
          )
        }

        throw error
      }
    } else {
      const file = change.changedFiles[0]

      if (file) await this.workspace.write(projectPath(folder, file), encode(file))
    }
  }

  private async saveDefinitions(folder: string, change: CommandResult): Promise<void> {
    const records: { file: string; before: Uint8Array | undefined; after: Uint8Array }[] = []

    for (const file of change.changedFiles) {
      let before: Uint8Array | undefined

      try {
        before = await this.workspace.read(projectPath(folder, file))
      } catch (error) {
        if (workspaceError(error).status !== 404) throw error
      }

      records.push({
        file,
        before,
        after: Buffer.from(`${JSON.stringify(change.project.documents[file], null, 2)}\n`),
      })
    }

    const manifest = records.find((record) => record.file === 'game.json')

    if (manifest?.before) {
      const previous = gameSchema.parse(JSON.parse(Buffer.from(manifest.before).toString('utf8')))

      for (const record of records)
        if (
          (record.file.startsWith('combat/') ||
            record.file.startsWith('combat-libraries/') ||
            record.file.startsWith('leveling/') ||
            record.file.startsWith('dialogues/') ||
            record.file.startsWith('quests/')) &&
          record.before &&
          ![
            ...(previous.combat ?? []).map(combatFile),
            ...(previous.combatLibraries ?? []).map(combatLibraryFile),
            ...(previous.leveling ?? []).map(levelingFile),
            ...(previous.dialogues ?? []).map(dialogueFile),
            ...(previous.quests ?? []).map(questFile),
          ].includes(record.file)
        )
          throw new EditorError(
            409,
            record.file.startsWith('leveling/')
              ? 'leveling_exists'
              : record.file.startsWith('dialogues/') || record.file.startsWith('quests/')
                ? 'story_exists'
                : 'combat_exists',
            'An unreferenced definition file already exists',
          )
    }

    try {
      for (const record of records) {
        if (record.before)
          await this.workspace.write(projectPath(folder, record.file), record.after)
        else await this.workspace.create(projectPath(folder, record.file), record.after)
      }
    } catch (error) {
      const current: (Uint8Array | undefined)[] = []

      try {
        for (const record of records) {
          try {
            current.push(await this.workspace.read(projectPath(folder, record.file)))
          } catch (readError) {
            if (workspaceError(readError).status !== 404) throw readError
            current.push(undefined)
          }
        }

        if (
          records.every(
            (record, index) => current[index] && Buffer.from(current[index]!).equals(record.after),
          )
        )
          return

        if (
          records.some(
            (record, index) =>
              current[index] &&
              !Buffer.from(current[index]!).equals(record.after) &&
              !(record.before && Buffer.from(current[index]!).equals(record.before)),
          )
        )
          throw new Error('Files changed concurrently')

        for (const [index, record] of [...records.entries()].reverse()) {
          if (!current[index] || !Buffer.from(current[index]!).equals(record.after)) continue

          if (record.before)
            await this.workspace.write(projectPath(folder, record.file), record.before)
          else await this.workspace.removeCreated(projectPath(folder, record.file), record.after)
        }
      } catch {
        throw new EditorError(
          500,
          records.some((record) => record.file.startsWith('leveling/'))
            ? 'leveling_publication_failed'
            : records.some(
                  (record) =>
                    record.file.startsWith('dialogues/') || record.file.startsWith('quests/'),
                )
              ? 'story_publication_failed'
              : 'combat_publication_failed',
          'Could not confirm definition rollback. Reload the project before retrying.',
        )
      }

      throw error
    }
  }

  async validateAssets(
    folder: string,
    project: ProjectSnapshot,
    overrides: ReadonlyMap<string, Uint8Array> = new Map(),
  ): Promise<Diagnostic[]> {
    const game = gameSchema.parse(project.documents['game.json'])

    if (!game.assets) return []
    const catalog = assetCatalogSchema.parse(project.documents[assetCatalogFile(game.assets)])
    const diagnostics: Diagnostic[] = []

    for (const [id, image] of Object.entries(catalog.images)) {
      try {
        const bytes =
          overrides.get(image.source) ??
          (await this.workspace.read(projectPath(folder, image.source)))

        validateImageSource(
          image,
          bytes,
          image.format === 'svg' ? Buffer.from(bytes).toString('utf8') : '',
        )
      } catch (error) {
        diagnostics.push({
          code: 'invalid_asset_source',
          file: image.source,
          path: ['images', id],
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return diagnostics
  }

  createAsset(folder: string, file: string, bytes: Uint8Array): Promise<void> {
    return this.workspace.create(projectPath(folder, file), bytes)
  }
}
