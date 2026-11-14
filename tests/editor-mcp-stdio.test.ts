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
import { WorkspaceGameExporter } from '../apps/editor-server/src/gameExports.js'
import { writeGameArchive } from '../apps/editor-server/src/gameArchive.js'
import { unzipSync, strFromU8 } from 'fflate'
import { object, deletedProjectSchema } from '@ancadeba/editor-core'
import {
  historyResultSchema,
  gameSummarySchema,
  projectCreationResultSchema,
  projectDiscoveryResultSchema,
  projectSwitchResultSchema,
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
      new WorkspaceGameExporter(
        workspace,
        async (source, output) => {
          await mkdir(output)
          await writeFile(join(output, 'game.json'), await readFile(join(source, 'game.json')))
        },
        writeGameArchive,
        root,
      ),
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
    expect((await activeClient.listTools()).tools).toHaveLength(24)
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
    // First-use JSON output validation compiles the complete advertised game schema.
  }, 60_000)

  it('delivers a binary export over stdio from the selected project without filesystem access in the adapter', async () => {
    const { activeClient, errors, stderr } = await connect()
    await activeClient.callTool({
      name: 'ancadeba_create_project',
      arguments: { path: 'exported', title: 'Selected for export' },
    })
    await activeClient.callTool({
      name: 'ancadeba_switch_project',
      arguments: { path: 'exported' },
    })
    const result = await activeClient.callTool({ name: 'ancadeba_export_game', arguments: {} })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({
      data: { gamePath: 'exported', fileName: 'exported.zip' },
    })
    const binary = result.content.find((item) => item.type === 'resource')

    if (binary?.type !== 'resource' || !('blob' in binary.resource))
      throw new Error('Expected embedded ZIP')
    const files = unzipSync(Buffer.from(binary.resource.blob, 'base64'))
    expect(JSON.parse(strFromU8(files['game.json']!)).title).toBe('Selected for export')
    expect(errors).toEqual([])
    expect(stderr).toEqual([])
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

  it('duplicates a saved project through stdio while retaining the source binding', async () => {
    const { activeClient, errors, stderr } = await connect()
    const original = await readFile(join(root, 'basic/game.json'), 'utf8')
    const inspection = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    const source = gameSummarySchema.parse(object(inspection.structuredContent).data)

    const result = await activeClient.callTool({
      name: 'ancadeba_duplicate_project',
      arguments: {
        expectedRevision: source.revision,
        destination: 'process-copy',
        title: 'Process copy',
      },
    })

    expect(result.isError).toBe(false)
    expect(projectCreationResultSchema.parse(object(result.structuredContent).data)).toMatchObject({
      gamePath: 'process-copy',
      configuredGamePath: 'basic',
      diagnostics: [],
      game: { id: 'process-copy', title: 'Process copy' },
    })
    expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(original)
    expect(
      (await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ data: { gamePath: 'basic', game: { title: 'Process game' } } })
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
  })
  it('round-trips editable project source ZIPs through stdio without changing selection', async () => {
    const { activeClient, errors, stderr } = await connect()
    const inspected = await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} })
    const source = gameSummarySchema.parse(object(inspected.structuredContent).data)

    const exported = await activeClient.callTool({
      name: 'ancadeba_export_project',
      arguments: { expectedRevision: source.revision },
    })

    expect(exported.isError).toBe(false)
    const resource = exported.content.find((entry) => entry.type === 'resource')

    if (!resource || resource.type !== 'resource' || !('blob' in resource.resource))
      throw new Error('Expected binary project ZIP')
    const files = unzipSync(Buffer.from(resource.resource.blob, 'base64'))
    expect(JSON.parse(strFromU8(files['game.json']!)).id).toBe(source.game!.id)
    expect(files).not.toHaveProperty('index.html')

    const imported = await activeClient.callTool({
      name: 'ancadeba_import_project',
      arguments: { destination: 'imported', dataBase64: resource.resource.blob },
    })

    expect(imported.structuredContent).toMatchObject({
      ok: true,
      data: { gamePath: 'imported', configuredGamePath: 'basic', game: { id: source.game!.id } },
    })
    expect(
      (await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ data: { gamePath: 'basic' } })
    expect(await readFile(join(root, 'imported/game.json'), 'utf8')).toBe(
      await readFile(join(root, 'basic/game.json'), 'utf8'),
    )
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
  })
  it('renames, deletes and restores a project through stdio while tracking active selection', async () => {
    const { activeClient, errors, stderr } = await connect()

    const call = (name: string, args: Record<string, unknown> = {}) =>
      activeClient.callTool({ name, arguments: args })

    const inspected = await call('ancadeba_inspect_game')
    const source = gameSummarySchema.parse(object(inspected.structuredContent).data)

    const renamed = await call('ancadeba_rename_project', {
      expectedRevision: source.revision,
      title: 'Renamed through stdio',
      folderName: 'renamed',
    })

    expect(renamed.structuredContent).toMatchObject({
      ok: true,
      data: { gamePath: 'renamed', previousGamePath: 'basic' },
    })
    const current = await call('ancadeba_inspect_game')
    const view = gameSummarySchema.parse(object(current.structuredContent).data)
    expect(object(current.structuredContent).data).toMatchObject({
      gamePath: 'renamed',
      game: { id: source.game!.id, title: 'Renamed through stdio' },
    })

    const removed = await call('ancadeba_delete_project', {
      expectedRevision: view.revision,
      confirm: true,
    })

    expect(removed.isError).toBe(false)
    expect((await call('ancadeba_inspect_game')).structuredContent).toMatchObject({
      ok: false,
      error: { code: 'project_closed' },
    })
    const listed = await call('ancadeba_list_deleted_projects')
    expect(listed.isError).toBe(false)
    const deleted = deletedProjectSchema.parse(object(removed.structuredContent).data)
    expect(
      (
        await call('ancadeba_restore_project', {
          trashId: deleted.trashId,
          expectedRevision: deleted.revision,
          destination: 'recovered',
        })
      ).isError,
    ).toBe(false)
    expect((await call('ancadeba_switch_project', { path: 'recovered' })).isError).toBe(false)
    expect((await call('ancadeba_inspect_game')).structuredContent).toMatchObject({
      data: { gamePath: 'recovered', game: { id: source.game!.id } },
    })
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
  })

  it('discovers and creates a configured future project through stdio before its manifest exists', async () => {
    const { activeClient, activeTransport, errors, stderr } = await connect('future')
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
    const pid = activeTransport.pid

    const switched = await activeClient.callTool({
      name: 'ancadeba_switch_project',
      arguments: { path: 'basic' },
    })

    expect(projectSwitchResultSchema.parse(object(switched.structuredContent).data)).toMatchObject({
      gamePath: 'basic',
      previousGamePath: 'future',
    })
    expect(
      (await activeClient.callTool({ name: 'ancadeba_inspect_game', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ data: { gamePath: 'basic', game: { title: 'Process game' } } })

    const back = await activeClient.callTool({
      name: 'ancadeba_switch_project',
      arguments: { path: 'future' },
    })

    const selected = projectSwitchResultSchema.parse(object(back.structuredContent).data)

    const edited = await activeClient.callTool({
      name: 'ancadeba_update_game_metadata',
      arguments: {
        expectedRevision: selected.revision,
        title: 'Edited after switch',
        description: '',
        version: '2',
      },
    })

    expect(edited.isError).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'future/game.json'), 'utf8')).title).toBe(
      'Edited after switch',
    )
    expect(activeTransport.pid).toBe(pid)
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
    expect((await activeClient.listTools()).tools).toHaveLength(24)
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
  }, 60_000)
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
