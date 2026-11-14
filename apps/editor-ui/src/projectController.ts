import type {
  CreateProjectRequest,
  DuplicateProjectRequest,
  EditorCommand,
  ProjectView,
  ComponentClipboard,
  ProjectRepairRequest,
  ProjectRepairCheck,
  RenameProjectRequest,
  RestoreProjectRequest,
  ProjectImportRequest,
} from '@ancadeba/editor-core'
import { EditorClientError, type IEditorClient, type ProjectDownload } from './editorClient.js'

export interface ProjectEditorState {
  path: string
  view?: ProjectView
  busy: boolean
  error: string
  conflict: boolean
  changedElsewhere: boolean
  lastCommand: EditorCommand['type'] | null
  preserveDrafts: boolean
  historyChange?: 'undo' | 'redo' | undefined
  projectChange?:
    | { kind: 'renamed' | 'deleted' | 'restored' | 'imported'; previousPath: string }
    | undefined
}

export type ProjectEditorListener = (state: ProjectEditorState, replaceFields: boolean) => void

export class ProjectEditorController {
  private state: ProjectEditorState = {
    path: '',
    busy: false,
    error: '',
    conflict: false,
    changedElsewhere: false,
    lastCommand: null,
    preserveDrafts: false,
  }
  private disposed = false
  private refreshSequence = 0

  constructor(
    private readonly client: IEditorClient,
    private readonly onChange: ProjectEditorListener,
  ) {}

  create(request: CreateProjectRequest): Promise<void> {
    return this.perform(async () => {
      if (!this.client.create)
        throw new EditorClientError('unsupported_creation', 'Project creation is unavailable')
      const view = await this.client.create(request)
      this.state = {
        ...this.state,
        path: request.path,
        view,
        lastCommand: null,
        preserveDrafts: false,
        error: '',
        conflict: false,
        changedElsewhere: false,
      }

      return true
    })
  }

  importProject(request: ProjectImportRequest, file: File): Promise<void> {
    return this.perform(async () => {
      if (!this.client.importProject)
        throw new EditorClientError('unsupported_project_import', 'Project import is unavailable')
      const view = await this.client.importProject(request, file)
      this.state = {
        ...this.state,
        path: request.destination,
        view,
        lastCommand: null,
        preserveDrafts: false,
        conflict: false,
        changedElsewhere: false,
        projectChange: { kind: 'imported', previousPath: this.state.path },
      }

      return true
    })
  }

  async exportProject(): Promise<ProjectDownload | undefined> {
    const { path, view } = this.state

    if (!view) return undefined
    let result: ProjectDownload | undefined
    await this.perform(async () => {
      if (!this.client.exportProject)
        throw new EditorClientError('unsupported_project_export', 'Project export is unavailable')
      result = await this.client.exportProject({ path, expectedRevision: view.revision })

      return false
    })

    return result
  }

  load(path: string, preserveFields = false): Promise<void> {
    const preserveDrafts = preserveFields && path === this.state.path

    return this.perform(async () => {
      const view = await this.client.inspect(path)
      this.state = {
        ...this.state,
        path,
        view,
        lastCommand: null,
        preserveDrafts,
        error: '',
        conflict: false,
        changedElsewhere: false,
      }

      return true
    })
  }

  duplicate(request: Pick<DuplicateProjectRequest, 'destination' | 'title'>): Promise<void> {
    const { view, path } = this.state

    if (!view?.game) return Promise.resolve()

    return this.perform(async () => {
      if (!this.client.duplicate)
        throw new EditorClientError('unsupported_duplication', 'Project duplication is unavailable')

      const copy = await this.client.duplicate({
        ...request,
        path,
        expectedRevision: view.revision,
      })

      this.state = {
        ...this.state,
        path: request.destination,
        view: copy,
        lastCommand: null,
        preserveDrafts: false,
        error: '',
        conflict: false,
        changedElsewhere: false,
      }

      return true
    })
  }

  rename(request: Pick<RenameProjectRequest, 'title' | 'folderName'>): Promise<void> {
    const { view, path } = this.state

    if (!view) return Promise.resolve()

    return this.perform(async () => {
      if (!this.client.rename)
        throw new EditorClientError('unsupported_renaming', 'Project renaming is unavailable')
      const next = await this.client.rename({ ...request, path, expectedRevision: view.revision })
      this.state = {
        ...this.state,
        path: next.path,
        view: next,
        lastCommand: null,
        preserveDrafts: false,
        conflict: false,
        changedElsewhere: false,
        projectChange: { kind: 'renamed', previousPath: path },
      }

      return true
    })
  }

  delete(): Promise<void> {
    const { view, path } = this.state

    if (!view || !path) return Promise.resolve()

    return this.perform(async () => {
      if (!this.client.delete)
        throw new EditorClientError('unsupported_deletion', 'Project deletion is unavailable')
      await this.client.delete({ path, expectedRevision: view.revision, confirm: true })
      this.state = {
        path: '',
        busy: true,
        error: '',
        lastCommand: null,
        preserveDrafts: false,
        conflict: false,
        changedElsewhere: false,
        projectChange: { kind: 'deleted', previousPath: path },
      }

      return true
    })
  }

  restoreProject(request: RestoreProjectRequest): Promise<void> {
    return this.perform(async () => {
      if (!this.client.restoreProject)
        throw new EditorClientError('unsupported_restoration', 'Project restoration is unavailable')
      const next = await this.client.restoreProject(request)
      this.state = {
        ...this.state,
        path: next.path,
        view: next,
        lastCommand: null,
        preserveDrafts: false,
        conflict: false,
        changedElsewhere: false,
        projectChange: { kind: 'restored', previousPath: next.previousPath },
      }

      return true
    })
  }

  save(command: EditorCommand): Promise<void> {
    const { view, path } = this.state

    if (!view) return Promise.resolve()

    return this.perform(async () => {
      const next = await this.client.apply({ path, expectedRevision: view.revision, command })
      this.state = {
        ...this.state,
        view: next,
        lastCommand: command.type,
        preserveDrafts: true,
        error: '',
        conflict: false,
        changedElsewhere: false,
      }

      return true
    })
  }

  async checkRepair(
    request: Omit<ProjectRepairRequest, 'path'>,
  ): Promise<ProjectRepairCheck | undefined> {
    let result: ProjectRepairCheck | undefined
    await this.perform(async () => {
      if (!this.client.checkRepair)
        throw new EditorClientError('unsupported_repair', 'Project repair is unavailable')
      result = await this.client.checkRepair({ ...request, path: this.state.path })
      this.state = { ...this.state, conflict: false, changedElsewhere: false }

      return false
    })

    return result
  }

  async repair(request: Omit<ProjectRepairRequest, 'path'>): Promise<boolean> {
    let saved = false
    await this.perform(async () => {
      if (!this.client.repair)
        throw new EditorClientError('unsupported_repair', 'Project repair is unavailable')
      const next = await this.client.repair({ ...request, path: this.state.path })
      this.state = {
        ...this.state,
        view: next,
        lastCommand: null,
        preserveDrafts: true,
        error: '',
        conflict: false,
        changedElsewhere: false,
      }
      saved = true

      return true
    })

    return saved
  }

  async copyComponent(
    sceneId: string,
    componentId: string,
  ): Promise<ComponentClipboard | undefined> {
    const { view, path } = this.state

    if (!view) return undefined
    let result: ComponentClipboard | undefined

    await this.perform(async () => {
      if (!this.client.copyComponent)
        throw new EditorClientError('unsupported_copy', 'Component copying is unavailable')
      result = await this.client.copyComponent({
        path,
        expectedRevision: view.revision,
        sceneId,
        componentId,
      })

      return false
    })

    return result
  }

  restore(direction: 'undo' | 'redo'): Promise<void> {
    const { view, path } = this.state

    if (!view || !view.history?.[direction === 'undo' ? 'canUndo' : 'canRedo'])
      return Promise.resolve()

    return this.perform(async () => {
      if (!this.client.restore)
        throw new EditorClientError('unsupported_history', 'Undo and redo are unavailable')
      let next: ProjectView

      try {
        next = await this.client.restore({ path, expectedRevision: view.revision, direction })
      } catch (error) {
        if (
          error instanceof EditorClientError &&
          ['history_empty', 'history_restore_failed', 'history_restore_uncertain'].includes(
            error.code,
          )
        )
          this.state = {
            ...this.state,
            view: { ...view, history: { canUndo: false, canRedo: false } },
          }

        throw error
      }

      this.state = {
        ...this.state,
        view: next,
        lastCommand: null,
        historyChange: direction,
        preserveDrafts: false,
        error: '',
        conflict: false,
        changedElsewhere: false,
      }

      return true
    })
  }
  importAsset(id: string, format: 'svg' | 'png' | 'jpeg' | 'webp', file: File): Promise<void> {
    const { view, path } = this.state

    if (!view || !this.client.importAsset) return Promise.resolve()

    return this.perform(async () => {
      const next = await this.client.importAsset!(
        { path, expectedRevision: view.revision, id, format },
        file,
      )

      this.state = {
        ...this.state,
        view: next,
        lastCommand: 'assets.upsertImage',
        preserveDrafts: true,
        error: '',
        conflict: false,
        changedElsewhere: false,
      }

      return true
    })
  }

  async refresh(hasDrafts: boolean | (() => boolean)): Promise<void> {
    const { view, path } = this.state

    if (!view || this.disposed || this.state.busy) return
    const sequence = ++this.refreshSequence
    const isCurrent = () => !this.disposed && !this.state.busy && sequence === this.refreshSequence

    try {
      const next = await this.client.inspect(path)

      if (!isCurrent()) return

      if (next.revision === view.revision && next.storageKey === view.storageKey) {
        if (JSON.stringify(next.history) !== JSON.stringify(view.history)) {
          this.state = { ...this.state, view: { ...view, history: next.history } }
          this.onChange(this.state, false)
        }

        return
      }

      // Users can type or submit while the background read is in flight.
      if (typeof hasDrafts === 'function' ? hasDrafts() : hasDrafts) {
        // Keep the original revision with the draft so saving cannot silently overwrite newer data.
        this.state = { ...this.state, changedElsewhere: true }
        this.onChange(this.state, false)

        return
      }

      this.state = {
        ...this.state,
        view: next,
        error: '',
        conflict: false,
        changedElsewhere: false,
        lastCommand: null,
        preserveDrafts: false,
        historyChange: undefined,
      }
      this.onChange(this.state, true)
    } catch (error) {
      if (!isCurrent()) return
      this.reportError(error)
      this.onChange(this.state, false)
    }
  }

  dispose(): void {
    this.disposed = true
  }

  /** Recovered drafts retain their original revision until an explicit reload reviews newer files. */
  recoverDrafts(view: ProjectView): void {
    if (this.disposed || this.state.busy || !this.state.view) return
    const changedElsewhere = this.state.view.revision !== view.revision
    this.refreshSequence++
    this.state = {
      ...this.state,
      view,
      lastCommand: null,
      preserveDrafts: false,
      changedElsewhere,
      conflict: false,
      error: '',
    }
    this.onChange(this.state, true)
  }

  private async perform(operation: () => Promise<boolean>): Promise<void> {
    if (this.disposed || this.state.busy) return
    this.refreshSequence++
    this.state = {
      ...this.state,
      busy: true,
      error: '',
      historyChange: undefined,
      projectChange: undefined,
    }
    this.onChange(this.state, false)
    let replaceFields = false

    try {
      replaceFields = await operation()
    } catch (error) {
      this.reportError(error)
    } finally {
      this.state = { ...this.state, busy: false }

      if (!this.disposed) this.onChange(this.state, replaceFields)
    }
  }

  private reportError(error: unknown): void {
    const details =
      error instanceof EditorClientError
        ? error.diagnostics
            .map(
              (diagnostic) =>
                `${diagnostic.file} ${diagnostic.path.join('.')}: ${diagnostic.message}`,
            )
            .join('\n')
        : ''

    this.state = {
      ...this.state,
      error: `${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ''}`,
      conflict: error instanceof EditorClientError && error.code === 'revision_conflict',
    }
  }
}
