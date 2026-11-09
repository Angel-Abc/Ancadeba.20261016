import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { object } from '@ancadeba/editor-core'
import {
  historyResultSchema,
  gameSummarySchema,
  projectCreationResultSchema,
  projectDiscoveryResultSchema,
} from '../apps/editor-mcp/src/protocol.js'

const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const entry = fileURLToPath(new URL('../apps/editor-mcp/src/main.ts', import.meta.url))

describe('MCP stdio process', () => {
  let root: string
  let base: string
  let server: Server
  let transport: StdioClientTransport | undefined
  let client: Client | undefined
  beforeEach(async () => {
    transport = undefined
    client = undefined
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-mcp-process-', import.meta.url)))
    await mkdir(join(root, 'basic'))
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({
        'schema-version': '1.0.0',
        id: 'test',
        title: 'Process game',
        description: '',
        version: '1',
        scenes: [],
      }),
    )
    const workspace = await FileWorkspace.open(root)

    const projects = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

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
  })
  afterEach(async () => {
    await client?.close()
    await transport?.close()

    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    await rm(root, { recursive: true, force: true })
  })

  function args(game = 'basic') {
    return [
      '--import',
      loader,
      entry,
      '--editor-server-url',
      base,
      '--game',
      game,
      '--timeout-ms',
      '1000',
    ]
  }

  async function connect(game = 'basic') {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: args(game),
      cwd: root,
      stderr: 'pipe',
    })
    const errors: string[] = []
    const stderr: string[] = []
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
    client = new Client({ name: 'stdio-tests', version: '1' })
    client.onerror = (error) => errors.push(error.message)
    await client.connect(transport)

    return { activeClient: client, activeTransport: transport, errors, stderr }
  }

  it('initializes, discovers tools, and saves over stdio from an unrelated working directory without stdout contamination', async () => {
    const { activeClient, activeTransport, errors, stderr } = await connect()
    expect((await activeClient.listTools()).tools).toHaveLength(15)
    const inspection = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    // SAFETY: our inspect tool emits a revision-bearing data object on this successful fixture path.
    const current = (inspection.structuredContent as { data: { revision: string } }).data

    const result = await activeClient.callTool({
      name: 'ancadeba_apply_command',
      arguments: {
        expectedRevision: current.revision,
        command: {
          type: 'game.updateMetadata',
          title: 'Saved through stdio',
          description: '',
          version: '1',
        },
      },
    })

    expect(result.isError).toBe(false)
    const view = await (await fetch(`${base}/api/editor/project?path=basic`)).json()
    expect(view.game.title).toBe('Saved through stdio')

    const undone = await activeClient.callTool({
      name: 'ancadeba_undo',
      arguments: { expectedRevision: view.revision },
    })

    expect(undone.isError).toBe(false)
    const history = historyResultSchema.parse(object(undone.structuredContent).data)
    expect(history.history).toMatchObject({ canUndo: false, canRedo: true })

    const redone = await activeClient.callTool({
      name: 'ancadeba_redo',
      arguments: { expectedRevision: history.revision },
    })

    expect(redone.isError).toBe(false)
    const restored = historyResultSchema.parse(object(redone.structuredContent).data)

    const uploaded = await activeClient.callTool({
      name: 'ancadeba_upload_asset',
      arguments: {
        expectedRevision: restored.revision,
        id: 'stdio-art',
        format: 'svg',
        dataBase64: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 10"/>',
        ).toString('base64'),
      },
    })

    expect(uploaded.isError).toBe(false)
    expect(
      (await (await fetch(`${base}/api/editor/project?path=basic`)).json()).assets.images[
        'stdio-art'
      ].bounds,
    ).toMatchObject({ width: 12, height: 10 })
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
    const pid = activeTransport.pid
    expect(pid).not.toBeNull()
    await activeClient.close()

    if (pid !== null) expect(() => process.kill(pid, 0)).toThrow()
  })
  it('uploads images whose base64 message exceeds the SDK default stdio buffer', async () => {
    const { activeClient, errors, stderr } = await connect()
    const inspection = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    const before = gameSummarySchema.parse(object(inspection.structuredContent).data)

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!--' +
      'x'.repeat(8 * 1024 * 1024) +
      '--></svg>'

    const result = await activeClient.callTool({
      name: 'ancadeba_upload_asset',
      arguments: {
        expectedRevision: before.revision,
        id: 'large',
        format: 'svg',
        dataBase64: Buffer.from(svg).toString('base64'),
      },
    })

    expect(result.isError).toBe(false)
    const inspected = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    const saved = gameSummarySchema.parse(object(inspected.structuredContent).data)
    const source = saved.assets!.images.large!.source
    expect(await readFile(join(root, 'basic', source), 'utf8')).toBe(svg)
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
  }, 15000)

  it('discovers and creates a configured future project through stdio before its manifest exists', async () => {
    const { activeClient, errors, stderr } = await connect('future')
    const listed = await activeClient.callTool({ name: 'ancadeba_list_projects', arguments: {} })
    expect(
      projectDiscoveryResultSchema.parse(object(listed.structuredContent).data).projects,
    ).toContainEqual({ path: 'basic', title: 'Process game' })

    const result = await activeClient.callTool({
      name: 'ancadeba_create_project',
      arguments: { path: 'future', title: 'Created through stdio' },
    })

    expect(result.isError).toBe(false)
    const created = projectCreationResultSchema.parse(object(result.structuredContent).data)
    expect(created).toMatchObject({
      gamePath: 'future',
      configuredGamePath: 'future',
      diagnostics: [],
    })
    const inspection = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    expect(gameSummarySchema.parse(object(inspection.structuredContent).data).game?.title).toBe(
      'Created through stdio',
    )
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
  })

  it('can list tools while the editor is offline and recovers when that same server returns', async () => {
    // SAFETY: this server is listening on a TCP loopback port, not a Unix socket.
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    const { activeClient } = await connect()
    expect((await activeClient.listTools()).tools).toHaveLength(15)
    const failed = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toMatchObject({
      error: { code: 'server_unavailable', outcome: 'not_applied' },
    })
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    expect(
      (await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })).isError,
    ).toBe(false)
  })
  it('writes help and startup failures only to stderr', async () => {
    const run = promisify(execFile)
    const help = await run(process.execPath, ['--import', loader, entry, '--help'], { cwd: root })
    expect(help.stdout).toBe('')
    expect(help.stderr).toContain('Usage:')
    await expect(
      run(process.execPath, ['--import', loader, entry], { cwd: root }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('required'),
    })
  })
  it('exits cleanly when its stdin is closed, without starting an editor server', async () => {
    const child = spawn(process.execPath, args(), { cwd: root, stdio: 'pipe' })
    const stdout: string[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')))
    const exited = once(child, 'exit')

    try {
      child.stdin.end()
      expect((await exited)[0]).toBe(0)
      expect(stdout.join('')).toBe('')
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })
  it('preserves an explicit empty game argument when the host launches it for the workspace root', async () => {
    await writeFile(
      join(root, 'game.json'),
      JSON.stringify({
        'schema-version': '1.0.0',
        id: 'root',
        title: 'Root game',
        description: '',
        version: '1',
        scenes: [],
      }),
    )
    const { activeClient } = await connect('')
    const result = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({
      data: { gamePath: '', game: { title: 'Root game' } },
    })
  })
})
