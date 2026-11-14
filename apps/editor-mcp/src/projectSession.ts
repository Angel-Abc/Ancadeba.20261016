import { EditorApiError, type IEditorApi } from './editorApiClient.js'
import { workspaceProjectPathSchema } from './projectPath.js'

export interface ProjectBinding {
  readonly api: IEditorApi
  readonly gamePath: string
}

/** Per-connection selection; existing requests keep their captured immutable API scope. */
export class ProjectSession {
  private active: ProjectBinding
  private switches: Promise<void> = Promise.resolve()
  private closed = false

  constructor(api: IEditorApi, gamePath: string) {
    this.active = { api, gamePath }
  }

  capture(): ProjectBinding {
    if (this.closed)
      throw new EditorApiError(
        'project_closed',
        'The active project was deleted. List projects and switch to an existing project before editing.',
      )

    return this.active
  }

  captureWorkspace(): ProjectBinding {
    return this.active
  }

  private transition<T>(
    binding: ProjectBinding,
    operation: () => Promise<T>,
    select: (result: T) => void,
  ) {
    const result = this.switches.then(async () => {
      const result = await operation()

      if (this.active === binding) select(result)

      return result
    })

    this.switches = result.then(
      () => undefined,
      () => undefined,
    )

    return result
  }

  renameProject(
    input: Parameters<NonNullable<IEditorApi['renameProject']>>[0],
    signal?: AbortSignal,
  ) {
    const binding = this.capture()

    return this.transition(
      binding,
      async () => {
        if (!binding.api.renameProject)
          throw new EditorApiError(
            'unsupported_project_management',
            'Project renaming is unavailable',
          )

        return binding.api.renameProject(input, signal)
      },
      (result) => {
        this.active = { api: binding.api.forProject(result.path), gamePath: result.path }
      },
    )
  }

  deleteProject(
    input: Parameters<NonNullable<IEditorApi['deleteProject']>>[0],
    signal?: AbortSignal,
  ) {
    const binding = this.capture()

    return this.transition(
      binding,
      async () => {
        if (!binding.api.deleteProject)
          throw new EditorApiError(
            'unsupported_project_management',
            'Project deletion is unavailable',
          )

        return binding.api.deleteProject(input, signal)
      },
      () => {
        this.closed = true
      },
    )
  }

  switchProject(path: string, signal?: AbortSignal) {
    const result = this.switches.then(async () => {
      const parsed = workspaceProjectPathSchema.safeParse(path)

      if (!parsed.success)
        throw new EditorApiError('invalid_request', 'Select a workspace-relative project folder')

      const checkCancellation = () => {
        if (signal?.aborted)
          throw new EditorApiError('cancelled', 'Project switching was cancelled')
      }

      checkCancellation()
      const previous = this.active
      const listed = await previous.api.listProjects(signal)

      if (!listed.projects.some(({ path: listedPath }) => listedPath === parsed.data))
        throw new EditorApiError(
          'project_not_found',
          'Select a project currently returned by workspace discovery',
          [],
          'not_applied',
          404,
        )
      checkCancellation()
      const api = previous.api.forProject(parsed.data)
      const view = await api.inspectGame(signal)
      checkCancellation()
      this.active = { api, gamePath: parsed.data }
      this.closed = false

      return { ...view, gamePath: parsed.data, previousGamePath: previous.gamePath }
    })

    // A rejected selection must not prevent a later deliberate switch.
    this.switches = result.then(
      () => undefined,
      () => undefined,
    )

    return result
  }
}
