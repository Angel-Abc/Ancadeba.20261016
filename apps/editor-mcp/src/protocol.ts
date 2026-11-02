import { z } from 'zod'
import { gameSchema, sceneSchema } from '@ancadeba/schemas'

export const diagnosticSchema = z.object({
  code: z.string(),
  file: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
})
export const projectViewSchema = z.object({
  revision: z.string().min(1),
  game: gameSchema.nullable(),
  scenes: z.array(sceneSchema),
  diagnostics: z.array(diagnosticSchema),
})
export const sceneViewSchema = z.object({
  revision: z.string().min(1),
  scene: sceneSchema,
  diagnostics: z.array(diagnosticSchema),
})
export const capabilitiesSchema = z.object({
  version: z.number().int(),
  requestSchema: z.record(z.string(), z.unknown()),
  commands: z.array(z.object({ type: z.string(), example: z.record(z.string(), z.unknown()) })),
})
export const appliedChangeSchema = projectViewSchema.extend({
  changedFiles: z.array(z.string()),
  summary: z.string(),
})
export const apiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  diagnostics: z.array(diagnosticSchema).default([]),
})
export const toolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number().optional(),
  diagnostics: z.array(diagnosticSchema),
  outcome: z.enum(['not_applied', 'unknown']),
  recovery: z.string(),
})
export const gameSummarySchema = projectViewSchema.extend({
  gamePath: z.string(),
  scenes: z.array(
    z.object({
      id: sceneSchema.shape.id,
      title: sceneSchema.shape.title,
      type: sceneSchema.shape.type,
      screen: sceneSchema.shape.screen,
    }),
  ),
})
export const changeSummarySchema = appliedChangeSchema
  .pick({
    revision: true,
    changedFiles: true,
    summary: true,
    diagnostics: true,
  })
  .extend({ gamePath: z.string() })

export function resultSchema<T extends z.ZodType>(data: T) {
  return z.object({ ok: z.boolean(), data: data.optional(), error: toolErrorSchema.optional() })
}
