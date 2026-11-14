import {
  applyCommand,
  commandRequestSchema,
  inspectProject,
  EditorError,
  type ProjectView,
  type CommandResult,
  type Diagnostic,
  assetImportMetadataSchema,
  createProjectRequestSchema,
  createStarterProject,
  duplicateProjectRequestSchema,
  validateProject,
  historyRequestSchema,
  type ProjectSnapshot,
  componentCopyRequestSchema,
  componentClipboardSchema,
  object,
  type ComponentClipboard,
  type ProjectRepairCheck,
} from '@ancadeba/editor-core'
import { gameIdSchema, gameSchema, assetCatalogSchema, assetCatalogFile } from '@ancadeba/schemas'
import { inspectImageSource } from '@ancadeba/game-runtime'
import { randomUUID } from 'node:crypto'
import { applyCommand as editProject } from '@ancadeba/editor-core'
import type { EditorProjectRepository } from './editorProjectRepository.js'
import { EditorCoordinator } from './editorCoordinator.js'
import { EditorHistory } from './editorHistory.js'
import { prepareProjectRepair } from './projectRepairs.js'
import { blockingAssetDiagnostics } from './assetRepairDiagnostics.js'

export class EditorProjectService {
  constructor(
    private readonly repository: EditorProjectRepository,
    readonly coordinator: EditorCoordinator,
    private readonly history = new EditorHistory(),
  ) {}

  get features() {
    return {
      history:
        typeof this.repository.restoreHistoryFiles === 'function' &&
        typeof this.repository.readHistoryFiles === 'function',
      assetImport: typeof this.repository.createAsset === 'function',
      projectCreation: typeof this.repository.create === 'function',
      projectDuplication: typeof this.repository.duplicate === 'function',
      projectRepair:
        typeof this.repository.previewRepair === 'function' &&
        typeof this.repository.readHistoryFiles === 'function' &&
        typeof this.repository.restoreHistoryFiles === 'function',
    }
  }

  create(input: unknown): Promise<ProjectView> {
    const parsed = createProjectRequestSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorError(
        400,
        'invalid_request',
        'Provide a title and a folder name using letters, digits, underscores or hyphens',
      )

    return this.coordinator.run(async () => {
      if (!this.repository.create)
        throw new EditorError(503, 'unsupported_creation', 'Project creation is unavailable')
      const documents = createStarterProject(parsed.data)
      const diagnostics = validateProject(documents)

      if (diagnostics.length)
        throw new EditorError(422, 'invalid_project', 'Invalid starter project', diagnostics)
      await this.repository.create(parsed.data.path, documents)

      try {
        return this.view(parsed.data.path, await this.repository.load(parsed.data.path))
      } catch {
        throw new EditorError(
          500,
          'project_creation_uncertain',
          `Project files were created in ${parsed.data.path}, but could not be reopened. Refresh the project list and inspect that folder before retrying.`,
        )
      }
    })
  }

  inspect(path: string): Promise<ProjectView> {
    return this.coordinator.run(async () => this.view(path, await this.repository.load(path)))
  }

  duplicate(input: unknown): Promise<ProjectView> {
    const parsed = duplicateProjectRequestSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorError(
        400,
        'invalid_request',
        'Provide the source revision, a new folder name, and a title',
      )
    const request = parsed.data

    return this.coordinator.run(async () => {
      if (!this.repository.duplicate)
        throw new EditorError(503, 'unsupported_duplication', 'Project duplication is unavailable')
      const source = await this.repository.load(request.path)

      if (source.revision !== request.expectedRevision)
        throw new EditorError(
          409,
          'revision_conflict',
          'Project changed. Reload before duplicating.',
        )
      const diagnostics = validateProject(source.documents, source.sourceDiagnostics)

      if (diagnostics.length)
        throw new EditorError(
          422,
          'invalid_project',
          'Fix project diagnostics before duplicating',
          diagnostics,
        )
      await this.repository.duplicate(request)

      try {
        return this.view(request.destination, await this.repository.load(request.destination))
      } catch {
        throw new EditorError(
          500,
          'project_duplication_uncertain',
          `Project files were copied to ${request.destination}, but could not be reopened. Refresh the project list and inspect that folder before retrying.`,
        )
      }
    })
  }

  checkRepair(input: unknown): Promise<ProjectRepairCheck> {
    return this.coordinator.run(async () => {
      const { current, candidate } = await prepareProjectRepair(this.repository, input)

      return {
        revision: current.revision,
        diagnostics: validateProject(candidate.documents, candidate.sourceDiagnostics),
      }
    })
  }

  repair(input: unknown): Promise<ProjectView> {
    return this.coordinator.run(async () => {
      const { request, current } = await prepareProjectRepair(this.repository, input)
      const before = await this.repository.readHistoryFiles!(request.path, [request.file])
      const original = before[request.file]
      const expected = current.sourceTexts?.[request.file]

      if ((original === undefined ? null : Buffer.from(original).toString('utf8')) !== expected)
        throw new EditorError(
          409,
          'revision_conflict',
          'The repair file changed. Reload before retrying.',
        )
      const after = Buffer.from(request.text)

      if (original && Buffer.from(original).equals(after)) return this.view(request.path, current)
      let saved: ProjectSnapshot

      try {
        await this.repository.restoreHistoryFiles!(request.path, [
          { file: request.file, before: original, after },
        ])
      } catch (error) {
        this.history.clear(request.path)
        throw error
      }

      try {
        saved = await this.repository.load(request.path)
      } catch {
        this.history.clear(request.path)
        throw new EditorError(
          500,
          'repair_save_uncertain',
          'Repair was saved, but could not be reopened. Reload and inspect the project before retrying.',
        )
      }

      await this.remember(
        request.path,
        current,
        saved,
        [request.file],
        before,
        `Repair ${request.file}`,
      )

      return this.view(request.path, saved)
    })
  }

  copyComponent(input: unknown): Promise<ComponentClipboard> {
    const parsed = componentCopyRequestSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorError(400, 'invalid_request', 'Invalid component copy request')
    const { path, expectedRevision, sceneId, componentId } = parsed.data

    return this.coordinator.run(async () => {
      const project = await this.repository.load(path)

      if (project.revision !== expectedRevision)
        throw new EditorError(409, 'revision_conflict', 'Project changed. Reload before copying.')
      const view = inspectProject(project)

      if (view.diagnostics.length)
        throw new EditorError(
          422,
          'invalid_project',
          'Fix project diagnostics before copying',
          view.diagnostics,
        )

      if (!view.game?.scenes.includes(sceneId))
        throw new EditorError(404, 'scene_not_found', 'Scene does not exist')
      const source = object(project.documents[`scenes/${sceneId}.json`])

      const component = (Array.isArray(source.components) ? source.components : []).find(
        (entry) => object(entry).id === componentId,
      )

      if (!component) throw new EditorError(404, 'component_not_found', 'Component does not exist')

      return componentClipboardSchema.parse({ revision: project.revision, component })
    })
  }

  restore(input: unknown): Promise<ProjectView> {
    const parsed = historyRequestSchema.safeParse(input)

    if (!parsed.success) throw new EditorError(400, 'invalid_request', 'Invalid undo/redo request')
    const { path, expectedRevision, direction } = parsed.data

    return this.coordinator.run(async () => {
      if (!this.repository.restoreHistoryFiles)
        throw new EditorError(503, 'unsupported_history', 'Undo and redo are unavailable')
      const current = await this.repository.load(path)
      this.history.status(path, current.revision)

      if (current.revision !== expectedRevision)
        throw new EditorError(409, 'revision_conflict', 'Project changed. Reload before retrying.')
      const entry = this.history.next(path, current.revision, direction)

      const files =
        direction === 'redo'
          ? entry.files
          : entry.files.map(({ file, before, after }) => ({ file, before: after, after: before }))

      try {
        await this.repository.restoreHistoryFiles(path, files)
        const saved = await this.repository.load(path)
        this.history.commit(path, direction, saved.revision)

        return this.view(path, saved)
      } catch (error) {
        // A failed replay may be uncertain; reinspection is required before another history operation.
        this.history.clear(path)

        if (error instanceof EditorError) throw error

        throw new EditorError(
          500,
          'history_restore_failed',
          'Undo/redo could not be saved. History was cleared; reload and inspect before retrying.',
        )
      }
    })
  }

  private view(path: string, project: ProjectSnapshot): ProjectView {
    return { ...inspectProject(project), history: this.history.status(path, project.revision) }
  }

  private capture(path: string, files: readonly string[]) {
    return this.repository.restoreHistoryFiles
      ? this.repository.readHistoryFiles?.(path, files)
      : undefined
  }

  private async remember(
    path: string,
    previous: ProjectSnapshot,
    saved: ProjectSnapshot,
    files: readonly string[],
    before: Record<string, Uint8Array | undefined> | undefined,
    label: string,
  ): Promise<void> {
    if (!before) return

    try {
      const after = await this.capture(path, files)

      if (after) this.history.record(path, previous.revision, saved.revision, label, before, after)
    } catch {
      this.history.clear(path)
      throw new EditorError(
        500,
        'history_capture_failed',
        'Change was saved, but history could not be recorded. Reload and inspect before retrying.',
      )
    }
  }

  scene(path: string, id: string) {
    if (!gameIdSchema.safeParse(id).success)
      throw new EditorError(400, 'invalid_scene_id', 'Invalid scene ID')

    return this.coordinator.run(async () => {
      const view = inspectProject(await this.repository.load(path))
      const scene = view.scenes.find((scene) => scene.id === id)

      if (!scene)
        throw new EditorError(
          404,
          'scene_not_found',
          'Scene does not exist or is invalid',
          view.diagnostics,
        )

      return { revision: view.revision, scene, diagnostics: view.diagnostics }
    })
  }

  apply(input: unknown): Promise<CommandResult & { view: ProjectView }> {
    const parsed = commandRequestSchema.safeParse(input)

    if (!parsed.success) {
      const diagnostics: Diagnostic[] = parsed.error.issues.map((issue) => ({
        code: 'invalid_request',
        file: '',
        path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
        message: issue.message,
      }))

      throw new EditorError(400, 'invalid_request', 'Invalid editing request', diagnostics)
    }

    const request = parsed.data

    return this.coordinator.run(async () => {
      const current = await this.repository.load(request.path)

      if (current.revision !== request.expectedRevision) {
        throw new EditorError(409, 'revision_conflict', 'Project changed. Reload before retrying.')
      }

      const change = applyCommand(current, request.command)

      const assetDiagnostics = blockingAssetDiagnostics(
        current,
        request.command,
        (await this.repository.validateAssets?.(request.path, change.project)) ?? [],
      )

      if (assetDiagnostics.length)
        throw new EditorError(422, 'invalid_project', 'Invalid asset source', assetDiagnostics)
      const before = await this.capture(request.path, change.changedFiles)
      let saved: ProjectSnapshot

      try {
        await this.repository.save(request.path, change)
        saved = await this.repository.load(request.path)
      } catch (error) {
        this.history.clear(request.path)

        throw error
      }

      await this.remember(request.path, current, saved, change.changedFiles, before, change.summary)

      return { ...change, project: saved, view: this.view(request.path, saved) }
    })
  }

  importAsset(
    metadata: unknown,
    bytes: Uint8Array,
  ): Promise<CommandResult & { view: ProjectView }> {
    const parsed = assetImportMetadataSchema.safeParse(metadata)

    if (!parsed.success)
      throw new EditorError(400, 'invalid_request', 'Invalid asset import metadata')
    const request = parsed.data

    return this.coordinator.run(async () => {
      const current = await this.repository.load(request.path)

      if (current.revision !== request.expectedRevision)
        throw new EditorError(409, 'revision_conflict', 'Project changed. Reload before retrying.')

      if (!this.repository.createAsset)
        throw new EditorError(503, 'unsupported_import', 'Asset import is unavailable')
      let info: ReturnType<typeof inspectImageSource>

      try {
        info = inspectImageSource(
          request.format,
          bytes,
          request.format === 'svg' ? Buffer.from(bytes).toString('utf8') : '',
        )
      } catch (error) {
        throw new EditorError(
          422,
          'invalid_asset',
          error instanceof Error ? error.message : String(error),
        )
      }

      const game = gameSchema.parse(current.documents['game.json'])

      const catalog = game.assets
        ? assetCatalogSchema.parse(current.documents[assetCatalogFile(game.assets)])
        : undefined

      const previous = catalog?.images[request.id]
      const colors = { ...info.colors }

      for (const slot of Object.keys(colors))
        if (previous?.colors[slot]) colors[slot] = previous.colors[slot]!
      const source = `assets/images/${request.id}-${randomUUID()}.${request.format === 'jpeg' ? 'jpg' : request.format}`

      const command = {
        type: 'assets.upsertImage',
        id: request.id,
        image: {
          format: request.format,
          source,
          bounds: info.bounds,
          colors,
          palettes: previous?.palettes ?? {},
          ...(previous?.preview ? { preview: previous.preview } : {}),
        },
      } as const

      const change = editProject(current, command)

      const diagnostics = blockingAssetDiagnostics(
        current,
        command,
        (await this.repository.validateAssets?.(
          request.path,
          change.project,
          new Map([[source, bytes]]),
        )) ?? [],
      )

      if (diagnostics.length)
        throw new EditorError(422, 'invalid_project', 'Invalid asset source', diagnostics)
      const changedFiles = [source, ...change.changedFiles]
      const before = await this.capture(request.path, changedFiles)
      await this.repository.createAsset(request.path, source, bytes)

      try {
        await this.repository.save(request.path, change)
      } catch (error) {
        this.history.clear(request.path)
        throw new EditorError(
          500,
          'asset_publication_failed',
          `Import may have saved. Inspect before retrying; the new source may be unreferenced: ${source}. ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const saved = await this.repository.load(request.path)
      await this.remember(
        request.path,
        current,
        saved,
        changedFiles,
        before,
        `Imported image ${request.id}`,
      )

      return {
        ...change,
        changedFiles,
        project: saved,
        view: this.view(request.path, saved),
      }
    })
  }
}
