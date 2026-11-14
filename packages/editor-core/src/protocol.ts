import { dialogueSchema, questSchema, levelingProfileSchema } from '@ancadeba/schemas'
import { z } from 'zod'
import {
  gameSchema,
  sceneSchema,
  assetCatalogSchema,
  inventorySchema,
  gameRulesSchema,
  gameIdSchema,
  inputSchema,
  combatDefinitionSchema,
  combatSourceSchema,
  combatLibrarySchema,
  combatOriginsSchema,
  languageCatalogSchema,
  languageTagSchema,
  mapDefinitionSchema,
} from '@ancadeba/schemas'

export const diagnosticSchema = z.object({
  code: z.string(),
  file: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
})

export const projectViewSchema = z.object({
  storageKey: z.string().optional(),
  recoveryManifest: z.string().optional(),
  repairFiles: z.record(z.string(), z.string().nullable()).optional(),
  history: z
    .object({
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      undoLabel: z.string().optional(),
      redoLabel: z.string().optional(),
    })
    .optional(),
  dialogues: z.record(gameIdSchema, dialogueSchema).optional(),
  quests: z.record(gameIdSchema, questSchema).optional(),
  leveling: z.record(gameIdSchema, levelingProfileSchema).optional(),
  combat: z.record(gameIdSchema, combatDefinitionSchema).optional(),
  combatSources: z.record(gameIdSchema, combatSourceSchema).optional(),
  combatLibraries: z.record(gameIdSchema, combatLibrarySchema).optional(),
  combatOrigins: z.record(gameIdSchema, combatOriginsSchema).optional(),
  input: inputSchema.optional(),
  rules: gameRulesSchema.optional(),
  ruleFiles: z.record(gameIdSchema, gameRulesSchema).optional(),
  assets: assetCatalogSchema.optional(),
  inventory: inventorySchema.optional(),
  translationKeys: z.array(z.string()).optional(),
  translations: languageCatalogSchema.optional(),
  languageCatalogs: z.record(languageTagSchema, languageCatalogSchema).optional(),
  maps: z.record(gameIdSchema, mapDefinitionSchema).optional(),
  inventoryFiles: z.record(gameIdSchema, inventorySchema).optional(),
  stylesheets: z.record(z.string(), z.string()).optional(),
  revision: z.string().min(1),
  game: gameSchema.nullable(),
  scenes: z.array(sceneSchema),
  diagnostics: z.array(diagnosticSchema),
})

export const projectListSchema = z.object({
  projects: z.array(
    z.object({ path: z.string(), title: z.string(), missingManifest: z.boolean().optional() }),
  ),
})

export type ProjectChoice = z.infer<typeof projectListSchema>['projects'][number]

export const historyRequestSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  direction: z.enum(['undo', 'redo']),
})

export type HistoryRequest = z.infer<typeof historyRequestSchema>

export const projectRepairRequestSchema = z.strictObject({
  path: z.string(),
  expectedRevision: z.string().min(1),
  file: z.string().min(1),
  text: z.string().max(4 * 1024 * 1024),
})

export const projectRepairCheckSchema = z.object({
  revision: z.string().min(1),
  diagnostics: z.array(diagnosticSchema),
})

export type ProjectRepairRequest = z.infer<typeof projectRepairRequestSchema>

export type ProjectRepairCheck = z.infer<typeof projectRepairCheckSchema>

export const apiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  diagnostics: z.array(diagnosticSchema).default([]),
  /** Whether a failed mutation may have saved; absent on legacy workspace errors. */
  outcome: z.enum(['not_applied', 'unknown']).optional(),
})
