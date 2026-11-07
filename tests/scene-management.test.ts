import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyCommand,
  createStarterProject,
  object,
  validateProject,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { HttpEditorClient } from '../apps/editor-ui/src/editorClient.js'
import { EditorWorkspaceResources } from '../apps/editor-ui/src/workspaceResources.js'
import { exportGame } from '../tooling/game-export.js'

const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

function project(): ProjectSnapshot {
  const documents = createStarterProject({ path: 'game', title: 'Scene test', description: '' })
  const adventure = object(documents['scenes/adventure.json'])
  const components = Array.isArray(adventure.components) ? adventure.components : []

  return {
    revision: 'one',
    documents: {
      ...documents,
      'game.json': {
        ...object(documents['game.json']),
        rules: ['rules'],
        dialogues: ['guide'],
        quests: ['visit'],
        combat: ['trial'],
      },
      'scenes/adventure.json': {
        ...adventure,
        custom: { scene: 'adventure' },
        components: [
          ...components,
          {
            id: 'loop',
            type: 'button',
            placement: { row: 1, column: 1 },
            label: 'adventure',
            action: { type: 'enter-scene', scene: 'adventure' },
            extension: { scene: 'adventure' },
          },
          {
            id: 'bar',
            type: 'action-bar',
            placement: { row: 1, column: 1 },
            slots: { '1': { label: 'Loop', action: { type: 'enter-scene', scene: 'adventure' } } },
          },
        ],
      },
      'rules/rules.json': {
        state: [
          { path: ['health'], value: 10 },
          { path: ['enemyHealth'], value: 10 },
        ],
        actions: {
          visit: [
            {
              when: [{ type: 'scene-is', scene: 'adventure' }],
              effects: [{ type: 'enter-scene', scene: 'adventure' }],
            },
          ],
        },
      },
      'dialogues/guide.json': {
        'schema-version': '1.0.0',
        id: 'guide',
        label: 'Guide',
        entry: 'hello',
        nodes: {
          hello: {
            lines: [{ text: 'adventure' }],
            choices: [
              {
                id: 'visit',
                label: 'Visit',
                end: true,
                scene: 'adventure',
                when: [{ type: 'scene-is', scene: 'adventure' }],
                visibleWhen: [{ type: 'scene-is', scene: 'adventure' }],
              },
            ],
          },
        },
        extension: { scene: 'adventure' },
      },
      'quests/visit.json': {
        'schema-version': '1.0.0',
        id: 'visit',
        label: 'Visit',
        when: [{ type: 'scene-is', scene: 'adventure' }],
        turnInWhen: [{ type: 'scene-is', scene: 'adventure' }],
        stages: [
          {
            id: 'visit',
            objectives: [
              { id: 'visit', label: 'Visit', when: [{ type: 'scene-is', scene: 'adventure' }] },
            ],
          },
        ],
      },
      'combat/trial.json': {
        'schema-version': '1.0.0',
        id: 'trial',
        label: 'Trial',
        player: {
          id: 'player',
          label: 'Player',
          health: { source: 'game.state', path: ['health'] },
          maximumHealth: 10,
          moves: ['attack'],
        },
        enemies: [
          {
            id: 'enemy',
            label: 'Enemy',
            health: { source: 'game.state', path: ['enemyHealth'] },
            maximumHealth: 10,
            moves: ['attack'],
            rotation: ['attack'],
          },
        ],
        moves: {
          attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 1, max: 1 } },
        },
        outcomes: { victory: 'adventure', defeat: 'start' },
      },
    },
  }
}

describe('component duplication and order', () => {
  it('retains component references and shared quest resources when copying specialized components', () => {
    const original = project()
    const scene = object(original.documents['scenes/adventure.json'])
    const components = Array.isArray(scene.components) ? scene.components : []

    const journalScene = {
      ...scene,
      components: [
        ...components,
        {
          id: 'journal',
          type: 'quest-log',
          label: 'Journal',
          textTarget: 'narrative',
          placement: { row: 1, column: 1 },
          extension: { nested: ['keep'] },
        },
      ],
    }

    const withJournal = {
      ...original,
      documents: { ...original.documents, 'scenes/adventure.json': journalScene },
    }

    const copied = applyCommand(withJournal, {
      type: 'scene.duplicateComponent',
      sceneId: 'adventure',
      componentId: 'journal',
      newId: 'journal-copy',
    })

    const entries = object(copied.project.documents['scenes/adventure.json']).components
    expect(Array.isArray(entries) && entries.at(-1)).toMatchObject({
      id: 'journal-copy',
      type: 'quest-log',
      textTarget: 'narrative',
      extension: { nested: ['keep'] },
    })
    expect(copied.project.documents['quests/visit.json']).toBe(
      original.documents['quests/visit.json'],
    )
    expect(validateProject(copied.project.documents)).toEqual([])
  })

  it('copies complete nested data beside the source without sharing mutable objects or changing other resources', () => {
    const original = project()
    const before = JSON.stringify(original)

    const result = applyCommand(original, {
      type: 'scene.duplicateComponent',
      sceneId: 'adventure',
      componentId: 'loop',
      newId: 'loop-copy',
    })

    const scene = object(result.project.documents['scenes/adventure.json'])
    const components = Array.isArray(scene.components) ? scene.components : []
    const source = object(components[2])
    const copy = object(components[3])

    expect(components.map((entry) => object(entry).id)).toEqual([
      'narrative',
      'menu',
      'loop',
      'loop-copy',
      'bar',
    ])
    expect(copy).toEqual({ ...source, id: 'loop-copy' })
    expect(copy.action).not.toBe(source.action)
    expect(copy.extension).not.toBe(source.extension)
    expect(copy.placement).not.toBe(source.placement)
    expect(result.changedFiles).toEqual(['scenes/adventure.json'])
    expect(JSON.stringify(original)).toBe(before)
    expect(validateProject(result.project.documents)).toEqual([])
  })

  it('moves components to final zero-based positions without changing data, placement, or references', () => {
    const original = project()
    const before = JSON.stringify(original)

    const first = applyCommand(original, {
      type: 'scene.moveComponent',
      sceneId: 'adventure',
      componentId: 'bar',
      index: 0,
    }).project

    const moved = object(first.documents['scenes/adventure.json'])
    const originalScene = object(original.documents['scenes/adventure.json'])

    const originalComponents = Array.isArray(originalScene.components)
      ? originalScene.components
      : []

    expect(moved.components).toEqual([originalComponents[3], ...originalComponents.slice(0, 3)])

    const last = applyCommand(first, {
      type: 'scene.moveComponent',
      sceneId: 'adventure',
      componentId: 'bar',
      index: 3,
    }).project

    expect(last.documents).toEqual(original.documents)
    expect(
      applyCommand(last, {
        type: 'scene.moveComponent',
        sceneId: 'adventure',
        componentId: 'narrative',
        index: 0,
      }).project.documents,
    ).toEqual(original.documents)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('rejects occupied IDs, singleton copies, missing targets, and invalid positions', () => {
    const original = project()
    const before = JSON.stringify(original)

    const duplicate: EditorCommand = {
      type: 'scene.duplicateComponent',
      sceneId: 'adventure',
      componentId: 'loop',
      newId: 'loop-copy',
    }

    expect(() => applyCommand(original, { ...duplicate, newId: 'loop' })).toThrow('already exists')
    expect(() => applyCommand(original, { ...duplicate, componentId: 'bar' })).toThrow('Only one')
    expect(() => applyCommand(original, { ...duplicate, sceneId: 'missing' })).toThrow(
      'Scene does not exist',
    )
    expect(() => applyCommand(original, { ...duplicate, componentId: 'missing' })).toThrow(
      'Component does not exist',
    )

    for (const index of [-1, 0.5, 4])
      expect(() =>
        applyCommand(original, {
          type: 'scene.moveComponent',
          sceneId: 'adventure',
          componentId: 'loop',
          index,
        }),
      ).toThrow()
    expect(JSON.stringify(original)).toBe(before)
  })
})

describe('scene structure commands', () => {
  it('renames references in buttons, action bars, rules, conversations, quests, and combat without touching text or extensions', () => {
    const source = project()
    expect(validateProject(source.documents)).toEqual([])
    const before = JSON.stringify(source)

    const renamed = applyCommand(source, {
      type: 'scene.rename',
      sceneId: 'adventure',
      newId: 'journey',
    })

    const docs = renamed.project.documents
    expect(validateProject(docs)).toEqual([])
    expect(Object.hasOwn(docs, 'scenes/adventure.json')).toBe(false)
    expect(object(docs['game.json']).scenes).toEqual(['start', 'journey'])
    expect(object(docs['scenes/journey.json']).custom).toEqual({ scene: 'adventure' })
    expect(JSON.stringify(docs['scenes/journey.json'])).toContain('"label":"adventure"')
    expect(JSON.stringify(docs['scenes/journey.json'])).toContain(
      '"extension":{"scene":"adventure"}',
    )
    expect(docs['rules/rules.json']).toMatchObject({
      actions: { visit: [{ when: [{ scene: 'journey' }], effects: [{ scene: 'journey' }] }] },
    })
    expect(docs['dialogues/guide.json']).toMatchObject({
      extension: { scene: 'adventure' },
      nodes: {
        hello: {
          lines: [{ text: 'adventure' }],
          choices: [
            { scene: 'journey', when: [{ scene: 'journey' }], visibleWhen: [{ scene: 'journey' }] },
          ],
        },
      },
    })
    expect(docs['quests/visit.json']).toMatchObject({
      when: [{ scene: 'journey' }],
      turnInWhen: [{ scene: 'journey' }],
      stages: [{ objectives: [{ when: [{ scene: 'journey' }] }] }],
    })
    expect(docs['combat/trial.json']).toMatchObject({
      outcomes: { victory: 'journey', defeat: 'start' },
    })
    expect(JSON.stringify(source)).toBe(before)
  })

  it('duplicates scene data independently, redirects self-links, and keeps shared resources and startup unchanged', () => {
    const source = project()

    const duplicate = applyCommand(source, {
      type: 'scene.duplicate',
      sceneId: 'adventure',
      newId: 'copy',
      title: 'A separate view',
    })

    expect(duplicate.project.documents['scenes/copy.json']).toMatchObject({
      id: 'copy',
      title: 'A separate view',
      custom: { scene: 'adventure' },
    })
    expect(JSON.stringify(duplicate.project.documents['scenes/copy.json'])).toContain(
      '"action":{"type":"enter-scene","scene":"copy"}',
    )
    expect(duplicate.project.documents['scenes/copy.json']).not.toBe(
      source.documents['scenes/adventure.json'],
    )
    expect(duplicate.project.documents['rules/rules.json']).toEqual(
      source.documents['rules/rules.json'],
    )
    expect(object(duplicate.project.documents['game.json'])['initial-scene']).toBe('start')
    expect(duplicate.createdFiles).toEqual(['scenes/copy.json'])
  })

  it('rejects referenced scenes without a replacement and validates replacement types', () => {
    expect(() => applyCommand(project(), { type: 'scene.remove', sceneId: 'adventure' })).toThrow(
      'Choose a replacement',
    )
    expect(() =>
      applyCommand(project(), {
        type: 'scene.remove',
        sceneId: 'adventure',
        replacementScene: 'start',
      }),
    ).toThrow('invalid project')
    expect(() =>
      applyCommand(project(), {
        type: 'scene.remove',
        sceneId: 'adventure',
        replacementScene: 'adventure',
      }),
    ).toThrow('different')
  })

  it('redirects incoming links on deletion and keeps the startup scene valid through rename and delete', () => {
    const duplicated = applyCommand(project(), {
      type: 'scene.duplicate',
      sceneId: 'adventure',
      newId: 'copy',
      title: 'Copy',
    }).project

    const selected = applyCommand(duplicated, {
      type: 'game.setInitialScene',
      sceneId: 'adventure',
    }).project

    const renamed = applyCommand(selected, {
      type: 'scene.rename',
      sceneId: 'adventure',
      newId: 'journey',
    }).project

    expect(object(renamed.documents['game.json'])['initial-scene']).toBe('journey')

    const removed = applyCommand(renamed, {
      type: 'scene.remove',
      sceneId: 'journey',
      replacementScene: 'copy',
    })

    expect(object(removed.project.documents['game.json'])['initial-scene']).toBe('copy')
    expect(validateProject(removed.project.documents)).toEqual([])
    expect(removed.removedFiles).toEqual(['scenes/journey.json'])
  })

  it('rejects collisions, case-only renames, missing scenes, and deletion of the last scene', () => {
    for (const newId of ['start', 'START', 'ADVENTURE'])
      expect(() =>
        applyCommand(project(), { type: 'scene.rename', sceneId: 'adventure', newId }),
      ).toThrow('unused scene ID')
    expect(() =>
      applyCommand(project(), { type: 'game.setInitialScene', sceneId: 'missing' }),
    ).toThrow('Scene does not exist')
    const documents = createStarterProject({ path: 'game', title: 'Test', description: '' })

    const single = {
      revision: 'one',
      documents: {
        ...documents,
        'game.json': { ...object(documents['game.json']), scenes: ['start'] },
        'scenes/start.json': { ...object(documents['scenes/start.json']), components: [] },
      },
    }

    expect(() => applyCommand(single, { type: 'scene.remove', sceneId: 'start' })).toThrow(
      'last scene',
    )
  })

  it('deletes unreferenced components and refuses to break local component references', () => {
    const source = project()
    const scene = object(source.documents['scenes/adventure.json'])

    const withReference = {
      ...source,
      documents: {
        ...source.documents,
        'scenes/adventure.json': {
          ...scene,
          components: [
            ...(Array.isArray(scene.components) ? scene.components : []),
            {
              type: 'nearby',
              id: 'nearby',
              label: 'Nearby',
              placement: { row: 1, column: 1 },
              descriptionTarget: 'narrative',
              entries: {},
            },
          ],
        },
      },
    }

    expect(() =>
      applyCommand(withReference, {
        type: 'scene.removeComponent',
        sceneId: 'adventure',
        componentId: 'narrative',
      }),
    ).toThrow('Update component references')

    const removed = applyCommand(withReference, {
      type: 'scene.removeComponent',
      sceneId: 'adventure',
      componentId: 'menu',
    })

    expect(JSON.stringify(removed.project.documents['scenes/adventure.json'])).not.toContain(
      '"id":"menu"',
    )
    expect(() =>
      applyCommand(source, {
        type: 'scene.removeComponent',
        sceneId: 'adventure',
        componentId: 'missing',
      }),
    ).toThrow('Component does not exist')
  })
})

describe('scene management persistence and API', () => {
  let root: string
  let workspace: FileWorkspace
  let server: Server
  let client: HttpEditorClient
  let fetcher: typeof fetch

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-scene-management-', import.meta.url)))
    workspace = await FileWorkspace.open(root)

    for (const [file, data] of Object.entries(project().documents))
      await workspace.write(
        `game/${file}`,
        Buffer.from(typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`),
      )

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      service,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()

    if (!address || typeof address === 'string') throw new Error('Expected TCP server')
    const base = `http://127.0.0.1:${address.port}`
    fetcher = (url, init) => fetch(new URL(url instanceof Request ? url.url : url, base), init)
    client = new HttpEditorClient(fetcher)
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  })

  const apply = async (command: EditorCommand) =>
    client.apply({
      path: 'game',
      expectedRevision: (await client.inspect('game')).revision,
      command,
    })

  it('persists component copies and ordering, rejects stale revisions, and reloads the saved runtime order', async () => {
    const before = await client.inspect('game')
    await apply({
      type: 'scene.duplicateComponent',
      sceneId: 'adventure',
      componentId: 'loop',
      newId: 'loop-copy',
    })
    await expect(
      client.apply({
        path: 'game',
        expectedRevision: before.revision,
        command: {
          type: 'scene.moveComponent',
          sceneId: 'adventure',
          componentId: 'loop',
          index: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    await apply({
      type: 'scene.moveComponent',
      sceneId: 'adventure',
      componentId: 'loop-copy',
      index: 0,
    })
    const expected = ['loop-copy', 'narrative', 'menu', 'loop', 'bar']
    const saved = JSON.parse(await readFile(join(root, 'game/scenes/adventure.json'), 'utf8'))
    expect(saved.components.map((entry: { id: string }) => entry.id)).toEqual(expected)

    const game = await new GameLoader(
      new JsonResourceLoader(new EditorWorkspaceResources('game', fetcher), logger),
    ).load()

    expect(game.scenes.get('adventure')?.components.map(({ id }) => id)).toEqual(expected)
    expect((await client.inspect('game')).diagnostics).toEqual([])
  })

  it('persists rename, duplicate, startup selection, component removal, and scene deletion and exports the result', async () => {
    await apply({ type: 'scene.rename', sceneId: 'adventure', newId: 'journey' })
    await expect(workspace.read('game/scenes/adventure.json')).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )
    await apply({ type: 'scene.duplicate', sceneId: 'journey', newId: 'copy', title: 'Copy' })
    await apply({ type: 'game.setInitialScene', sceneId: 'copy' })
    await apply({ type: 'scene.removeComponent', sceneId: 'copy', componentId: 'loop' })
    await apply({ type: 'scene.remove', sceneId: 'journey', replacementScene: 'copy' })
    await expect(workspace.read('game/scenes/journey.json')).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )

    const game = await new GameLoader(
      new JsonResourceLoader(new EditorWorkspaceResources('game', fetcher), logger),
    ).load()

    expect(game.initialScene).toBe('copy')
    expect([...game.scenes.keys()]).toEqual(['start', 'copy'])
    await exportGame({ gameDirectory: join(root, 'game'), outputDirectory: join(root, 'exported') })
    expect(await readFile(join(root, 'exported/game/game.json'), 'utf8')).toContain('copy')
    // Multiple persisted edits and a standalone build share the full suite's worker pool.
  }, 20_000)

  it('protects orphan destinations and rejects stale revisions before changing files', async () => {
    const view = await client.inspect('game')
    await workspace.write('game/scenes/orphan.json', Buffer.from('keep'))
    await expect(
      apply({ type: 'scene.duplicate', sceneId: 'adventure', newId: 'orphan', title: 'Orphan' }),
    ).rejects.toMatchObject({ code: 'scene_exists' })
    expect(Buffer.from(await workspace.read('game/scenes/orphan.json')).toString()).toBe('keep')
    await apply({ type: 'game.setInitialScene', sceneId: 'adventure' })
    await expect(
      client.apply({
        path: 'game',
        expectedRevision: view.revision,
        command: { type: 'scene.rename', sceneId: 'adventure', newId: 'journey' },
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect((await client.inspect('game')).game?.scenes).toContain('adventure')
  })

  it.each(['reference', 'before-manifest', 'after-manifest', 'after-removal'])(
    'handles a storage failure at %s with a consistent saved project',
    async (failure) => {
      let failed = false

      const injected: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: async (path, bytes) => {
          await workspace.removeCreated(path, bytes)

          if (!failed && failure === 'after-removal' && path === 'game/scenes/adventure.json') {
            failed = true
            throw new Error('Injected failure')
          }
        },
        write: async (path, bytes) => {
          if (
            !failed &&
            ((failure === 'reference' && path === 'game/scenes/start.json') ||
              (failure.includes('manifest') && path === 'game/game.json'))
          ) {
            failed = true

            if (failure === 'after-manifest') await workspace.write(path, bytes)
            throw new Error('Injected failure')
          }

          return workspace.write(path, bytes)
        },
      }

      const service = new EditorProjectService(
        new WorkspaceProjectRepository(injected),
        new EditorCoordinator(),
      )

      const before = await service.inspect('game')

      const saving = service.apply({
        path: 'game',
        expectedRevision: before.revision,
        command: { type: 'scene.rename', sceneId: 'adventure', newId: 'journey' },
      })

      if (failure === 'after-removal')
        await expect(saving).resolves.toMatchObject({
          view: { game: { scenes: ['start', 'journey'] } },
        })
      else {
        await expect(saving).rejects.toThrow('Injected failure')
        expect((await service.inspect('game')).revision).toBe(before.revision)
        await expect(workspace.read('game/scenes/journey.json')).rejects.toHaveProperty(
          'code',
          'ENOENT',
        )
      }
    },
  )

  it('keeps external edits when guarded rollback cannot be confirmed', async () => {
    const injected: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, bytes) => workspace.create(path, bytes),
      removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
      write: async (path, bytes) => {
        if (path === 'game/game.json') {
          await workspace.write('game/scenes/start.json', Buffer.from('external edit'))
          throw new Error('Injected failure')
        }

        return workspace.write(path, bytes)
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(injected),
      new EditorCoordinator(),
    )

    const before = await service.inspect('game')
    await expect(
      service.apply({
        path: 'game',
        expectedRevision: before.revision,
        command: { type: 'scene.rename', sceneId: 'adventure', newId: 'journey' },
      }),
    ).rejects.toMatchObject({ code: 'scene_publication_failed' })
    expect(Buffer.from(await workspace.read('game/scenes/start.json')).toString()).toBe(
      'external edit',
    )
  })
})
