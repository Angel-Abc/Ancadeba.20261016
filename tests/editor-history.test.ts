import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStarterProject, type EditorCommand } from '@ancadeba/editor-core'
import { dialogueSchema, questSchema } from '@ancadeba/schemas'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { EditorHistory } from '../apps/editor-server/src/editorHistory.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { restoreHistoryFiles } from '../apps/editor-server/src/historyFiles.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { HttpEditorClient } from '../apps/editor-ui/src/editorClient.js'

describe('saved editor history', () => {
  let root: string
  let workspace: FileWorkspace
  let server: Server
  let client: HttpEditorClient
  let service: EditorProjectService
  let base: string

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-editor-history-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    const documents = createStarterProject({ path: 'game', title: 'History test', description: '' })

    for (const folder of ['game', 'other'])
      for (const [file, data] of Object.entries(documents))
        await workspace.write(
          `${folder}/${file}`,
          Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)),
        )
    service = new EditorProjectService(
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
    base = `http://127.0.0.1:${address.port}`
    client = new HttpEditorClient((url, init) =>
      fetch(new URL(url instanceof Request ? url.url : url, base), init),
    )
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  })

  const apply = async (command: EditorCommand, path = 'game') =>
    client.apply({ path, expectedRevision: (await client.inspect(path)).revision, command })

  const restore = async (direction: 'undo' | 'redo', path = 'game') =>
    client.restore({ path, expectedRevision: (await client.inspect(path)).revision, direction })

  const tree = async (directory = 'game'): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}

    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`

      if (entry.isDirectory()) Object.assign(result, await tree(file))
      else result[file] = (await readFile(join(root, file))).toString('base64')
    }

    return result
  }

  it('copies exact saved component data without saving and pastes a snapshot after its source is removed, with undo and redo', async () => {
    const file = 'game/scenes/adventure.json'
    const source = JSON.parse(Buffer.from(await workspace.read(file)).toString())
    source.components[1].extension = { nested: [{ keep: true }] }
    source.components[1].placement.extension = 'keep'
    await workspace.write(file, Buffer.from(JSON.stringify(source)))
    const view = await client.inspect('game')
    const beforeCopy = await tree()

    const copied = await client.copyComponent({
      path: 'game',
      expectedRevision: view.revision,
      sceneId: 'adventure',
      componentId: 'menu',
    })

    expect(copied.component).toEqual(source.components[1])
    expect(await tree()).toEqual(beforeCopy)
    expect((await client.inspect('game')).history?.canUndo).toBe(false)
    await apply({ type: 'scene.removeComponent', sceneId: 'adventure', componentId: 'menu' })
    const beforePaste = await tree()
    await apply({
      type: 'scene.pasteComponent',
      sceneId: 'start',
      newId: 'pasted',
      component: copied.component,
    })
    const afterPaste = await tree()
    expect(
      (await client.inspect('game')).scenes.find(({ id }) => id === 'start')?.components.at(-1)?.id,
    ).toBe('pasted')
    await restore('undo')
    expect(await tree()).toEqual(beforePaste)
    await restore('redo')
    expect(await tree()).toEqual(afterPaste)
  })

  it('rejects stale or missing copy sources and malformed clipboard responses', async () => {
    const view = await client.inspect('game')
    await apply({ type: 'game.updateMetadata', title: 'Changed', description: '', version: '1' })
    await expect(
      client.copyComponent({
        path: 'game',
        expectedRevision: view.revision,
        sceneId: 'adventure',
        componentId: 'menu',
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    const latest = await client.inspect('game')
    await expect(
      client.copyComponent({
        path: 'game',
        expectedRevision: latest.revision,
        sceneId: 'adventure',
        componentId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'component_not_found' })

    const malformed = new HttpEditorClient(async () =>
      Response.json({ revision: 'one', component: { id: 'invalid' } }),
    )

    await expect(
      malformed.copyComponent({
        path: 'game',
        expectedRevision: 'one',
        sceneId: 'adventure',
        componentId: 'menu',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('undoes and redoes metadata, components, scenes, rules, and story definitions with exact original bytes', async () => {
    const commands: EditorCommand[] = [
      { type: 'game.updateMetadata', title: 'Changed', description: 'A story', version: '2' },
      {
        type: 'scene.duplicateComponent',
        sceneId: 'adventure',
        componentId: 'narrative',
        newId: 'copy',
      },
      { type: 'scene.moveComponent', sceneId: 'adventure', componentId: 'copy', index: 0 },
      { type: 'scene.removeComponent', sceneId: 'adventure', componentId: 'copy' },
      { type: 'scene.rename', sceneId: 'adventure', newId: 'journey' },
      { type: 'scene.duplicate', sceneId: 'journey', newId: 'copy', title: 'Copy' },
      { type: 'game.setInitialScene', sceneId: 'copy' },
      { type: 'scene.remove', sceneId: 'journey', replacementScene: 'copy' },
      {
        type: 'game.updateRules',
        ruleId: 'rules',
        rules: { state: [], actions: { greet: [{ when: [], effects: [] }] } },
      },
      {
        type: 'game.upsertDialogue',
        dialogue: dialogueSchema.parse({
          'schema-version': '1.0.0',
          id: 'guide',
          label: 'Guide',
          entry: 'start',
          nodes: { start: { lines: [{ text: 'Hello' }], choices: [] } },
        }),
      },
      {
        type: 'game.upsertQuest',
        quest: questSchema.parse({
          'schema-version': '1.0.0',
          id: 'visit',
          label: 'Visit',
          stages: [
            {
              id: 'visit',
              objectives: [
                { id: 'arrive', label: 'Arrive', when: [{ type: 'scene-is', scene: 'copy' }] },
              ],
            },
          ],
        }),
      },
    ]

    const checkpoints = [await tree()]
    const initial = await client.inspect('game')
    expect(initial.history).toMatchObject({ canUndo: false, canRedo: false })

    for (const command of commands) {
      expect((await apply(command)).diagnostics).toEqual([])
      checkpoints.push(await tree())
    }

    for (let index = commands.length - 1; index >= 0; index--) {
      const view = await restore('undo')
      expect(view.diagnostics).toEqual([])
      expect(view.history?.canRedo).toBe(true)
      expect(await tree()).toEqual(checkpoints[index])
    }

    expect((await client.inspect('game')).history?.canUndo).toBe(false)

    for (let index = 0; index < commands.length; index++) {
      const view = await restore('redo')
      expect(view.diagnostics).toEqual([])
      expect(await tree()).toEqual(checkpoints[index + 1])
    }

    expect((await client.inspect('game')).history?.canRedo).toBe(false)
    // This round trip performs 33 saves/restores plus byte checks under full-suite filesystem load.
  }, 20_000)

  it('restores imported image bytes and catalogs across replacement imports', async () => {
    const before = await tree()

    const svg = (color: string) =>
      new File(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${color}"/></svg>`,
        ],
        'icon.svg',
        { type: 'image/svg+xml' },
      )

    const upload = async (color: string) =>
      client.importAsset(
        {
          path: 'game',
          expectedRevision: (await client.inspect('game')).revision,
          id: 'icon',
          format: 'svg',
        },
        svg(color),
      )

    await upload('#ff0000')
    const first = await tree()
    await upload('#0000ff')
    const second = await tree()
    await restore('undo')
    expect(await tree()).toEqual(first)
    await restore('undo')
    expect(await tree()).toEqual(before)
    await restore('redo')
    expect(await tree()).toEqual(first)
    await restore('redo')
    expect(await tree()).toEqual(second)
  })

  it('keeps history per project, clears redo after a new change, and ignores rejected changes', async () => {
    await apply({ type: 'game.updateMetadata', title: 'First', description: '', version: '1' })
    await apply(
      { type: 'game.updateMetadata', title: 'Other', description: '', version: '1' },
      'other',
    )
    await expect(
      apply({ type: 'scene.removeComponent', sceneId: 'start', componentId: 'missing' }),
    ).rejects.toMatchObject({ code: 'component_not_found' })
    await restore('undo')
    expect((await client.inspect('game')).game?.title).toBe('History test')
    expect((await client.inspect('other')).game?.title).toBe('Other')
    await apply({ type: 'game.updateMetadata', title: 'Branch', description: '', version: '1' })
    expect((await client.inspect('game')).history).toMatchObject({ canUndo: true, canRedo: false })
    await expect(restore('redo')).rejects.toMatchObject({ code: 'history_empty' })
    await restore('undo', 'other')
    expect((await client.inspect('other')).game?.title).toBe('History test')
  })

  it('rejects stale revisions and clears history after external edits without overwriting them', async () => {
    const before = await client.inspect('game')
    await apply({ type: 'game.updateMetadata', title: 'Changed', description: '', version: '1' })
    await expect(
      client.restore({ path: 'game', expectedRevision: before.revision, direction: 'undo' }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect((await client.inspect('game')).history?.canUndo).toBe(true)
    const bytes = Buffer.from(await workspace.read('game/game.json')).toString()
    await workspace.write('game/game.json', Buffer.from(bytes.replace('Changed', 'External')))
    expect((await client.inspect('game')).history).toMatchObject({ canUndo: false, canRedo: false })
    await expect(restore('undo')).rejects.toMatchObject({ code: 'history_empty' })
    expect((await client.inspect('game')).game?.title).toBe('External')
  })

  it('protects unreferenced files that would be overwritten by undo', async () => {
    await apply({ type: 'scene.rename', sceneId: 'adventure', newId: 'journey' })
    await workspace.write('game/scenes/adventure.json', Buffer.from('external orphan'))
    await expect(restore('undo')).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(Buffer.from(await workspace.read('game/scenes/adventure.json')).toString()).toBe(
      'external orphan',
    )
    expect((await client.inspect('game')).game?.scenes).toContain('journey')
  })

  it('shares server history across clients but starts fresh after a server-service restart', async () => {
    await apply({ type: 'game.updateMetadata', title: 'Changed', description: '', version: '1' })
    expect((await service.inspect('game')).history?.canUndo).toBe(true)

    const fresh = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

    expect((await fresh.inspect('game')).history?.canUndo).toBe(false)
  })

  it('does not undo project creation and rejects malformed history payloads', async () => {
    expect(
      (await client.create({ path: 'new-project', title: 'New', description: '' })).history
        ?.canUndo,
    ).toBe(false)

    const response = await fetch(`${base}/api/editor/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'game',
        expectedRevision: 'one',
        direction: 'undo',
        files: ['game.json'],
      }),
    })

    expect(response.status).toBe(400)
    const wrongType = await fetch(`${base}/api/editor/history`, { method: 'POST', body: '{}' })
    expect(wrongType.status).toBe(415)
  })

  it.each(['before-manifest', 'after-manifest', 'after-delete', 'external'])(
    'handles replay failure at %s without silently overwriting outside changes',
    async (failure) => {
      const original = await workspace.read('game/scenes/adventure.json')
      const manifest = await workspace.read('game/game.json')
      let failed = false

      const injected: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: async (path, bytes) => {
          await workspace.removeCreated(path, bytes)

          if (!failed && failure === 'after-delete') {
            failed = true
            throw new Error('Injected failure')
          }
        },
        write: async (path, bytes) => {
          if (!failed && path === 'game/game.json' && failure !== 'after-delete') {
            failed = true

            if (failure === 'after-manifest') await workspace.write(path, bytes)

            if (failure === 'external')
              await workspace.write('game/scenes/adventure.json', Buffer.from('external'))
            throw new Error('Injected failure')
          }

          return workspace.write(path, bytes)
        },
      }

      const changes = [
        { file: 'scenes/new.json', before: undefined, after: original },
        { file: 'game.json', before: manifest, after: Buffer.from('new manifest') },
        { file: 'scenes/adventure.json', before: original, after: undefined },
      ]

      const saving = restoreHistoryFiles(injected, 'game', changes)

      if (failure === 'after-delete') {
        await expect(saving).resolves.toBeUndefined()
        expect(Buffer.from(await workspace.read('game/game.json')).toString()).toBe('new manifest')
      } else if (failure === 'external') {
        await expect(saving).rejects.toMatchObject({ code: 'history_restore_uncertain' })
        expect(Buffer.from(await workspace.read('game/scenes/adventure.json')).toString()).toBe(
          'external',
        )
      } else {
        await expect(saving).rejects.toThrow('Injected failure')
        expect(await workspace.read('game/game.json')).toEqual(manifest)
        expect(await workspace.read('game/scenes/adventure.json')).toEqual(original)
        await expect(workspace.read('game/scenes/new.json')).rejects.toHaveProperty(
          'code',
          'ENOENT',
        )
      }
    },
  )
})

describe('history bounds', () => {
  it('retains the most recent changes and evicts old projects to meet its byte budget', () => {
    const history = new EditorHistory(2, 8)

    const record = (path: string, previous: string, revision: string) =>
      history.record(
        path,
        previous,
        revision,
        revision,
        { file: Buffer.from('a') },
        { file: Buffer.from('b') },
      )

    record('one', '0', '1')
    record('one', '1', '2')
    record('one', '2', '3')
    history.commit('one', 'undo', '2')
    history.commit('one', 'undo', '1')
    expect(history.status('one', '1').canUndo).toBe(false)
    record('two', '0', '1')
    record('two', '1', '2')
    record('three', '0', '1')
    expect(history.status('one', '1').canRedo).toBe(false)
    expect(history.status('three', '1').canUndo).toBe(true)
  })
})
