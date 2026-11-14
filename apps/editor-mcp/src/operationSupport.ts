import {
  assetImportMetadataSchema,
  historyRequestSchema,
  createProjectRequestSchema,
  duplicateProjectRequestSchema,
  maxDuplicateProjectBytes,
  maxDuplicateProjectFiles,
} from '@ancadeba/editor-core'
import { z } from 'zod'
import { workspaceProjectPathSchema } from './projectPath.js'

// The existing editor import endpoint limits the entire multipart request to 10 MiB.
export const maxUploadBytes = 10 * 1024 * 1024
export const maxBase64UploadCharacters = Math.ceil(maxUploadBytes / 3) * 4
export const maxMcpMessageBytes = maxBase64UploadCharacters + 64 * 1024
export const historyInputSchema = historyRequestSchema.omit({ path: true, direction: true })
export const listProjectsInputSchema = z.strictObject({})
export const createProjectInputSchema = createProjectRequestSchema
export const duplicateProjectInputSchema = duplicateProjectRequestSchema.omit({ path: true })
export const switchProjectInputSchema = z.strictObject({ path: workspaceProjectPathSchema })

// A base64 archive plus its envelope must fit clients' default 10 MiB MCP message limit.
export const maxExportBytes = 6 * 1024 * 1024
export const defaultExportTimeoutMs = 120_000

export const exportGameInputSchema = z.strictObject({
  timeoutMs: z.number().int().min(1).max(300_000).default(defaultExportTimeoutMs),
})

export const assetUploadInputSchema = assetImportMetadataSchema.omit({ path: true }).extend({
  dataBase64: z
    .string()
    .min(4)
    .max(maxBase64UploadCharacters)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine(
      (value) =>
        value.length <= maxBase64UploadCharacters &&
        value.length % 4 === 0 &&
        Buffer.from(value, 'base64').toString('base64') === value,
      'Provide canonical padded base64 without a data URL prefix or whitespace',
    ),
})

export const editorFeaturesSchema = z.object({
  history: z.boolean().default(false),
  assetImport: z.boolean().default(false),
  projectDiscovery: z.boolean().optional(),
  projectCreation: z.boolean().optional(),
  projectDuplication: z.boolean().optional(),
  gameExport: z.boolean().optional(),
})

const toolOperation = <T extends string>(tool: T) =>
  z.object({
    tool: z.literal(tool),
    supported: z.boolean(),
    requestSchema: z.record(z.string(), z.unknown()),
  })

export const operationsSchema = z.object({
  gameExport: toolOperation('ancadeba_export_game').extend({
    maxArchiveBytes: z.number().int().positive(),
    defaultTimeoutMs: z.number().int().positive(),
  }),
  undo: toolOperation('ancadeba_undo'),
  redo: toolOperation('ancadeba_redo'),
  projectDiscovery: toolOperation('ancadeba_list_projects'),
  projectCreation: toolOperation('ancadeba_create_project'),
  projectDuplication: toolOperation('ancadeba_duplicate_project').extend({
    maxProjectBytes: z.number().int().positive(),
    maxFiles: z.number().int().positive(),
  }),
  projectSwitching: toolOperation('ancadeba_switch_project'),
  assetUpload: z.object({
    tool: z.literal('ancadeba_upload_asset'),
    supported: z.boolean(),
    requestSchema: z.record(z.string(), z.unknown()),
    maxMultipartBytes: z.number().int().positive(),
  }),
})

export function mcpOperations(features?: z.infer<typeof editorFeaturesSchema>) {
  return {
    gameExport: {
      tool: 'ancadeba_export_game' as const,
      supported: features?.gameExport === true,
      requestSchema: z.toJSONSchema(exportGameInputSchema, { io: 'input' }),
      maxArchiveBytes: maxExportBytes,
      defaultTimeoutMs: defaultExportTimeoutMs,
    },
    projectSwitching: {
      tool: 'ancadeba_switch_project' as const,
      supported: features?.projectDiscovery === true,
      requestSchema: z.toJSONSchema(switchProjectInputSchema),
    },
    projectDiscovery: {
      tool: 'ancadeba_list_projects' as const,
      supported: features?.projectDiscovery === true,
      requestSchema: z.toJSONSchema(listProjectsInputSchema),
    },
    projectCreation: {
      tool: 'ancadeba_create_project' as const,
      supported: features?.projectCreation === true,
      requestSchema: z.toJSONSchema(createProjectInputSchema),
    },
    projectDuplication: {
      tool: 'ancadeba_duplicate_project' as const,
      supported: features?.projectDuplication === true,
      requestSchema: z.toJSONSchema(duplicateProjectInputSchema),
      maxProjectBytes: maxDuplicateProjectBytes,
      maxFiles: maxDuplicateProjectFiles,
    },
    undo: {
      tool: 'ancadeba_undo' as const,
      supported: features?.history === true,
      requestSchema: z.toJSONSchema(historyInputSchema),
    },
    redo: {
      tool: 'ancadeba_redo' as const,
      supported: features?.history === true,
      requestSchema: z.toJSONSchema(historyInputSchema),
    },
    assetUpload: {
      tool: 'ancadeba_upload_asset' as const,
      supported: features?.assetImport === true,
      requestSchema: z.toJSONSchema(assetUploadInputSchema),
      maxMultipartBytes: maxUploadBytes,
    },
  }
}
