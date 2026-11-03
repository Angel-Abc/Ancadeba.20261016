import {
  applyCommand,
  commandRequestSchema,
  inspectProject,
  EditorError,
  type ProjectView,
  type CommandResult,
  type Diagnostic,
  assetImportMetadataSchema,
} from '@ancadeba/editor-core'
import { gameIdSchema, gameSchema, assetCatalogSchema } from '@ancadeba/schemas'
import { inspectImageSource } from '@ancadeba/game-runtime'
import { randomUUID } from 'node:crypto'
import { applyCommand as editProject } from '@ancadeba/editor-core'
import type { EditorProjectRepository } from './editorProjectRepository.js'
import { EditorCoordinator } from './editorCoordinator.js'

export class EditorProjectService {
  constructor(
    private readonly repository: EditorProjectRepository,
    readonly coordinator: EditorCoordinator,
  ) {}

  inspect(path: string): Promise<ProjectView> {
    return this.coordinator.run(async () => inspectProject(await this.repository.load(path)))
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

      const assetDiagnostics =
        (await this.repository.validateAssets?.(request.path, change.project)) ?? []

      if (assetDiagnostics.length)
        throw new EditorError(422, 'invalid_project', 'Invalid asset source', assetDiagnostics)
      await this.repository.save(request.path, change)
      const saved = await this.repository.load(request.path)

      return { ...change, project: saved, view: inspectProject(saved) }
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

      const catalog =
        typeof game.assets === 'string'
          ? assetCatalogSchema.parse(current.documents[game.assets])
          : undefined

      const previous = catalog?.images[request.id]
      const colors = { ...info.colors }

      for (const slot of Object.keys(colors))
        if (previous?.colors[slot]) colors[slot] = previous.colors[slot]!
      const source = `assets/images/${request.id}-${randomUUID()}.${request.format === 'jpeg' ? 'jpg' : request.format}`

      const change = editProject(current, {
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
      })

      const diagnostics =
        (await this.repository.validateAssets?.(
          request.path,
          change.project,
          new Map([[source, bytes]]),
        )) ?? []

      if (diagnostics.length)
        throw new EditorError(422, 'invalid_project', 'Invalid asset source', diagnostics)
      await this.repository.createAsset(request.path, source, bytes)

      try {
        await this.repository.save(request.path, change)
      } catch (error) {
        throw new EditorError(
          500,
          'asset_publication_failed',
          `Import may have saved. Inspect before retrying; the new source may be unreferenced: ${source}. ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const saved = await this.repository.load(request.path)

      return {
        ...change,
        changedFiles: [source, ...change.changedFiles],
        project: saved,
        view: inspectProject(saved),
      }
    })
  }
}
