import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { basicComponentSchema, object } from '@ancadeba/editor-core'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { HttpEditorClient } from '../apps/editor-ui/src/editorClient.js'
import { EditorWorkspaceResources } from '../apps/editor-ui/src/workspaceResources.js'

const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
const placement = { row: 1, column: 1 }

describe('scene component authoring API', () => {
  let root: string
  let workspace: FileWorkspace
  let server: Server
  let client: HttpEditorClient
  let fetcher: typeof fetch

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-component-authoring-', import.meta.url)))
    workspace = await FileWorkspace.open(root)

    const projects = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

    await projects.create({ path: 'game', title: 'Authoring test' })

    const manifest = object(
      JSON.parse(Buffer.from(await workspace.read('game/game.json')).toString('utf8')),
    )

    await workspace.write(
      'game/game.json',
      Buffer.from(
        JSON.stringify({
          ...manifest,
          maps: ['coast'],
          languages: { default: 'en', available: ['en', 'nl'] },
        }),
      ),
    )
    await workspace.write(
      'game/maps/coast.json',
      Buffer.from(
        JSON.stringify({
          'schema-version': '1.0.0',
          type: 'square-grid',
          width: 2,
          height: 2,
          terrain: { grass: { color: '#00ff00' } },
          tiles: [
            ['grass', 'grass'],
            ['grass', 'grass'],
          ],
        }),
      ),
    )
    await workspace.write(
      'game/languages/en/messages.json',
      Buffer.from('{"language.name":"English"}'),
    )
    await workspace.write(
      'game/languages/nl/messages.json',
      Buffer.from('{"language.name":"Nederlands"}'),
    )
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      projects,
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

  it('creates all four component types in saved scenes and loads their runtime data', async () => {
    let view = await client.inspect('game')

    const components = [
      { id: 'text', type: 'text', text: 'New narrative', placement },
      {
        id: 'button',
        type: 'button',
        label: 'Start again',
        action: { type: 'new-game', scene: 'adventure' },
        placement,
      },
      {
        id: 'map',
        type: 'map-view',
        map: 'coast',
        label: 'Coast',
        viewport: { columns: 2, rows: 2 },
        playerSpawn: { x: 1, y: 1 },
        placement,
      },
      { id: 'language', type: 'language-select', label: 'Language', placement },
    ]

    for (const component of components)
      view = await client.apply({
        path: 'game',
        expectedRevision: view.revision,
        command: {
          type: 'scene.upsertComponent',
          sceneId: 'adventure',
          createOnly: true,
          component: basicComponentSchema.parse(component),
        },
      })

    expect(view.diagnostics).toEqual([])

    const game = await new GameLoader(
      new JsonResourceLoader(new EditorWorkspaceResources('game', fetcher), logger),
    ).load()

    expect(game.scenes.get('adventure')?.components.map(({ id }) => id)).toEqual([
      'narrative',
      'menu',
      'text',
      'button',
      'map',
      'language',
    ])
    expect(game.localization?.available.map(({ tag }) => tag)).toEqual(['en', 'nl'])
    expect(game.scenes.get('adventure')?.components.find(({ id }) => id === 'map')).toMatchObject({
      map: { width: 2, height: 2 },
      playerSpawn: { x: 1, y: 1 },
    })
  })

  it('rejects existing IDs and stale revisions without replacing saved components', async () => {
    const view = await client.inspect('game')
    const before = await readFile(join(root, 'game/scenes/adventure.json'), 'utf8')

    const component = basicComponentSchema.parse({
      id: 'narrative',
      type: 'text',
      text: 'Replacement',
      placement,
    })

    await expect(
      client.apply({
        path: 'game',
        expectedRevision: view.revision,
        command: {
          type: 'scene.upsertComponent',
          sceneId: 'adventure',
          createOnly: true,
          component,
        },
      }),
    ).rejects.toMatchObject({ code: 'component_exists' })
    expect(await readFile(join(root, 'game/scenes/adventure.json'), 'utf8')).toBe(before)
    await client.apply({
      path: 'game',
      expectedRevision: view.revision,
      command: {
        type: 'scene.upsertComponent',
        sceneId: 'adventure',
        createOnly: true,
        component: { ...component, id: 'new-text' },
      },
    })
    await expect(
      client.apply({
        path: 'game',
        expectedRevision: view.revision,
        command: {
          type: 'scene.upsertComponent',
          sceneId: 'adventure',
          createOnly: true,
          component: { ...component, id: 'another' },
        },
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it.each([
    {
      id: 'invalid',
      type: 'button',
      label: 'Missing',
      placement,
      action: { type: 'enter-scene', scene: 'missing' },
    },
    {
      id: 'invalid',
      type: 'button',
      label: 'Wrong type',
      placement,
      action: { type: 'new-game', scene: 'start' },
    },
    {
      id: 'invalid',
      type: 'map-view',
      label: 'Missing map',
      placement,
      map: 'missing',
      viewport: { columns: 1, rows: 1 },
    },
    {
      id: 'invalid',
      type: 'map-view',
      label: 'Too large',
      placement,
      map: 'coast',
      viewport: { columns: 3, rows: 1 },
    },
    { id: 'invalid', type: 'text', text: 'Outside grid', placement: { row: 13, column: 1 } },
  ])(
    'rejects invalid component settings without publishing them: $type $label',
    async (definition) => {
      const view = await client.inspect('game')
      const before = await readFile(join(root, 'game/scenes/adventure.json'), 'utf8')
      await expect(
        client.apply({
          path: 'game',
          expectedRevision: view.revision,
          command: {
            type: 'scene.upsertComponent',
            sceneId: 'adventure',
            createOnly: true,
            component: basicComponentSchema.parse(definition),
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid_project' })
      expect(await readFile(join(root, 'game/scenes/adventure.json'), 'utf8')).toBe(before)
      expect((await client.inspect('game')).revision).toBe(view.revision)
    },
  )
})
