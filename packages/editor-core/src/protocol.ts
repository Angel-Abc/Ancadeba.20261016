import { z } from 'zod'
import { gameSchema, sceneSchema, assetCatalogSchema } from '@ancadeba/schemas'

export const diagnosticSchema = z.object({
  code: z.string(),
  file: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
})

export const projectViewSchema = z.object({
  assets: assetCatalogSchema.optional(),
  revision: z.string().min(1),
  game: gameSchema.nullable(),
  scenes: z.array(sceneSchema),
  diagnostics: z.array(diagnosticSchema),
})

export const apiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  diagnostics: z.array(diagnosticSchema).default([]),
})
