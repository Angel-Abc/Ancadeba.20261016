import type { GameDefinition, SceneDefinition, AssetCatalog } from '@ancadeba/schemas'

export type ProjectDocuments = Readonly<Record<string, unknown>>

export interface ProjectSnapshot {
  revision: string
  documents: ProjectDocuments
  sourceDiagnostics?: readonly Diagnostic[]
}

export interface Diagnostic {
  code: string
  file: string
  path: (string | number)[]
  message: string
}

export interface ProjectView {
  assets?: AssetCatalog | undefined
  revision: string
  game: GameDefinition | null
  scenes: SceneDefinition[]
  diagnostics: Diagnostic[]
}

export interface CommandResult {
  project: ProjectSnapshot
  changedFiles: string[]
  summary: string
  diagnostics: Diagnostic[]
}

export class EditorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message)
  }
}

export function object(value: unknown): Record<string, unknown> {
  // SAFETY: the true branch checks for a non-null, non-array object; fields remain unknown.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
