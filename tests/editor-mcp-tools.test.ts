import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vite-plus/test'
import { capabilities, type EditorCommand } from '@ancadeba/editor-core'
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
  it('discovers seven typed tools with read-only annotations and compact structured results', async () => {
    const { client, close } = await connection(api())

    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b))).toEqual([
        'ancadeba_create_scene',
        'ancadeba_get_capabilities',
        'ancadeba_inspect_game',
        'ancadeba_inspect_scene',
        'ancadeba_update_game_metadata',
        'ancadeba_update_scene_layout',
        'ancadeba_update_scene_metadata',
      ])
      expect(tools.filter((tool) => tool.annotations?.readOnlyHint)).toHaveLength(3)

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
