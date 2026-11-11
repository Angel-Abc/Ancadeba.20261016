import type { DialogueDefinition, QuestDefinition, LevelingProfile } from '@ancadeba/schemas'
import {
  ruleFile,
  inventoryFile,
  type GameDefinition,
  type SceneDefinition,
  type AssetCatalog,
  type InventoryDefinition,
  type InventorySource,
  type GameRulesDefinition,
  type RuleSource,
  type InputDefinition,
  type CombatDefinition,
  type CombatSource,
  type CombatLibrary,
  type CombatOrigins,
  type MapDefinition,
  type LanguageCatalog,
} from '@ancadeba/schemas'

export type ProjectDocuments = Readonly<Record<string, unknown>>

export interface ProjectSnapshot {
  revision: string
  documents: ProjectDocuments
  sourceDiagnostics?: readonly Diagnostic[]
  /** Original text for loaded definitions; null identifies a missing referenced file. */
  sourceTexts?: Readonly<Record<string, string | null>>
  /** A suggested manifest for a missing game.json; never saved automatically. */
  recoveryManifest?: string
}

export interface Diagnostic {
  code: string
  file: string
  path: (string | number)[]
  message: string
}

export interface ProjectView {
  recoveryManifest?: string | undefined
  /** Available only while invalid; raw definitions support repairing syntax and schema errors. */
  repairFiles?: Record<string, string | null> | undefined
  history?:
    | {
        canUndo: boolean
        canRedo: boolean
        undoLabel?: string | undefined
        redoLabel?: string | undefined
      }
    | undefined
  dialogues?: Record<string, DialogueDefinition> | undefined
  quests?: Record<string, QuestDefinition> | undefined
  leveling?: Record<string, LevelingProfile> | undefined
  combat?: Record<string, CombatDefinition> | undefined
  combatSources?: Record<string, CombatSource> | undefined
  combatLibraries?: Record<string, CombatLibrary> | undefined
  combatOrigins?: Record<string, CombatOrigins> | undefined
  input?: InputDefinition | undefined
  rules?: GameRulesDefinition | undefined
  ruleFiles?: Record<string, GameRulesDefinition> | undefined
  assets?: AssetCatalog | undefined
  inventory?: InventoryDefinition | undefined
  translationKeys?: string[] | undefined
  /** Default-language text for each translation key, for previews in the editor. */
  translations?: Record<string, string> | undefined
  /** Source catalogs for every configured language; missing keys use the default catalog. */
  languageCatalogs?: Record<string, LanguageCatalog> | undefined
  maps?: Record<string, MapDefinition> | undefined
  inventoryFiles?: Record<string, InventoryDefinition> | undefined
  /** Editable CSS files in this project, including saved files not currently assigned. */
  stylesheets?: Record<string, string> | undefined
  revision: string
  game: GameDefinition | null
  scenes: SceneDefinition[]
  diagnostics: Diagnostic[]
}

export function projectRuleSources(
  reference: GameDefinition['rules'],
  load: (file: string) => GameRulesDefinition | undefined,
): (RuleSource & { id: string })[] {
  return (reference ?? []).flatMap((id) => {
    const file = ruleFile(id)
    const rules = load(file)

    return rules ? [{ id, file, rules }] : []
  })
}

export function projectInventorySources(
  reference: GameDefinition['inventory'],
  load: (file: string) => InventoryDefinition | undefined,
): InventorySource[] {
  return (reference ?? []).flatMap((id) => {
    const file = inventoryFile(id)
    const inventory = load(file)

    return inventory ? [{ file, inventory }] : []
  })
}

export interface CommandResult {
  project: ProjectSnapshot
  changedFiles: string[]
  createdFiles?: readonly string[]
  removedFiles?: readonly string[]
  summary: string
  diagnostics: Diagnostic[]
}

export type EditorWriteOutcome = 'not_applied' | 'unknown'

/**
 * A 4xx rejection or a 503 unavailable feature must be raised before any project file is
 * written, or after a confirmed rollback. Failures that may leave saved changes use another 5xx.
 */
export class EditorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message)
  }

  get outcome(): EditorWriteOutcome {
    return this.status < 500 || this.status === 503 ? 'not_applied' : 'unknown'
  }
}

export function object(value: unknown): Record<string, unknown> {
  // SAFETY: the true branch checks for a non-null, non-array object; fields remain unknown.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
