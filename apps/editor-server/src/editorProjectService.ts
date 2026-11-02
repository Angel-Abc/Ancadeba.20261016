import {
  applyCommand,
  commandRequestSchema,
  inspectProject,
  EditorError,
  type ProjectView,
  type CommandResult,
  type Diagnostic,
} from '@ancadeba/editor-core'
import { gameIdSchema } from '@ancadeba/schemas'
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
      await this.repository.save(request.path, change)
      const saved = await this.repository.load(request.path)
      return { ...change, project: saved, view: inspectProject(saved) }
    })
  }
}
