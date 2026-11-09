import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { FileWorkspace, WorkspaceError } from '../apps/editor-server/src/workspace.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { EditorApiClient } from '../apps/editor-mcp/src/editorApiClient.js'
import { createMcpServer } from '../apps/editor-mcp/src/mcpServer.js'
import {
  changeSummarySchema,
  gameSummarySchema,
  historyResultSchema,
  mcpCapabilitiesSchema,
  projectDiscoveryResultSchema,
  projectCreationResultSchema,
} from '../apps/editor-mcp/src/protocol.js'
import { object, type EditorCommand } from '@ancadeba/editor-core'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'

const manifest = {
  'schema-version': '1.0.0',
  id: 'test',
  title: 'Game',
  description: '',
  version: '1',
  scenes: [],
  extension: 'preserved',
}

const scene = {
  'schema-version': '1.0.0' as const,
  id: 'shop',
  title: 'Shop',
  description: '',
  type: 'stand-alone',
  screen: { type: 'grid' as const, grid: { rows: 12, columns: 16 } },
  components: [],
}

describe('MCP and shared editor integration', () => {
  let root: string
  let base: string
  let server: Server
  let client: Client
  let mcp: ReturnType<typeof createMcpServer>
  let repository: WorkspaceProjectRepository
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-editor-mcp-', import.meta.url)))
    await mkdir(join(root, 'basic'))
    await writeFile(join(root, 'basic/game.json'), JSON.stringify(manifest))
    const workspace = await FileWorkspace.open(root)
    repository = new WorkspaceProjectRepository(workspace)
    const projects = new EditorProjectService(repository, new EditorCoordinator())
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      projects,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    // SAFETY: this server is listening on a TCP loopback port, not a Unix socket.
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    mcp = createMcpServer(
      new EditorApiClient({ editorServerUrl: base, game: 'basic', timeoutMs: 2000 }, fetch),
      'basic',
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverTransport)
    client = new Client({ name: 'integration-tests', version: '1' })
    await client.connect(clientTransport)
  })
  afterEach(async () => {
    await client?.close()
    await mcp?.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  })

  async function inspect() {
    const result = await client.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    expect(result.isError).toBe(false)

    // SAFETY: the successful inspect tool wraps our fixture game and revision in data.
    return (
      result.structuredContent as {
        data: { revision: string; game: typeof manifest; diagnostics: unknown[] }
      }
    ).data
  }

  async function game() {
    const result = await client.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    expect(result.isError).toBe(false)

    return gameSummarySchema.parse(object(result.structuredContent).data)
  }

  it('discovers root/nested projects, creates a playable starter and preserves the existing binding', async () => {
    await writeFile(join(root, 'game.json'), JSON.stringify({ ...manifest, title: 'Root game' }))
    await mkdir(join(root, 'nested/other'), { recursive: true })
    await writeFile(
      join(root, 'nested/other/game.json'),
      JSON.stringify({ ...manifest, title: 'Nested game' }),
    )
    const list = await client.callTool({ name: 'ancadeba_list_projects', arguments: {} })
    expect(projectDiscoveryResultSchema.parse(object(list.structuredContent).data)).toMatchObject({
      gamePath: 'basic',
      projects: [
        { path: '', title: 'Root game' },
        { path: 'basic', title: 'Game' },
        { path: 'nested/other', title: 'Nested game' },
      ],
    })
    const before = await readFile(join(root, 'basic/game.json'))

    const created = await client.callTool({
      name: 'ancadeba_create_project',
      arguments: { path: 'new-game', title: 'New adventure', description: 'Created through MCP' },
    })

    expect(created.isError).toBe(false)
    const data = projectCreationResultSchema.parse(object(created.structuredContent).data)
    expect(data).toMatchObject({
      gamePath: 'new-game',
      configuredGamePath: 'basic',
      game: {
        id: 'new-game',
        title: 'New adventure',
        stylesheet: 'theme.css',
        'initial-scene': 'start',
      },
      scenes: [{ id: 'start' }, { id: 'adventure' }],
      diagnostics: [],
    })

    const loaded = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: (file) => readFile(join(root, 'new-game', file), 'utf8'),
          readBytes: async (file) => new Uint8Array(await readFile(join(root, 'new-game', file))),
        },
        { debug: () => '', info: () => '', warn: () => '', error: () => '' },
      ),
    ).load()

    expect(loaded.scenes.size).toBe(2)
    expect(await readFile(join(root, 'basic/game.json'))).toEqual(before)
    expect((await game()).game?.title).toBe('Game')
    const updatedList = await client.callTool({ name: 'ancadeba_list_projects', arguments: {} })
    expect(
      projectDiscoveryResultSchema.parse(object(updatedList.structuredContent).data).projects,
    ).toContainEqual({ path: 'new-game', title: 'New adventure' })
  })

  it('never overwrites existing destinations and allows only one concurrent creation per folder', async () => {
    const before = await readFile(join(root, 'basic/game.json'))
    await mkdir(join(root, 'empty'))

    for (const path of ['basic', 'empty']) {
      const rejected = await client.callTool({
        name: 'ancadeba_create_project',
        arguments: { path, title: 'Replacement' },
      })

      expect(rejected.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'project_exists', outcome: 'not_applied' },
      })
    }

    expect(await readFile(join(root, 'basic/game.json'))).toEqual(before)
    expect(await readdir(join(root, 'empty'))).toEqual([])

    const attempts = await Promise.all(
      [0, 1].map(() =>
        client.callTool({
          name: 'ancadeba_create_project',
          arguments: { path: 'racing', title: 'Winner' },
        }),
      ),
    )

    expect(attempts.filter((result) => !result.isError)).toHaveLength(1)
    expect(attempts.filter((result) => result.isError)[0]?.structuredContent).toMatchObject({
      error: { code: 'project_exists', outcome: 'not_applied' },
    })
    expect(JSON.parse(await readFile(join(root, 'racing/game.json'), 'utf8')).title).toBe('Winner')
  })

  it('bootstraps a configured game that does not exist and can edit it immediately after creation', async () => {
    const bootstrap = createMcpServer(
      new EditorApiClient({ editorServerUrl: base, game: 'future', timeoutMs: 2000 }, fetch),
      'future',
    )

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await bootstrap.connect(serverTransport)
    const starter = new Client({ name: 'bootstrap-tests', version: '1' })
    await starter.connect(clientTransport)

    try {
      const listed = await starter.callTool({ name: 'ancadeba_list_projects', arguments: {} })
      expect(listed.isError).toBe(false)

      const created = await starter.callTool({
        name: 'ancadeba_create_project',
        arguments: { path: 'future', title: 'Future' },
      })

      expect(created.isError).toBe(false)
      const data = projectCreationResultSchema.parse(object(created.structuredContent).data)
      expect(data).toMatchObject({ gamePath: 'future', configuredGamePath: 'future' })

      const saved = await starter.callTool({
        name: 'ancadeba_apply_command',
        arguments: {
          expectedRevision: data.revision,
          command: {
            type: 'game.updateMetadata',
            title: 'Edited starter',
            description: '',
            version: '1',
          },
        },
      })

      expect(saved.isError).toBe(false)
      expect(JSON.parse(await readFile(join(root, 'future/game.json'), 'utf8')).title).toBe(
        'Edited starter',
      )
      expect((await game()).game?.title).toBe('Game')
    } finally {
      await starter.close()
      await bootstrap.close()
    }
  })

  it('recovers uncertain creation by listing the requested folder without automatic retries', async () => {
    const load = repository.load.bind(repository)
    const create = vi.spyOn(repository, 'create')

    const failure = vi.spyOn(repository, 'load').mockImplementation(async (path) => {
      if (path === 'uncertain') throw new WorkspaceError(404, 'Reread failed')

      return load(path)
    })

    try {
      const result = await client.callTool({
        name: 'ancadeba_create_project',
        arguments: { path: 'uncertain', title: 'Saved starter' },
      })

      expect(result.structuredContent).toMatchObject({
        error: {
          code: 'project_creation_uncertain',
          outcome: 'unknown',
          recovery: expect.stringContaining('"uncertain"'),
        },
      })
      expect(create).toHaveBeenCalledTimes(1)
      const list = await client.callTool({ name: 'ancadeba_list_projects', arguments: {} })
      expect(
        projectDiscoveryResultSchema.parse(object(list.structuredContent).data).projects,
      ).toContainEqual({ path: 'uncertain', title: 'Saved starter' })
      expect((await game()).game?.title).toBe('Game')
    } finally {
      failure.mockRestore()
      create.mockRestore()
    }
  })

  async function restore(direction: 'undo' | 'redo', revision: string) {
    const result = await client.callTool({
      name: direction === 'undo' ? 'ancadeba_undo' : 'ancadeba_redo',
      arguments: { expectedRevision: revision },
    })

    expect(result.isError).toBe(false)

    return historyResultSchema.parse(object(result.structuredContent).data)
  }

  it('discovers live history/upload support and replays saved changes from other editor clients', async () => {
    const discovery = await client.callTool({ name: 'ancadeba_get_capabilities', arguments: {} })
    expect(mcpCapabilitiesSchema.parse(object(discovery.structuredContent).data)).toMatchObject({
      features: { history: true, assetImport: true },
      operations: {
        undo: { supported: true },
        redo: { supported: true },
        assetUpload: { supported: true, maxMultipartBytes: 10 * 1024 * 1024 },
      },
    })
    const initial = await game()
    expect(initial.history).toMatchObject({ canUndo: false, canRedo: false })
    const before = await readFile(join(root, 'basic/game.json'))

    const saved = await fetch(`${base}/api/editor/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'basic',
        expectedRevision: initial.revision,
        command: {
          type: 'game.updateMetadata',
          title: 'Human edit',
          description: '',
          version: '1',
        },
      }),
    })

    expect(saved.status).toBe(200)
    const human = await game()
    expect(human.history).toMatchObject({ canUndo: true, undoLabel: 'Updated game metadata' })
    const undone = await restore('undo', human.revision)
    expect(undone).toMatchObject({ direction: 'undo', history: { canUndo: false, canRedo: true } })
    expect(await readFile(join(root, 'basic/game.json'))).toEqual(before)
    const redone = await restore('redo', undone.revision)
    expect(redone.history).toMatchObject({ canUndo: true, canRedo: false })
    expect((await game()).game?.title).toBe('Human edit')
    const again = await restore('undo', redone.revision)

    const branch = await client.callTool({
      name: 'ancadeba_apply_command',
      arguments: {
        expectedRevision: again.revision,
        command: {
          type: 'game.updateMetadata',
          title: 'New branch',
          description: '',
          version: '1',
        },
      },
    })

    expect(branch.isError).toBe(false)
    const fresh = await game()

    const empty = await client.callTool({
      name: 'ancadeba_redo',
      arguments: { expectedRevision: fresh.revision },
    })

    expect(empty.structuredContent).toMatchObject({
      error: { code: 'history_empty', outcome: 'not_applied' },
    })
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({ ...manifest, title: 'External edit' }),
    )

    const stale = await client.callTool({
      name: 'ancadeba_undo',
      arguments: { expectedRevision: fresh.revision },
    })

    expect(stale.structuredContent).toMatchObject({
      error: { code: 'revision_conflict', outcome: 'not_applied' },
    })
    const external = await game()
    expect(external.history).toMatchObject({ canUndo: false, canRedo: false })

    const noHistory = await client.callTool({
      name: 'ancadeba_undo',
      arguments: { expectedRevision: external.revision },
    })

    expect(noHistory.structuredContent).toMatchObject({
      error: { code: 'history_empty', outcome: 'not_applied' },
    })
    expect((await game()).game?.title).toBe('External edit')
  })

  it('uploads and replaces SVG sources with exact bytes and restores them through undo/redo', async () => {
    const first =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 10"><!-- Café -->\r\n<rect width="12" height="10" fill="#112233"/></svg>'

    const second =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20"><rect width="24" height="20" fill="#112233"/></svg>'

    const manifestBytes = await readFile(join(root, 'basic/game.json'))

    const upload = async (svg: string) => {
      const result = await client.callTool({
        name: 'ancadeba_upload_asset',
        arguments: {
          expectedRevision: (await game()).revision,
          id: 'art',
          format: 'svg',
          dataBase64: Buffer.from(svg).toString('base64'),
        },
      })

      expect(result.isError).toBe(false)

      return game()
    }

    const created = await upload(first)
    const firstPath = created.assets!.images.art!.source
    expect(created.assets!.images.art!.bounds).toMatchObject({ width: 12, height: 10 })
    expect(await readFile(join(root, 'basic', firstPath), 'utf8')).toBe(first)
    expect(created.history?.undoLabel).toBe('Imported image art')
    const replaced = await upload(second)
    const secondPath = replaced.assets!.images.art!.source
    expect(secondPath).not.toBe(firstPath)
    expect(await readFile(join(root, 'basic', firstPath), 'utf8')).toBe(first)
    const undone = await restore('undo', replaced.revision)
    expect((await game()).assets!.images.art!.source).toBe(firstPath)
    await expect(readFile(join(root, 'basic', secondPath))).rejects.toHaveProperty('code', 'ENOENT')
    const redone = await restore('redo', undone.revision)
    expect(await readFile(join(root, 'basic', secondPath), 'utf8')).toBe(second)
    const original = await restore('undo', redone.revision)
    await restore('undo', original.revision)
    expect((await game()).assets).toBeUndefined()
    expect(await readFile(join(root, 'basic/game.json'))).toEqual(manifestBytes)
    await expect(readFile(join(root, 'basic', firstPath))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('uploads binary PNG bytes and rejects invalid images or stale uploads without publishing files', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlyIAAAAASUVORK5CYII=',
      'base64',
    )

    const initial = await game()

    const uploaded = await client.callTool({
      name: 'ancadeba_upload_asset',
      arguments: {
        expectedRevision: initial.revision,
        id: 'pixel',
        format: 'png',
        dataBase64: png.toString('base64'),
      },
    })

    expect(uploaded.isError).toBe(false)
    const saved = await game()
    expect(saved.assets!.images.pixel!.bounds).toMatchObject({ width: 1, height: 1 })
    expect(await readFile(join(root, 'basic', saved.assets!.images.pixel!.source))).toEqual(png)
    const files = await readdir(join(root, 'basic/assets/images'))

    const stale = await client.callTool({
      name: 'ancadeba_upload_asset',
      arguments: {
        expectedRevision: initial.revision,
        id: 'stale',
        format: 'png',
        dataBase64: png.toString('base64'),
      },
    })

    expect(stale.structuredContent).toMatchObject({
      error: { code: 'revision_conflict', outcome: 'not_applied' },
    })

    const invalid = await client.callTool({
      name: 'ancadeba_upload_asset',
      arguments: {
        expectedRevision: saved.revision,
        id: 'invalid',
        format: 'jpeg',
        dataBase64: png.toString('base64'),
      },
    })

    expect(invalid.structuredContent).toMatchObject({
      error: { code: 'invalid_asset', outcome: 'not_applied' },
    })
    expect(await readdir(join(root, 'basic/assets/images'))).toEqual(files)
    expect((await game()).revision).toBe(saved.revision)
  })

  it('reports uncertain history and upload results when the post-write reread fails', async () => {
    const saved = await client.callTool({
      name: 'ancadeba_update_game_metadata',
      arguments: {
        expectedRevision: (await game()).revision,
        title: 'Changed',
        description: '',
        version: '1',
      },
    })

    expect(saved.isError).toBe(false)
    const revision = (await game()).revision
    const load = repository.load.bind(repository)
    let reads = 0

    const failure = vi.spyOn(repository, 'load').mockImplementation(async (folder) => {
      if (++reads === 2) throw new WorkspaceError(404, 'Reread failed')

      return load(folder)
    })

    try {
      const result = await client.callTool({
        name: 'ancadeba_undo',
        arguments: { expectedRevision: revision },
      })

      expect(result.structuredContent).toMatchObject({
        error: { code: 'history_restore_failed', outcome: 'unknown' },
      })
      expect(JSON.parse(await readFile(join(root, 'basic/game.json'), 'utf8')).title).toBe('Game')
    } finally {
      failure.mockRestore()
    }

    const fresh = await game()
    reads = 0

    const uploadFailure = vi.spyOn(repository, 'load').mockImplementation(async (folder) => {
      if (++reads === 2) throw new WorkspaceError(404, 'Reread failed')

      return load(folder)
    })

    try {
      const result = await client.callTool({
        name: 'ancadeba_upload_asset',
        arguments: {
          expectedRevision: fresh.revision,
          id: 'art',
          format: 'svg',
          dataBase64: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
          ).toString('base64'),
        },
      })

      expect(result.structuredContent).toMatchObject({
        error: { code: 'not_found', outcome: 'unknown' },
      })
      const catalog = JSON.parse(await readFile(join(root, 'basic/assets/catalogue.json'), 'utf8'))
      expect(catalog.images.art).toBeDefined()
    } finally {
      uploadFailure.mockRestore()
    }
  })

  it('creates and edits saved scenes visible through the visual editor HTTP contract', async () => {
    let revision = (await inspect()).revision

    const operations = [
      { name: 'ancadeba_create_scene', arguments: { scene } },
      {
        name: 'ancadeba_update_scene_layout',
        arguments: { sceneId: 'shop', rows: 18, columns: 24 },
      },
      {
        name: 'ancadeba_update_scene_metadata',
        arguments: { sceneId: 'shop', title: 'Village shop', description: 'Supplies' },
      },
      {
        name: 'ancadeba_update_game_metadata',
        arguments: { title: 'MCP game', description: '', version: '2' },
      },
    ]

    for (const operation of operations) {
      const result = await client.callTool({
        name: operation.name,
        arguments: { ...operation.arguments, expectedRevision: revision },
      })

      expect(result.isError).toBe(false)
      // SAFETY: each successful mutation returns the newly saved revision in data.
      const data = (result.structuredContent as { data: { revision: string } }).data
      expect(data.revision).not.toBe(revision)
      revision = data.revision
    }

    const view = await (await fetch(`${base}/api/editor/project?path=basic`)).json()
    expect(view).toMatchObject({
      revision,
      game: { title: 'MCP game', scenes: ['shop'] },
      scenes: [{ title: 'Village shop', screen: { grid: { rows: 18, columns: 24 } } }],
      diagnostics: [],
    })
    expect(JSON.parse(await readFile(join(root, 'basic/game.json'), 'utf8')).extension).toBe(
      'preserved',
    )
  })
  it('rejects a stale MCP edit after a raw HTTP edit and permits an inspected deliberate retry', async () => {
    const stale = (await inspect()).revision
    await fetch(`${base}/api/files?path=basic/game.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...manifest, title: 'Human edit' }),
    })

    const command = {
      type: 'game.updateMetadata',
      title: 'Reviewed change',
      description: '',
      version: '1',
    }

    const failed = await client.callTool({
      name: 'ancadeba_apply_command',
      arguments: { expectedRevision: stale, command },
    })

    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toMatchObject({
      error: { code: 'revision_conflict', status: 409 },
    })
    const fresh = await inspect()
    expect(fresh.game.title).toBe('Human edit')

    const retried = await client.callTool({
      name: 'ancadeba_apply_command',
      arguments: { expectedRevision: fresh.revision, command },
    })

    expect(retried.isError).toBe(false)
    expect((await inspect()).game.title).toBe('Reviewed change')
  })

  it('authors gameplay, maps, localization, text bindings and CSS through revision-checked MCP commands', async () => {
    let revision = (await inspect()).revision
    const css = '/* Exact CSS text */\r\n.ancadeba-scene { color: #abcdef; }\r\n'

    const commands: EditorCommand[] = [
      { type: 'scene.create', scene: { ...scene, type: 'game' } },
      {
        type: 'game.updateRules',
        ruleId: 'world',
        rules: { state: [{ path: ['gold'], value: 10 }], actions: {} },
      },
      {
        type: 'game.upsertInventory',
        inventoryId: 'items',
        createOnly: true,
        inventory: {
          'schema-version': '1.0.0',
          itemTypes: {
            coin: {
              label: 'Coin',
              description: '',
              properties: [],
              container: false,
              equipmentSlots: [],
            },
          },
          owners: { hero: { label: 'Hero', equipmentSlots: {} } },
          items: {
            coin1: { itemType: 'coin', placement: { type: 'carried', owner: 'hero' }, colors: {} },
          },
        },
      },
      {
        type: 'game.upsertMap',
        mapId: 'garden',
        createOnly: true,
        map: {
          'schema-version': '1.0.0',
          type: 'square-grid',
          width: 1,
          height: 1,
          terrain: { grass: { color: '#608c4f' } },
          tiles: [['grass']],
          layers: [{ id: 'objects', tiles: [[null]], visible: true, collision: false }],
        },
      },
      {
        type: 'game.updateInput',
        inputId: 'keys',
        input: {
          'schema-version': '1.0.0',
          'virtual-keys': ['primary'],
          keyboard: { KeyQ: 'primary' },
          contexts: { gameplay: { primary: 'act' } },
          'initial-context': 'gameplay',
        },
      },
      {
        type: 'game.updateLocalization',
        languages: { default: 'en', available: ['en', 'nl'] },
        catalogs: { en: { title: 'My game' }, nl: { title: 'Mijn spel' } },
      },
      {
        type: 'scene.upsertComponent',
        sceneId: 'shop',
        createOnly: true,
        component: {
          id: 'gold',
          type: 'text',
          text: 'Gold: {{gold}}',
          bindings: { gold: { source: 'game.state', path: ['gold'] } },
          presentation: { variant: 'body', align: 'start' },
          placement: { row: 1, column: 1, rowSpan: 1, columnSpan: 1 },
        },
      },
      {
        type: 'scene.duplicateComponent',
        sceneId: 'shop',
        componentId: 'gold',
        newId: 'gold-copy',
      },
      { type: 'scene.moveComponent', sceneId: 'shop', componentId: 'gold-copy', index: 0 },
      { type: 'scene.removeComponent', sceneId: 'shop', componentId: 'gold-copy' },
      { type: 'scene.rename', sceneId: 'shop', newId: 'market' },
      { type: 'game.setInitialScene', sceneId: 'market' },
      { type: 'game.upsertStylesheet', file: 'styles/custom.css', css, createOnly: true },
    ]

    for (const command of commands) {
      const result = await client.callTool({
        name: 'ancadeba_apply_command',
        arguments: { expectedRevision: revision, command },
      })

      expect(result.isError, command.type).toBe(false)
      revision = changeSummarySchema.parse(object(result.structuredContent).data).revision
    }

    const metadata = await client.callTool({
      name: 'ancadeba_update_game_metadata',
      arguments: {
        expectedRevision: revision,
        title: '',
        description: '',
        version: '2',
        titleKey: 'title',
      },
    })

    expect(metadata.isError).toBe(false)
    const result = await client.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    const data = gameSummarySchema.parse(object(result.structuredContent).data)
    expect(data).toMatchObject({
      game: { titleKey: 'title', 'initial-scene': 'market', stylesheet: 'styles/custom.css' },
      rules: { state: [{ path: ['gold'], value: 10 }] },
      inventoryFiles: { items: { items: { coin1: { itemType: 'coin' } } } },
      maps: { garden: { layers: [{ id: 'objects' }] } },
      input: { keyboard: { KeyQ: 'primary' } },
      languageCatalogs: { nl: { title: 'Mijn spel' } },
      stylesheets: { 'styles/custom.css': css },
      diagnostics: [],
    })
    expect(await readFile(join(root, 'basic/styles/custom.css'), 'utf8')).toBe(css)
    const savedScene = JSON.parse(await readFile(join(root, 'basic/scenes/market.json'), 'utf8'))
    expect(savedScene.components).toMatchObject([
      { id: 'gold', bindings: { gold: { source: 'game.state', path: ['gold'] } } },
    ])

    const duplicate = await client.callTool({
      name: 'ancadeba_apply_command',
      arguments: {
        expectedRevision: data.revision,
        command: {
          type: 'scene.upsertComponent',
          sceneId: 'market',
          component: savedScene.components[0],
          createOnly: true,
        },
      },
    })

    expect(duplicate.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'component_exists', outcome: 'not_applied' },
    })
    expect((await inspect()).revision).toBe(data.revision)

    const duplicateMap = await client.callTool({
      name: 'ancadeba_apply_command',
      arguments: {
        expectedRevision: data.revision,
        command: commands.find((entry) => entry.type === 'game.upsertMap'),
      },
    })

    // The server declares the outcome, so the adapter needs no per-code rejection list.
    expect(duplicateMap.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'map_exists', status: 409, outcome: 'not_applied' },
    })
    expect((await inspect()).revision).toBe(data.revision)
  })

  it('round-trips bound text scenes and rejects layout changes that would clip their components', async () => {
    const textScene = {
      ...scene,
      type: 'game',
      components: [
        {
          id: 'score',
          type: 'text',
          placement: { row: 12, column: 16, rowSpan: 1, columnSpan: 1 },
          text: 'Score: {{score}}',
          bindings: { score: { source: 'game.state', path: ['score'], fallback: '0' } },
          presentation: { variant: 'body', align: 'end' },
        },
      ],
    }

    const created = await client.callTool({
      name: 'ancadeba_create_scene',
      arguments: { expectedRevision: (await inspect()).revision, scene: textScene },
    })

    expect(created.isError).toBe(false)
    const initial = await inspect()

    const inspected = await client.callTool({
      name: 'ancadeba_inspect_scene',
      arguments: { sceneId: 'shop' },
    })

    expect(inspected.isError).toBe(false)
    expect(inspected.structuredContent).toMatchObject({
      data: { revision: initial.revision, scene: textScene },
    })
    const before = await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')

    const invalid = await client.callTool({
      name: 'ancadeba_update_scene_layout',
      arguments: { expectedRevision: initial.revision, sceneId: 'shop', rows: 11, columns: 16 },
    })

    expect(invalid.isError).toBe(true)
    expect(invalid.structuredContent).toMatchObject({
      error: { code: 'invalid_project', outcome: 'not_applied' },
    })
    expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe(before)
    expect((await inspect()).revision).toBe(initial.revision)

    const updated = await client.callTool({
      name: 'ancadeba_update_scene_metadata',
      arguments: {
        expectedRevision: initial.revision,
        sceneId: 'shop',
        title: 'Scoreboard',
        description: 'Current score',
      },
    })

    expect(updated.isError).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8'))).toEqual({
      ...textScene,
      title: 'Scoreboard',
      description: 'Current score',
    })
  })
  it('returns project diagnostics and blocks mutations until invalid saved files are repaired', async () => {
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({ ...manifest, scenes: ['missing'] }),
    )
    const invalid = await inspect()
    expect(invalid.diagnostics).toMatchObject([
      { code: 'missing_file', file: 'scenes/missing.json' },
    ])

    const result = await client.callTool({
      name: 'ancadeba_update_game_metadata',
      arguments: { expectedRevision: invalid.revision, title: 'X', description: '', version: '1' },
    })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'invalid_project', diagnostics: [{ file: 'scenes/missing.json' }] },
    })
  })

  it('reports an uncertain outcome when saving succeeded but the server reread fails with a workspace 404', async () => {
    const initial = await inspect()
    const load = repository.load.bind(repository)
    let loads = 0

    const failure = vi.spyOn(repository, 'load').mockImplementation(async (folder) => {
      loads++

      if (loads === 2) throw new WorkspaceError(404, 'Resource not found')

      return load(folder)
    })

    try {
      const result = await client.callTool({
        name: 'ancadeba_apply_command',
        arguments: {
          expectedRevision: initial.revision,
          command: {
            type: 'game.updateMetadata',
            title: 'Saved before reread failure',
            description: '',
            version: '1',
          },
        },
      })

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code: 'not_found', status: 404, outcome: 'unknown' },
      })
      expect(JSON.parse(await readFile(join(root, 'basic/game.json'), 'utf8')).title).toBe(
        'Saved before reread failure',
      )
      expect(loads).toBe(2)
    } finally {
      failure.mockRestore()
    }

    expect((await inspect()).game.title).toBe('Saved before reread failure')
  })
})
