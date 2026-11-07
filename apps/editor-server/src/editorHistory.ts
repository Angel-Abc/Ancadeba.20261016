import { EditorError, type ProjectView } from '@ancadeba/editor-core'
import { sameBytes, type HistoryFile } from './historyFiles.js'

interface HistoryEntry {
  label: string
  files: HistoryFile[]
}

interface ProjectHistory {
  revision: string
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

/** Bounded, server-session history. Callers serialize access with the editor coordinator. */
export class EditorHistory {
  private readonly projects = new Map<string, ProjectHistory>()

  constructor(
    private readonly maxEntries = 50,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  clear(path: string): void {
    this.projects.delete(path)
  }

  status(path: string, revision: string): NonNullable<ProjectView['history']> {
    let history = this.projects.get(path)

    if (history && history.revision !== revision) {
      this.clear(path)
      history = undefined
    }

    return {
      canUndo: Boolean(history?.undo.length),
      canRedo: Boolean(history?.redo.length),
      undoLabel: history?.undo.at(-1)?.label,
      redoLabel: history?.redo.at(-1)?.label,
    }
  }

  record(
    path: string,
    beforeRevision: string,
    revision: string,
    label: string,
    before: Record<string, Uint8Array | undefined>,
    after: Record<string, Uint8Array | undefined>,
  ): void {
    this.status(path, beforeRevision)
    const history = this.projects.get(path) ?? { revision, undo: [], redo: [] }

    const files = Object.keys(before)
      .filter((file) => !sameBytes(before[file], after[file]))
      .map((file) => ({ file, before: before[file], after: after[file] }))

    if (!files.length) return
    history.undo.push({ label, files })
    history.redo = []
    history.revision = revision

    while (history.undo.length > this.maxEntries) history.undo.shift()
    this.projects.delete(path)
    this.projects.set(path, history)

    const size = () =>
      [...this.projects.values()]
        .flatMap(({ undo, redo }) => [...undo, ...redo])
        .flatMap(({ files }) => files)
        .reduce(
          (sum, { before, after }) => sum + (before?.byteLength ?? 0) + (after?.byteLength ?? 0),
          0,
        )

    while (size() > this.maxBytes) {
      const oldest = this.projects.keys().next().value

      if (oldest !== undefined && oldest !== path) this.projects.delete(oldest)
      else if (history.undo.length > 1) history.undo.shift()
      else {
        this.clear(path)

        break
      }
    }
  }

  next(path: string, revision: string, direction: 'undo' | 'redo'): HistoryEntry {
    this.status(path, revision)
    const entry = this.projects.get(path)?.[direction].at(-1)

    if (!entry) throw new EditorError(409, 'history_empty', `No saved change to ${direction}`)

    return entry
  }

  commit(path: string, direction: 'undo' | 'redo', revision: string): void {
    const history = this.projects.get(path)
    const entry = history?.[direction].pop()

    if (!history || !entry) return
    history[direction === 'undo' ? 'redo' : 'undo'].push(entry)
    history.revision = revision
  }
}
