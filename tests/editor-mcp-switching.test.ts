import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vite-plus/test'
import { capabilities, object, projectViewSchema } from '@ancadeba/editor-core'
import { createMcpServer } from '../apps/editor-mcp/src/mcpServer.js'
import {
  EditorApiClient,
  EditorApiError,
  type IEditorApi,
} from '../apps/editor-mcp/src/editorApiClient.js'
import { ProjectSession } from '../apps/editor-mcp/src/projectSession.js'
import { projectSwitchResultSchema } from '../apps/editor-mcp/src/protocol.js'

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

function fixture() {
  const calls: { path: string; operation: string }[] = []
  const paths = ['a', 'nested/b', '', 'broken']
  const apis = new Map<string, IEditorApi>()

  const view = (path: string) =>
    projectViewSchema.parse({
      revision: path || 'root',
      game: {
        'schema-version': '1.0.0',
        id: path.replace('/', '-') || 'root',
        title: path || 'Root',
        version: '1',
        scenes: ['room'],
      },
      scenes: [
        {
          'schema-version': '1.0.0',
          id: 'room',
          title: 'Room',
          type: 'game',
          screen: { type: 'grid', grid: { rows: 2, columns: 2 } },
          components: [],
        },
      ],
      diagnostics: [],
      history: { canUndo: path === 'a', canRedo: path === 'nested/b' },
    })

  const record = (path: string, operation: string) => {
    calls.push({ path, operation })
  }

  const api = (path: string): IEditorApi => {
    const cached = apis.get(path)

    if (cached) return cached

    const scoped: IEditorApi = {
      forProject: api,
      capabilities: async () => ({
        ...capabilities,
        features: {
          history: true,
          assetImport: true,
          projectDiscovery: true,
          projectCreation: true,
        },
      }),
      listProjects: async () => {
        record(path, 'list')

        return { projects: paths.map((path) => ({ path, title: path })) }
      },
      createProject: async (input) => {
        record(path, 'create')
        paths.push(input.path)

        return view(input.path)
      },
      inspectGame: async () => {
        record(path, 'inspect')

        return view(path)
      },
      inspectScene: async () => {
        record(path, 'scene')

        return { revision: view(path).revision, scene: view(path).scenes[0]!, diagnostics: [] }
      },
      apply: async (_revision, command) => {
        record(path, command.type)

        return { ...view(path), changedFiles: ['game.json'], summary: 'Saved' }
      },
      restore: async (_revision, direction) => {
        record(path, direction)

        return view(path)
      },
      uploadAsset: async () => {
        record(path, 'upload')

        return { ...view(path), changedFiles: ['assets/art.svg'], summary: 'Imported' }
      },
    }

    apis.set(path, scoped)

    return scoped
  }

  return { api, calls, view, apis }
}

async function connection(api: IEditorApi) {
  const server = createMcpServer(api, 'a')
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'switching-tests', version: '1' })
  await client.connect(clientTransport)

  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('MCP connection project switching', () => {
  it('selects nested/root projects, refreshes the same project and isolates separate connections', async () => {
    const f = fixture()
    const one = await connection(f.api('a'))
    const two = await connection(f.api('a'))

    try {
      for (const [path, previous] of [
        ['nested/b', 'a'],
        ['', 'nested/b'],
        ['', ''],
      ]) {
        const result = await one.client.callTool({
          name: 'ancadeba_switch_project',
          arguments: { path },
        })

        expect(result.isError).toBe(false)
        expect(
          projectSwitchResultSchema.parse(object(result.structuredContent).data),
        ).toMatchObject({ gamePath: path, previousGamePath: previous, revision: path || 'root' })
      }

      expect(
        (await one.client.callTool({ name: 'ancadeba_get_capabilities', arguments: {} }))
          .structuredContent,
      ).toMatchObject({
        data: {
          gamePath: '',
          operations: { projectSwitching: { tool: 'ancadeba_switch_project', supported: true } },
        },
      })
      expect(
        (await one.client.callTool({ name: 'ancadeba_list_projects', arguments: {} }))
          .structuredContent,
      ).toMatchObject({ data: { gamePath: '' } })
      expect(
        (await two.client.callTool({ name: 'ancadeba_inspect_game', arguments: {} }))
          .structuredContent,
      ).toMatchObject({ data: { gamePath: 'a' } })
    } finally {
      await one.close()
      await two.close()
    }
  })

  it('routes all existing-game tools and creation binding metadata to the selected project', async () => {
    const f = fixture()
    const { client, close } = await connection(f.api('a'))

    try {
      await client.callTool({ name: 'ancadeba_switch_project', arguments: { path: 'nested/b' } })
      f.calls.length = 0
      const metadata = { title: 'Changed', description: '', version: '2' }

      for (const operation of [
        {
          name: 'ancadeba_apply_command',
          arguments: { command: { type: 'game.updateMetadata', ...metadata } },
        },
        { name: 'ancadeba_update_game_metadata', arguments: metadata },
        {
          name: 'ancadeba_update_scene_metadata',
          arguments: { sceneId: 'room', title: 'Changed', description: '' },
        },
        {
          name: 'ancadeba_update_scene_layout',
          arguments: { sceneId: 'room', rows: 2, columns: 2 },
        },
        {
          name: 'ancadeba_create_scene',
          arguments: { scene: { ...f.view('nested/b').scenes[0], id: 'new' } },
        },
        {
          name: 'ancadeba_edit_assets',
          arguments: { command: { type: 'assets.remove', kind: 'images', id: 'art' } },
        },
        { name: 'ancadeba_undo', arguments: {} },
        { name: 'ancadeba_redo', arguments: {} },
        {
          name: 'ancadeba_upload_asset',
          arguments: { id: 'art', format: 'svg', dataBase64: 'Zg==' },
        },
      ]) {
        const result = await client.callTool({
          name: operation.name,
          arguments: { ...operation.arguments, expectedRevision: 'nested/b' },
        })

        expect(result.isError, operation.name).toBe(false)
        expect(result.structuredContent).toMatchObject({ data: { gamePath: 'nested/b' } })
      }

      for (const operation of [
        { name: 'ancadeba_inspect_game', arguments: {} },
        { name: 'ancadeba_inspect_assets', arguments: {} },
        { name: 'ancadeba_inspect_scene', arguments: { sceneId: 'room' } },
      ])
        expect((await client.callTool(operation)).structuredContent).toMatchObject({
          data: { gamePath: 'nested/b' },
        })

      const created = await client.callTool({
        name: 'ancadeba_create_project',
        arguments: { path: 'new-game', title: 'New game' },
      })

      expect(created.structuredContent).toMatchObject({
        data: { gamePath: 'new-game', configuredGamePath: 'nested/b' },
      })
      expect(f.calls.every((call) => call.path === 'nested/b')).toBe(true)
    } finally {
      await close()
    }
  })

  it('rejects unsafe, undiscovered and failed targets without changing the active project', async () => {
    const f = fixture()
    f.api('broken').inspectGame = async () => {
      throw new EditorApiError('invalid_response', 'Cannot open target')
    }

    const { client, close } = await connection(f.api('a'))

    try {
      for (const args of [
        { path: '../outside' },
        { path: '/absolute' },
        { path: 'C:\\game' },
        { path: 'nested//b' },
        { path: 'nested/b', editorServerUrl: 'http://other' },
        { path: 'nested/b', expectedRevision: 'a' },
        { path: 'missing' },
        { path: 'broken' },
      ]) {
        expect(
          (await client.callTool({ name: 'ancadeba_switch_project', arguments: args })).isError,
        ).toBe(true)
        expect(
          (await client.callTool({ name: 'ancadeba_inspect_game', arguments: {} }))
            .structuredContent,
        ).toMatchObject({ data: { gamePath: 'a' } })
      }

      expect(f.apis.has('missing')).toBe(false)
    } finally {
      await close()
    }
  })

  it('keeps an in-flight mutation and its result on the original project during a successful switch', async () => {
    const f = fixture()
    const started = deferred<void>()
    const release = deferred<void>()
    const apply = f.api('a').apply.bind(f.api('a'))
    f.api('a').apply = async (...args) => {
      started.resolve()
      await release.promise

      return apply(...args)
    }

    const { client, close } = await connection(f.api('a'))

    try {
      const pending = client.callTool({
        name: 'ancadeba_update_game_metadata',
        arguments: {
          expectedRevision: 'a',
          title: 'Old project edit',
          description: '',
          version: '1',
        },
      })

      await started.promise

      const selected = await client.callTool({
        name: 'ancadeba_switch_project',
        arguments: { path: 'nested/b' },
      })

      expect(selected.isError).toBe(false)
      release.resolve()
      expect((await pending).structuredContent).toMatchObject({ data: { gamePath: 'a' } })
      expect(f.calls.filter((call) => call.operation === 'game.updateMetadata')).toEqual([
        { path: 'a', operation: 'game.updateMetadata' },
      ])
      expect(
        (await client.callTool({ name: 'ancadeba_inspect_game', arguments: {} })).structuredContent,
      ).toMatchObject({ data: { gamePath: 'nested/b' } })
    } finally {
      release.resolve()
      await close()
    }
  })

  it('labels a delayed inspection with its captured project rather than a newer selection', async () => {
    const f = fixture()
    const started = deferred<void>()
    const release = deferred<void>()
    f.api('a').inspectGame = async () => {
      started.resolve()
      await release.promise

      return f.view('a')
    }

    const { client, close } = await connection(f.api('a'))

    try {
      const pending = client.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
      await started.promise
      await client.callTool({ name: 'ancadeba_switch_project', arguments: { path: 'nested/b' } })
      release.resolve()
      expect((await pending).structuredContent).toMatchObject({
        data: { gamePath: 'a', revision: 'a' },
      })
    } finally {
      release.resolve()
      await close()
    }
  })

  it('serializes competing switches and recovers after a queued cancellation', async () => {
    const f = fixture()
    const started = deferred<void>()
    const release = deferred<void>()
    f.api('nested/b').inspectGame = async () => {
      started.resolve()
      await release.promise

      return f.view('nested/b')
    }

    const session = new ProjectSession(f.api('a'), 'a')
    const first = session.switchProject('nested/b')
    await started.promise
    const cancellation = new AbortController()
    const cancelled = session.switchProject('broken', cancellation.signal)
    const root = session.switchProject('')
    cancellation.abort()
    expect(f.calls.some((call) => call.path === '' && call.operation === 'inspect')).toBe(false)
    release.resolve()
    expect(await first).toMatchObject({ gamePath: 'nested/b', previousGamePath: 'a' })
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled', outcome: 'not_applied' })
    expect(await root).toMatchObject({ gamePath: '', previousGamePath: 'nested/b' })
    expect(session.capture().gamePath).toBe('')
  })

  it('checks cancellation after target inspection and permits selecting projects with diagnostics', async () => {
    const f = fixture()
    const cancellation = new AbortController()
    f.api('nested/b').inspectGame = async () => {
      cancellation.abort()

      return f.view('nested/b')
    }

    const session = new ProjectSession(f.api('a'), 'a')
    await expect(session.switchProject('nested/b', cancellation.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(session.capture().gamePath).toBe('a')
    f.api('broken').inspectGame = async () => ({
      ...f.view('broken'),
      game: null,
      diagnostics: [
        { code: 'invalid_json', file: 'game.json', path: [], message: 'Invalid manifest' },
      ],
    })
    expect(await session.switchProject('broken')).toMatchObject({
      gamePath: 'broken',
      game: null,
      diagnostics: [{ code: 'invalid_json' }],
    })
    expect(session.capture().gamePath).toBe('broken')
  })

  it('creates immutable HTTP scopes sharing the fetcher and shutdown signal', async () => {
    const paths: (string | null)[] = []
    const shutdown = new AbortController()

    const client = new EditorApiClient(
      { editorServerUrl: 'http://127.0.0.1:3100', game: 'a', timeoutMs: 200 },
      async function (this: unknown, url) {
        expect(this).toBeUndefined()

        const parsed = new URL(
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        )

        paths.push(parsed.searchParams.get('path'))

        return new Response(JSON.stringify(fixture().view('a')))
      },
      shutdown.signal,
    )

    const other = client.forProject('My Games/b')
    await other.inspectGame()
    await client.inspectGame()
    await client.forProject('').inspectGame()
    expect(paths).toEqual(['My Games/b', 'a', ''])
    expect(() => client.forProject('../outside')).toThrow('workspace-relative')
    shutdown.abort()
    await expect(other.inspectGame()).rejects.toMatchObject({
      code: 'cancelled',
      outcome: 'not_applied',
    })
    expect(paths).toHaveLength(3)
  })
})
