import {
  gameRuleFiles,
  type GameDefinition,
  type SceneDefinition,
  type AssetCatalog,
  type InventoryDefinition,
  type GameRulesDefinition,
  type RuleSource,
} from '@ancadeba/schemas'

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
  rules?: GameRulesDefinition | undefined
  ruleFiles?: Record<string, GameRulesDefinition> | undefined
  assets?: AssetCatalog | undefined
  inventory?: InventoryDefinition | undefined
  translationKeys?: string[] | undefined
  revision: string
  game: GameDefinition | null
  scenes: SceneDefinition[]
  diagnostics: Diagnostic[]
}

export function projectRuleSources(
  reference: GameDefinition['rules'],
  load: (file: string) => GameRulesDefinition | undefined,
): RuleSource[] {
  if (reference && typeof reference === 'object' && !Array.isArray(reference))
    return [{ file: 'game.json', rules: reference }]

  return gameRuleFiles(reference).flatMap((file) => {
    const rules = load(file)

    return rules ? [{ file, rules }] : []
  })
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
