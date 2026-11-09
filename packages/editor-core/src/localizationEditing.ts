import type { GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

/** Save the complete localization draft through guarded multi-file publication. */
export function editLocalization(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<EditorCommand, { type: 'game.updateLocalization' }>,
) {
  const previous = game.languages?.available ?? []
  const changedFiles = ['game.json']
  const createdFiles: string[] = []

  for (const language of command.languages.available) {
    const file = `languages/${language}/messages.json`
    const existing = previous.find((tag) => tag.toLowerCase() === language.toLowerCase())

    if (existing && existing !== language)
      throw new EditorError(409, 'language_exists', `Use the existing language tag: ${existing}`)

    if (!existing) {
      if (Object.keys(documents).some((path) => path.toLowerCase() === file.toLowerCase()))
        throw new EditorError(409, 'language_exists', 'A catalog already exists for this language')
      createdFiles.push(file)
    }

    documents[file] = { ...command.catalogs[language] }
    changedFiles.push(file)
  }

  for (const language of previous.filter((tag) => !command.languages.available.includes(tag))) {
    const file = `languages/${language}/messages.json`
    delete documents[file]
    changedFiles.push(file)
  }

  documents['game.json'] = {
    ...object(documents['game.json']),
    languages: { ...object(object(documents['game.json']).languages), ...command.languages },
  }

  // An empty createdFiles list also routes updates of existing catalogs through atomic rollback.
  return { changedFiles, createdFiles }
}
