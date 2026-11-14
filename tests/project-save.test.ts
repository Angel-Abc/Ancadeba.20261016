import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { object } from '@ancadeba/editor-core'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'

describe('project saves without a declared structure', () => {
  let root: string
  let repository: WorkspaceProjectRepository

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-project-save-', import.meta.url)))
    repository = new WorkspaceProjectRepository(await FileWorkspace.open(root))
    await new EditorProjectService(repository, new EditorCoordinator()).create({
      path: 'game',
      title: 'Game',
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('publishes every changed file when several existing files change together', async () => {
    const current = await repository.load('game')
    const changedFiles = ['scenes/start.json', 'scenes/adventure.json', 'game.json']
    const documents = { ...current.documents }

    for (const file of changedFiles)
      documents[file] = { ...object(documents[file]), description: `Changed ${file}` }

    await repository.save('game', {
      project: { revision: current.revision, documents },
      changedFiles,
      diagnostics: [],
      summary: 'Changed three files',
    })

    for (const file of changedFiles)
      expect(JSON.parse(await readFile(join(root, 'game', file), 'utf8'))).toEqual(documents[file])
  })
})
