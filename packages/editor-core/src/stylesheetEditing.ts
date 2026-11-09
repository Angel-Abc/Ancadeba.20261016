import { assetCatalogFile, type GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

export function editStylesheet(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: Extract<EditorCommand, { type: 'game.upsertStylesheet' | 'game.assignStylesheet' }>,
) {
  const changedFiles: string[] = []
  const createdFiles: string[] = []
  const images = game.assets ? object(object(documents[assetCatalogFile(game.assets)]).images) : {}

  if (
    command.file &&
    Object.values(images).some(
      (image) =>
        typeof object(image).source === 'string' &&
        String(object(image).source).toLowerCase() === command.file?.toLowerCase(),
    )
  )
    throw new EditorError(
      422,
      'stylesheet_in_use',
      'This path belongs to registered artwork. Choose a separate CSS file.',
    )

  if (command.type === 'game.upsertStylesheet') {
    const existing = Object.keys(documents).find(
      (file) => file.toLowerCase() === command.file.toLowerCase(),
    )

    if (existing && (command.createOnly || existing !== command.file))
      throw new EditorError(
        409,
        'stylesheet_exists',
        'A stylesheet with this path already exists. Select the existing file to edit it.',
      )

    if (existing && typeof documents[existing] !== 'string')
      throw new EditorError(422, 'invalid_stylesheet', 'The stylesheet must contain CSS text')

    if (!existing) createdFiles.push(command.file)
    documents[command.file] = command.css
    changedFiles.push(command.file)
  } else if (command.file !== null && typeof documents[command.file] !== 'string')
    throw new EditorError(
      404,
      'stylesheet_not_found',
      'Select an existing stylesheet or create one first',
    )

  const assign = command.type === 'game.assignStylesheet' || command.assign !== false

  if (assign && game.stylesheet !== (command.file ?? undefined)) {
    documents['game.json'] = {
      ...object(documents['game.json']),
      stylesheet: command.file ?? undefined,
    }
    changedFiles.push('game.json')
  }

  // Route both CSS updates and reference changes through guarded multi-file persistence.
  return { changedFiles, createdFiles }
}
