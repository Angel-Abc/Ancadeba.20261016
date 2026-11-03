import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
    expect((await activeClient.listTools()).tools).toHaveLength(9)
    const inspection = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    // SAFETY: our inspect tool emits a revision-bearing data object on this successful fixture path.
    const current = (inspection.structuredContent as { data: { revision: string } }).data

    const result = await activeClient.callTool({
      name: 'ancadeba_update_game_metadata',
      arguments: {
        expectedRevision: current.revision,
        title: 'Saved through stdio',
        description: '',
        version: '1',
      },
    })

    expect(result.isError).toBe(false)
    const view = await (await fetch(`${base}/api/editor/project?path=basic`)).json()
    expect(view.game.title).toBe('Saved through stdio')
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
    const pid = activeTransport.pid
    expect(pid).not.toBeNull()
    await activeClient.close()

    if (pid !== null) expect(() => process.kill(pid, 0)).toThrow()
  })
  it('can list tools while the editor is offline and recovers when that same server returns', async () => {
    // SAFETY: this server is listening on a TCP loopback port, not a Unix socket.
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    const { activeClient } = await connect()
    expect((await activeClient.listTools()).tools).toHaveLength(9)
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
