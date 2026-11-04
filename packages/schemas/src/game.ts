import { z } from 'zod'
import { gameLanguagesSchema, translationKeySchema } from './languages.js'
import { gameRulesSchema } from './rules.js'

// IDs are also single filename segments when resolving scene references.
export const gameIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)

export const defaultRulesFile = 'rules.json'

export const ruleFilenameSchema = z.string().regex(/^[a-zA-Z0-9_-]+\.json$/)

const rulesReferenceSchema = z
  .union([ruleFilenameSchema, z.array(ruleFilenameSchema).min(1), gameRulesSchema])
  .optional()

export const gameSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id: gameIdSchema,
    title: z.string().trim().default(''),
    description: z.string().default(''),
    titleKey: translationKeySchema.optional(),
    descriptionKey: translationKeySchema.optional(),
    languages: gameLanguagesSchema.optional(),
    // Inline rules are accepted for projects saved before rule files were introduced.
    rules: rulesReferenceSchema,
    version: z.string().trim().min(1),
    'initial-scene': gameIdSchema.optional(),
    stylesheet: z
      .string()
      .regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.css$/)
      .optional(),
    // Older projects sometimes carried an ignored asset list as extension metadata.
    assets: z.union([z.string().regex(/^[a-zA-Z0-9_-]+\.json$/), z.array(z.string())]).optional(),
    inventory: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+\.json$/)
      .optional(),
    input: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+\.json$/)
      .optional(),
    maps: z
      .array(gameIdSchema)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Map references must be unique',
      })
      .optional(),
    scenes: z.array(gameIdSchema).refine((ids) => new Set(ids).size === ids.length, {
      message: 'Scene references must be unique',
    }),
  })
  .refine((game) => Boolean(game.title || game.titleKey), {
    path: ['title'],
    message: 'A title or titleKey is required',
  })
  .refine(
    (game) => {
      const files = gameRuleFiles(game.rules).map((file) => file.toLowerCase())

      const otherResources = [
        'game.json',
        game.input,
        game.inventory,
        typeof game.assets === 'string' ? game.assets : undefined,
      ]

      return (
        new Set(files).size === files.length &&
        !otherResources.some((resource) => resource && files.includes(resource.toLowerCase()))
      )
    },
    {
      path: ['rules'],
      message: 'Rules must reference distinct files separate from other game resources',
    },
  )
  .refine(
    (game) => game['initial-scene'] === undefined || game.scenes.includes(game['initial-scene']),
    {
      path: ['initial-scene'],
      message: 'Initial scene must reference a scene in the manifest',
    },
  )

export type GameDefinition = z.infer<typeof gameSchema>

export function gameRuleFiles(reference: z.infer<typeof rulesReferenceSchema>): readonly string[] {
  if (typeof reference === 'string') return [reference]

  return Array.isArray(reference) ? reference : []
}
