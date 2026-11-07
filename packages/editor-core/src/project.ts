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
  maps?: Record<string, MapDefinition> | undefined
  inventoryFiles?: Record<string, InventoryDefinition> | undefined
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
