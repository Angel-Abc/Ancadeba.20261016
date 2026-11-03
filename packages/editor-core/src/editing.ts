import { gameSchema, sceneSchema } from '@ancadeba/schemas'
import { commandSchema, type EditorCommand } from './commands.js'
import { EditorError, object, type CommandResult, type ProjectSnapshot } from './project.js'
import { validateProject } from './validation.js'

export function applyCommand(project: ProjectSnapshot, input: EditorCommand): CommandResult {
  const parsed = commandSchema.safeParse(input)
  if (!parsed.success) throw new EditorError(400, 'invalid_command', 'Invalid editing command')
  const command = parsed.data
  const diagnostics = validateProject(project.documents, project.sourceDiagnostics)
  if (diagnostics.length)
    throw new EditorError(
      422,
      'invalid_project',
      'Fix project diagnostics before editing',
      diagnostics,
    )
  const documents = { ...project.documents }
  const game = gameSchema.parse(documents['game.json'])
  const changedFiles: string[] = []
  if (command.type === 'game.updateMetadata') {
    documents['game.json'] = {
      ...object(documents['game.json']),
      title: command.title,
      description: command.description,
      version: command.version,
    }
    changedFiles.push('game.json')
  } else if (command.type === 'scene.create') {
    const file = `scenes/${command.scene.id}.json`
    if (game.scenes.includes(command.scene.id) || Object.hasOwn(documents, file)) {
      throw new EditorError(409, 'scene_exists', 'Scene ID already exists')
    }
    // Clone the validated scene, including extension properties and normalized metadata.
    documents[file] = JSON.parse(JSON.stringify(command.scene))
    documents['game.json'] = {
      ...object(documents['game.json']),
      scenes: [...game.scenes, command.scene.id],
    }
    changedFiles.push(file, 'game.json')
  } else {
    if (!game.scenes.includes(command.sceneId))
      throw new EditorError(404, 'scene_not_found', 'Scene does not exist')
    const file = `scenes/${command.sceneId}.json`
    const source = object(documents[file])
    sceneSchema.parse(source)
    if (command.type === 'scene.updateMetadata') {
      documents[file] = { ...source, title: command.title, description: command.description }
    } else {
      const screen = object(source.screen)
      documents[file] = {
        ...source,
        screen: {
          ...screen,
          grid: { ...object(screen.grid), rows: command.rows, columns: command.columns },
        },
      }
    }
    changedFiles.push(file)
  }
  const resultingDiagnostics = validateProject(documents)
  if (resultingDiagnostics.length)
    throw new EditorError(
      422,
      'invalid_project',
      'Change produces an invalid project',
      resultingDiagnostics,
    )
  return {
    project: { revision: project.revision, documents },
    changedFiles,
    summary:
      command.type === 'scene.create'
        ? `Created scene ${command.scene.id}`
        : command.type === 'game.updateMetadata'
          ? 'Updated game metadata'
          : command.type === 'scene.updateLayout'
            ? `Updated scene ${command.sceneId} grid to ${command.rows} x ${command.columns}`
            : `Updated scene ${command.sceneId} metadata`,
    diagnostics: [],
  }
}
