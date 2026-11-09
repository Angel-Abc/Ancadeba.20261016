import {
  capabilities,
  commandRequestSchema,
  commandSchema,
  type EditorCommand,
} from '@ancadeba/editor-core'
import { z } from 'zod'

export const commandTool = 'ancadeba_apply_command'
export const mcpCommandRequestSchema = commandRequestSchema.omit({ path: true })

/** Resolve aliases by command name so adding or reordering commands cannot change their meaning. */
export function schemaFor<T extends EditorCommand['type']>(type: T) {
  const schema = commandSchema.options.find(
    (
      option,
    ): option is Extract<
      (typeof commandSchema.options)[number],
      { shape: { type: z.ZodLiteral<T> } }
    > => option.shape.type.value === type,
  )

  if (!schema) throw new Error(`Missing editor command schema: ${type}`)

  return schema
}

/** Advertise locally understood commands that the connected server currently supports. */
export function mcpCapabilities(remote: { version: number; commands: { type: string }[] }) {
  const supported = new Set(remote.commands.map(({ type }) => type))
  const options = commandSchema.options.filter((option) => supported.has(option.shape.type.value))

  const request = mcpCommandRequestSchema.extend({
    command: options.length ? z.union(options) : z.never(),
  })

  return {
    version: remote.version,
    commandTool,
    requestSchema: z.toJSONSchema(request),
    commands: capabilities.commands.filter(({ type }) => supported.has(type)),
  }
}
