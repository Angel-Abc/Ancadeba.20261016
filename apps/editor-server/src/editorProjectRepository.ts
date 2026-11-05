import { createHash } from 'node:crypto'
import {
  gameSchema,
  sceneSchema,
  assetCatalogSchema,
  assetCatalogFile,
  inputFile,
  ruleFile,
  inventoryFile,
} from '@ancadeba/schemas'
import { validateImageSource } from '@ancadeba/game-runtime'
import {
  EditorError,
  type CommandResult,
  type ProjectSnapshot,
  type Diagnostic,
} from '@ancadeba/editor-core'
import { WorkspaceError, workspaceError, type WorkspaceService } from './workspace.js'

export interface ProjectWorkspace extends WorkspaceService {
  create(path: string, contents: Uint8Array): Promise<void>
  removeCreated(path: string, contents: Uint8Array): Promise<void>
}

export interface EditorProjectRepository {
  load(folder: string): Promise<ProjectSnapshot>
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
  constructor(private readonly workspace: ProjectWorkspace) {}

  async load(folder: string): Promise<ProjectSnapshot> {
    const documents: Record<string, unknown> = {}
    const sources: [string, string | null][] = []
    const sourceDiagnostics: Diagnostic[] = []

    const read = async (file: string, { required = false, json = true } = {}) => {
      let bytes: Uint8Array

      try {
        bytes = await this.workspace.read(projectPath(folder, file))
      } catch (error) {
        if (workspaceError(error).status !== 404 || required) throw error
        sourceDiagnostics.push({
          code: 'missing_file',
          file,
          path: [],
          message: 'Referenced file does not exist',
        })
        sources.push([file, null])

        if (json) documents[file] = null

        return
      }

      sources.push([file, Buffer.from(bytes).toString('base64')])

      if (!json) return

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

    await read('game.json', { required: true })
    const game = gameSchema.safeParse(documents['game.json'])

    if (game.success) {
      for (const id of game.data.scenes) await read(`scenes/${id}.json`)

      for (const id of game.data.maps ?? []) await read(`maps/${id}.json`)

      if (game.data.input) await read(inputFile(game.data.input))

      for (const id of game.data.inventory ?? []) await read(inventoryFile(id))

      for (const id of game.data.rules ?? []) await read(ruleFile(id))

      if (game.data.stylesheet) await read(game.data.stylesheet, { json: false })

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
      revision: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
      documents,
      sourceDiagnostics,
    }
  }

  async save(folder: string, change: CommandResult): Promise<void> {
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
