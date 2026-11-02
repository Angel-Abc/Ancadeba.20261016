import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { EditorClientError, type IEditorClient } from './editorClient.js'

export interface ProjectEditorState {
  path: string
  view?: ProjectView
  busy: boolean
  error: string
  conflict: boolean
  changedElsewhere: boolean
  lastCommand: EditorCommand['type'] | null
  preserveDrafts: boolean
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

  async refresh(hasDrafts: boolean | (() => boolean)): Promise<void> {
    const { view, path } = this.state
    if (!view || this.disposed || this.state.busy) return
    const sequence = ++this.refreshSequence
    const isCurrent = () => !this.disposed && !this.state.busy && sequence === this.refreshSequence
    try {
      const next = await this.client.inspect(path)
      if (!isCurrent() || next.revision === view.revision) return
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

  private async perform(operation: () => Promise<boolean>): Promise<void> {
    if (this.disposed || this.state.busy) return
    this.refreshSequence++
    this.state = { ...this.state, busy: true, error: '' }
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
