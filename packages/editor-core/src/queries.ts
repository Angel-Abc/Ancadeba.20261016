import { gameSchema, sceneSchema } from '@ancadeba/schemas'
import { validateProject } from './validation.js'
import type { ProjectSnapshot, ProjectView } from './project.js'

export function inspectProject(project: ProjectSnapshot): ProjectView {
  const game = gameSchema.safeParse(project.documents['game.json'])

  return {
    revision: project.revision,
    game: game.success ? game.data : null,
    scenes: game.success
      ? game.data.scenes.flatMap((id) => {
          const result = sceneSchema.safeParse(project.documents[`scenes/${id}.json`])

          return result.success && result.data.id === id ? [result.data] : []
        })
      : [],
    diagnostics: validateProject(project.documents, project.sourceDiagnostics),
  }
}
