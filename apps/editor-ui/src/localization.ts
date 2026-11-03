import { selectLanguage } from '@ancadeba/schemas'
import { createTranslator } from '@ancadeba/utilities'
import en from '../languages/en/messages.json' with { type: 'json' }
import nl from '../languages/nl/messages.json' with { type: 'json' }

export const editorLanguages = { en: 'English', nl: 'Nederlands' }

// Keep the supplied catalogs complete while allowing runtime fallback for future translations.
const catalogs = { en, nl: nl satisfies Record<keyof typeof en, string> }

export function editorLocalization(preferences: readonly string[] = []) {
  const language = selectLanguage(Object.keys(catalogs), 'en', preferences)
  const messages = language === 'nl' ? catalogs.nl : catalogs.en

  return { language, t: createTranslator(en, messages) }
}
