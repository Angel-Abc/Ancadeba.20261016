import { z } from 'zod'

export const bindingAliasSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)

export const gameBindingSchema = z.object({
  source: z.enum(['game.state', 'game.progression']),
  path: z.array(z.union([z.string().min(1), z.number().int().nonnegative().safe()])).min(1),
  fallback: z.string().optional(),
})

export const textBindingsSchema = z.record(bindingAliasSchema, gameBindingSchema)

/** Complete brace pairs are placeholders only when the text opts into bindings. */
export function textPlaceholders(text: string): { alias: string; index: number; length: number }[] {
  return Array.from(text.matchAll(/{{([\s\S]*?)}}/g), (match) => ({
    alias: match[1]!.trim(),
    index: match.index,
    length: match[0].length,
  }))
}

export type GameBindingDefinition = z.infer<typeof gameBindingSchema>

export type TextBindingsDefinition = z.infer<typeof textBindingsSchema>
