import { z } from 'zod'

// Language tags are also directory names. Keep them portable and traversal-free.
export const languageTagSchema = z.string().regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/)

export const translationKeySchema = z.string().regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)

export const languageCatalogSchema = z.record(translationKeySchema, z.string())

export const gameLanguagesSchema = z
  .object({
    default: languageTagSchema,
    available: z.array(languageTagSchema).min(1),
  })
  .superRefine((languages, context) => {
    const tags = languages.available.map((tag) => tag.toLowerCase())

    if (new Set(tags).size !== tags.length)
      context.addIssue({ code: 'custom', path: ['available'], message: 'Languages must be unique' })

    if (!languages.available.includes(languages.default))
      context.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'Default language must be available',
      })
  })

export type LanguageCatalog = z.infer<typeof languageCatalogSchema>

/** Match a regional preference, then its base language, then the configured default. */
export function selectLanguage(
  available: readonly string[],
  fallback: string,
  preferences: readonly string[],
): string {
  for (const preference of preferences) {
    if (!languageTagSchema.safeParse(preference).success) continue
    let candidate = preference.toLowerCase()

    while (candidate) {
      const match = available.find((language) => language.toLowerCase() === candidate)

      if (match) return match
      const separator = candidate.lastIndexOf('-')
      candidate = separator < 0 ? '' : candidate.slice(0, separator)
    }
  }

  return fallback
}
