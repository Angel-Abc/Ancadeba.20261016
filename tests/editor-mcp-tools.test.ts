import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vite-plus/test'
import { capabilities, commandSchema, object, type EditorCommand } from '@ancadeba/editor-core'
import { mcpCapabilitiesSchema } from '../apps/editor-mcp/src/protocol.js'
import { createMcpServer } from '../apps/editor-mcp/src/mcpServer.js'
import { EditorApiError, type IEditorApi } from '../apps/editor-mcp/src/editorApiClient.js'

const scene = {
  'schema-version': '1.0.0' as const,
  id: 'shop',
  title: 'Shop',
  description: 'Scene detail',
  type: 'stand-alone' as const,
  screen: { type: 'grid' as const, grid: { rows: 12, columns: 16 } },
  components: [],
}

const view = {
  revision: 'one',
  game: {
    'schema-version': '1.0.0' as const,
    id: 'test',
    title: 'Game',
    description: '',
    version: '1',
    scenes: ['shop'],
  },
  scenes: [scene],
  diagnostics: [],
}

async function connection(api: IEditorApi) {
  const server = createMcpServer(api, 'basic')
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'adapter-tests', version: '1' })
  await client.connect(clientTransport)

  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function api(): IEditorApi {
  return {
    capabilities: async () => capabilities,
    inspectGame: async () => view,
    inspectScene: async () => ({ revision: view.revision, scene, diagnostics: [] }),
    apply: async () => ({
      ...view,
      revision: 'two',
      changedFiles: ['game.json'],
      summary: 'Saved',
    }),
  }
}

describe('MCP adapter tools', () => {
  it('exposes typed catalogue inspection and normalized graphic authoring commands', async () => {
    const service = api()
    let applied: EditorCommand | undefined
    const original = service.apply.bind(service)
    service.apply = async (revision, command, signal) => {
      applied = command

      return original(revision, command, signal)
    }

    const { client, close } = await connection(service)

    try {
      const inspection = await client.callTool({ name: 'ancadeba_inspect_assets', arguments: {} })
      expect(inspection.structuredContent).toMatchObject({
        ok: true,
        data: { gamePath: 'basic', revision: 'one', diagnostics: [] },
      })

      const result = await client.callTool({
        name: 'ancadeba_edit_assets',
        arguments: {
          expectedRevision: 'one',
          command: {
            type: 'assets.upsertImage',
            id: 'art',
            image: {
              format: 'svg',
              source: 'assets/art.svg',
              bounds: { x: 0, y: 0, width: 20, height: 30 },
              colors: { fabric: '#ABCDEF' },
            },
          },
        },
      })

      expect(result.structuredContent).toMatchObject({ ok: true, data: { revision: 'two' } })
      expect(applied).toMatchObject({
        type: 'assets.upsertImage',
        image: { colors: { fabric: '#abcdef' }, palettes: {} },
      })
    } finally {
      await close()
    }
  })
  it('discovers typed tools with read-only annotations and compact structured results', async () => {
    const { client, close } = await connection(api())

    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b))).toEqual([
        'ancadeba_apply_command',
        'ancadeba_create_scene',
        'ancadeba_edit_assets',
        'ancadeba_get_capabilities',
        'ancadeba_inspect_assets',
        'ancadeba_inspect_game',
        'ancadeba_inspect_scene',
        'ancadeba_update_game_metadata',
        'ancadeba_update_scene_layout',
        'ancadeba_update_scene_metadata',
      ])
      expect(tools.filter((tool) => tool.annotations?.readOnlyHint)).toHaveLength(4)

      for (const tool of tools) {
        expect(tool.outputSchema).toHaveProperty('type', 'object')
        expect(tool.inputSchema).toHaveProperty('additionalProperties', false)

        if (!tool.annotations?.readOnlyHint)
          expect(tool.inputSchema.required).toContain('expectedRevision')
      }

      const result = await client.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: { revision: 'one', gamePath: 'basic', scenes: [{ id: 'shop', title: 'Shop' }] },
      })
      expect(JSON.stringify(result.structuredContent)).not.toContain('Scene detail')
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(result.structuredContent) },
      ])

      const detail = await client.callTool({
        name: 'ancadeba_inspect_scene',
        arguments: { sceneId: 'shop' },
      })

      expect(detail.structuredContent).toMatchObject({
        data: { scene: { description: 'Scene detail' } },
      })
      const capability = await client.callTool({ name: 'ancadeba_get_capabilities', arguments: {} })
      expect(capability.structuredContent).toMatchObject({
        data: { version: 1, gamePath: 'basic' },
      })
    } finally {
      await close()
    }
  })
  it('dispatches every advertised editor command through the typed generic tool', async () => {
    expect(new Set(capabilities.commands.map(({ type }) => type))).toEqual(
      new Set(commandSchema.options.map((option) => option.shape.type.value)),
    )

    const remote = api()
    const calls: EditorCommand[] = []
    remote.apply = async (revision, command, signal) => {
      expect(revision).toBe('one')
      expect(signal).toBeInstanceOf(AbortSignal)
      calls.push(command)

      return { ...view, revision: 'two', changedFiles: ['game.json'], summary: 'Saved' }
    }

    const { client, close } = await connection(remote)

    try {
      const discovery = await client.callTool({ name: 'ancadeba_get_capabilities', arguments: {} })
      const supported = mcpCapabilitiesSchema.parse(object(discovery.structuredContent).data)
      expect(supported.commands).toEqual(capabilities.commands)

      for (const { type, example } of capabilities.commands) {
        const result = await client.callTool({
          name: 'ancadeba_apply_command',
          arguments: { expectedRevision: 'one', command: example },
        })

        expect(result.isError, type).toBe(false)
        expect(calls.at(-1)).toEqual(commandSchema.parse(example))
        expect(result.structuredContent).toMatchObject({
          ok: true,
          data: { revision: 'two', gamePath: 'basic' },
        })
      }

      expect(calls.map(({ type }) => type)).toEqual(capabilities.commands.map(({ type }) => type))
    } finally {
      await close()
    }
  })

  it('discovers the command intersection with MCP arguments and canonical local examples', async () => {
    const remote = api()
    remote.capabilities = async () => ({
      ...capabilities,
      commands: [
        { type: 'future.command', example: { type: 'future.command' } },
        {
          type: 'game.assignStylesheet',
          example: { type: 'game.assignStylesheet', futureField: true },
        },
        { type: 'game.assignStylesheet', example: { type: 'game.assignStylesheet' } },
      ],
    })
    const { client, close } = await connection(remote)

    try {
      const result = await client.callTool({ name: 'ancadeba_get_capabilities', arguments: {} })
      const data = mcpCapabilitiesSchema.parse(object(result.structuredContent).data)
      expect(data.commandTool).toBe('ancadeba_apply_command')
      expect(data.commands).toEqual([
        { type: 'game.assignStylesheet', example: { type: 'game.assignStylesheet', file: null } },
      ])
      expect(data.requestSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining(['command', 'expectedRevision']),
        properties: { expectedRevision: { type: 'string' } },
      })
      expect(JSON.stringify(data.requestSchema)).toContain('game.assignStylesheet')
      expect(JSON.stringify(data.requestSchema)).not.toContain('future.command')
      expect(JSON.stringify(data.requestSchema)).not.toContain('game.upsertMap')
      expect(data.requestSchema.properties).not.toHaveProperty('path')
      remote.capabilities = async () => ({ ...capabilities, commands: [] })
      const empty = await client.callTool({ name: 'ancadeba_get_capabilities', arguments: {} })
      expect(mcpCapabilitiesSchema.parse(object(empty.structuredContent).data)).toMatchObject({
        commands: [],
        requestSchema: { properties: { command: { not: {} } } },
      })
    } finally {
      await close()
    }
  })

  it('rejects unsafe or out-of-scope generic commands before dispatch', async () => {
    const remote = api()
    let calls = 0
    remote.apply = async () => {
      calls++
      throw new Error('Must not dispatch')
    }

    const { client, close } = await connection(remote)
    const command = { type: 'game.assignStylesheet', file: null }

    try {
      for (const args of [
        { command },
        { command, expectedRevision: '' },
        { command, expectedRevision: 'one', path: 'other' },
        { command, expectedRevision: 'one', editorServerUrl: 'http://other' },
        { command: { ...command, path: 'other' }, expectedRevision: 'one' },
        { command: { type: 'future.command' }, expectedRevision: 'one' },
        {
          command: { type: 'game.upsertStylesheet', file: '../outside.css', css: '' },
          expectedRevision: 'one',
        },
        { command: { type: 'scene.remove', sceneId: '../outside' }, expectedRevision: 'one' },
      ])
        expect(
          (await client.callTool({ name: 'ancadeba_apply_command', arguments: args })).isError,
        ).toBe(true)
      expect(calls).toBe(0)
    } finally {
      await close()
    }
  })
  it('maps all four editing tools to their shared commands and returns compact change summaries', async () => {
    const remote = api()
    const calls: { revision: string; command: EditorCommand }[] = []
    remote.apply = async (revision, command, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      calls.push({ revision, command })

      return { ...view, revision: 'two', changedFiles: ['game.json'], summary: 'Saved' }
    }

    const { client, close } = await connection(remote)

    try {
      const inputs = [
        {
          name: 'ancadeba_update_game_metadata',
          arguments: { expectedRevision: 'one', title: 'Title', description: '', version: '2' },
        },
        { name: 'ancadeba_create_scene', arguments: { expectedRevision: 'one', scene } },
        {
          name: 'ancadeba_update_scene_metadata',
          arguments: { expectedRevision: 'one', sceneId: 'shop', title: 'Shop', description: '' },
        },
        {
          name: 'ancadeba_update_scene_layout',
          arguments: { expectedRevision: 'one', sceneId: 'shop', rows: 20, columns: 25 },
        },
      ]

      for (const input of inputs) {
        const result = await client.callTool(input)
        expect(result.isError).toBe(false)
        expect(result.structuredContent).toEqual({
          ok: true,
          data: {
            gamePath: 'basic',
            revision: 'two',
            changedFiles: ['game.json'],
            summary: 'Saved',
            diagnostics: [],
          },
        })
      }

      expect(calls.map((call) => call.command.type)).toEqual([
        'game.updateMetadata',
        'scene.create',
        'scene.updateMetadata',
        'scene.updateLayout',
      ])
      expect(calls.every((call) => call.revision === 'one')).toBe(true)
    } finally {
      await close()
    }
  })
  it('rejects missing revisions, unsafe IDs, arbitrary paths, and invalid grids before reaching the editor', async () => {
    const remote = api()
    let mutations = 0
    remote.apply = async () => {
      mutations++
      throw new Error('Should not run')
    }

    const { client, close } = await connection(remote)

    try {
      for (const args of [
        { sceneId: 'shop', rows: 1, columns: 1 },
        { expectedRevision: 'one', sceneId: '../shop', rows: 1, columns: 1 },
        { expectedRevision: 'one', sceneId: 'shop', rows: 0, columns: 1 },
        { expectedRevision: 'one', sceneId: 'shop', rows: 1, columns: 1, path: 'other' },
        {
          expectedRevision: 'one',
          sceneId: 'shop',
          rows: 1,
          columns: 1,
          editorServerUrl: 'http://other',
        },
      ])
        expect(
          (await client.callTool({ name: 'ancadeba_update_scene_layout', arguments: args }))
            .isError,
        ).toBe(true)
      expect(mutations).toBe(0)
    } finally {
      await close()
    }
  })
  it('reports conflicts and unavailable servers as actionable tool failures', async () => {
    const remote = api()
    remote.apply = async () => {
      throw new EditorApiError('revision_conflict', 'Changed', [], 'not_applied', 409)
    }

    remote.inspectGame = async () => {
      throw new EditorApiError('server_unavailable', 'Start the editor server')
    }

    const { client, close } = await connection(remote)

    try {
      const failed = await client.callTool({
        name: 'ancadeba_update_game_metadata',
        arguments: { expectedRevision: 'one', title: 'Title', description: '', version: '1' },
      })

      expect(failed.isError).toBe(true)
      expect(failed.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: 'revision_conflict',
          status: 409,
          recovery: expect.stringContaining('Inspect the game again'),
        },
      })
      expect(
        (await client.callTool({ name: 'ancadeba_inspect_game', arguments: {} })).structuredContent,
      ).toMatchObject({ ok: false, error: { code: 'server_unavailable' } })
    } finally {
      await close()
    }
  })
})
