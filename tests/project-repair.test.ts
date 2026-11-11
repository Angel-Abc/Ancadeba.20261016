import { once } from 'node:events'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { projectRepairCheckSchema, projectViewSchema } from '@ancadeba/editor-core'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { FileWorkspace, WorkspaceError } from '../apps/editor-server/src/workspace.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'

describe('project repairs', () => {
  let root: string
  let workspace: FileWorkspace
  let repository: WorkspaceProjectRepository
  let service: EditorProjectService
  let server: Server | undefined
  const path = 'demo'
  const file = 'scenes/adventure.json'
  const read = (name: string) => readFile(join(root, path, name), 'utf8')
  const write = (name: string, text: string) => writeFile(join(root, path, name), text)

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-project-repair-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    repository = new WorkspaceProjectRepository(workspace)
    service = new EditorProjectService(repository, new EditorCoordinator())
    await service.create({ path, title: 'Repair demo' })
  })
  afterEach(async () => {
    if (server) {
      const active = server
      await new Promise<void>((resolve, reject) =>
        active.close((error) => (error ? reject(error) : resolve())),
      )
      server = undefined
    }

    await rm(root, { recursive: true, force: true })
  })

  it('recovers a missing manifest without modifying its surviving files and supports exact undo/redo', async () => {
    const original = await read('game.json')
    const scene = await read(file)
    const theme = await read('theme.css')
    await unlink(join(root, path, 'game.json'))
    const missing = await service.inspect(path)
    expect(missing.game).toBeNull()
    expect(missing.repairFiles).toEqual({ 'game.json': null })
    expect(missing.diagnostics).toEqual([
      expect.objectContaining({ code: 'missing_file', file: 'game.json' }),
    ])
    expect(JSON.parse(missing.recoveryManifest!)).toMatchObject({
      id: 'demo',
      scenes: ['adventure', 'start'],
      stylesheet: 'theme.css',
    })
    const request = { path, file: 'game.json', expectedRevision: missing.revision, text: original }
    expect((await service.checkRepair(request)).diagnostics).toEqual([])
    await expect(read('game.json')).rejects.toMatchObject({ code: 'ENOENT' })
    const fixed = await service.repair(request)
    expect(fixed.diagnostics).toEqual([])
    expect(fixed.recoveryManifest).toBeUndefined()
    expect(await read('game.json')).toBe(original)
    expect(await read(file)).toBe(scene)
    expect(await read('theme.css')).toBe(theme)

    const undone = await service.restore({
      path,
      expectedRevision: fixed.revision,
      direction: 'undo',
    })

    expect(undone.repairFiles?.['game.json']).toBeNull()
    expect(undone.history?.canRedo).toBe(true)
    await expect(read('game.json')).rejects.toMatchObject({ code: 'ENOENT' })

    const redone = await service.restore({
      path,
      expectedRevision: undone.revision,
      direction: 'redo',
    })

    expect(redone.diagnostics).toEqual([])
    expect(await read('game.json')).toBe(original)
    const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

    const loader = new GameLoader(
      new JsonResourceLoader(
        { readText: read, readBytes: (name) => workspace.read(`${path}/${name}`) },
        logger,
      ),
    )

    expect((await loader.load()).initialScene).toBe('start')
  })

  it('can save the generated manifest after checking it', async () => {
    await unlink(join(root, path, 'game.json'))
    const missing = await service.inspect(path)

    const request = {
      path,
      expectedRevision: missing.revision,
      file: 'game.json',
      text: missing.recoveryManifest!,
    }

    expect((await service.checkRepair(request)).diagnostics).toEqual([])
    expect((await service.repair(request)).game?.scenes).toEqual(['adventure', 'start'])
  })

  it('discovers missing-manifest projects over HTTP and returns them to normal discovery after recovery', async () => {
    await unlink(join(root, path, 'game.json'))
    await mkdir(join(root, 'unrelated'))
    await mkdir(join(root, 'nested/lost/scenes'), { recursive: true })
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      service,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()

    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const base = `http://127.0.0.1:${address.port}`
    expect(await (await fetch(`${base}/api/editor/projects`)).json()).toEqual({
      projects: [
        { path: 'demo', title: '', missingManifest: true },
        { path: 'nested/lost', title: '', missingManifest: true },
      ],
    })

    const missing = projectViewSchema.parse(
      await (await fetch(`${base}/api/editor/project?path=demo`)).json(),
    )

    expect(missing.repairFiles?.['game.json']).toBeNull()

    const request = {
      path,
      expectedRevision: missing.revision,
      file: 'game.json',
      text: missing.recoveryManifest!,
    }

    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }

    expect((await fetch(`${base}/api/editor/repair/check`, options)).status).toBe(200)
    await expect(read('game.json')).rejects.toMatchObject({ code: 'ENOENT' })
    const saved = await fetch(`${base}/api/editor/repair`, options)
    expect(saved.status).toBe(200)
    expect(projectViewSchema.parse(await saved.json()).diagnostics).toEqual([])
    expect(await (await fetch(`${base}/api/editor/projects`)).json()).toEqual({
      projects: [
        { path: 'demo', title: 'demo' },
        { path: 'nested/lost', title: '', missingManifest: true },
      ],
    })
    expect((await fetch(`${base}/api/editor/project?path=absent`)).status).toBe(404)
  })

  it('opens existing empty folders and the workspace root for recovery but never creates absent folders', async () => {
    await mkdir(join(root, 'Empty folder'))
    const empty = await service.inspect('Empty folder')
    expect(JSON.parse(empty.recoveryManifest!)).toMatchObject({
      id: 'recovered-game',
      title: 'Empty folder',
      scenes: [],
    })
    expect((await service.inspect('')).repairFiles?.['game.json']).toBeNull()
    await expect(service.inspect('does-not-exist')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.inspect('../outside')).rejects.toMatchObject({ status: 403 })
    await mkdir(join(root, 'Empty folder/game.json'))
    await expect(service.inspect('Empty folder')).rejects.toMatchObject({ status: 409 })
  })

  it('does not overwrite a manifest recreated after inspection or during publication', async () => {
    const text = await read('game.json')
    await unlink(join(root, path, 'game.json'))
    const missing = await service.inspect(path)
    const request = { path, expectedRevision: missing.revision, file: 'game.json', text }
    const external = text.replace('Repair demo', 'External project')
    await write('game.json', external)
    await expect(service.checkRepair(request)).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(service.repair(request)).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(await read('game.json')).toBe(external)
    await unlink(join(root, path, 'game.json'))

    const racing: ProjectWorkspace = {
      list: (name) => workspace.list(name),
      read: (name) => workspace.read(name),
      write: (name, bytes) => workspace.write(name, bytes),
      removeCreated: (name, bytes) => workspace.removeCreated(name, bytes),
      create: async (name, bytes) => {
        if (name === 'demo/game.json') await workspace.create(name, Buffer.from(external))
        await workspace.create(name, bytes)
      },
    }

    const concurrent = new EditorProjectService(
      new WorkspaceProjectRepository(racing),
      new EditorCoordinator(),
    )

    await expect(concurrent.repair(request)).rejects.toMatchObject({
      code: 'history_restore_uncertain',
    })
    expect(await read('game.json')).toBe(external)
  })

  it('suggests surviving resources without choosing between ambiguous single-file references', async () => {
    await unlink(join(root, path, 'game.json'))

    for (const directory of [
      'maps',
      'inventory',
      'rules',
      'dialogues',
      'quests',
      'leveling',
      'combat',
      'combat-libraries',
      'assets',
      'input',
    ]) {
      await mkdir(join(root, path, directory))
      await write(`${directory}/one.json`, '{broken')
    }

    await mkdir(join(root, path, 'languages/nl'), { recursive: true })
    await write('languages/nl/messages.json', '{}')
    const first = await service.inspect(path)
    expect(JSON.parse(first.recoveryManifest!)).toMatchObject({
      maps: ['one'],
      inventory: ['one'],
      rules: ['one'],
      dialogues: ['one'],
      quests: ['one'],
      leveling: ['one'],
      combat: ['one'],
      combatLibraries: ['one'],
      assets: 'one',
      input: 'one',
      languages: { default: 'nl', available: ['nl'] },
    })
    await write('assets/two.json', '{}')
    await write('input/two.json', '{}')
    await write('other.css', '')
    const second = await service.inspect(path)
    const suggested = JSON.parse(second.recoveryManifest!)
    expect(suggested.assets).toBeUndefined()
    expect(suggested.input).toBeUndefined()
    expect(suggested.stylesheet).toBeUndefined()
    expect(second.revision).not.toBe(first.revision)
    await expect(
      service.repair({
        path,
        expectedRevision: first.revision,
        file: 'game.json',
        text: first.recoveryManifest!,
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it('repairs malformed manifests and schema-invalid scenes incrementally with exact shared undo/redo', async () => {
    const manifest = await read('game.json')
    const scene = await read(file)
    const brokenManifest = '{ "title": "broken", '
    const brokenScene = '{"extension":{"keep":true}, "components": [] }\n'
    await write('game.json', brokenManifest)
    await write(file, brokenScene)
    const initial = await service.inspect(path)
    expect(initial.game).toBeNull()
    expect(initial.repairFiles).toEqual({ 'game.json': brokenManifest })
    const request = { path, expectedRevision: initial.revision, file: 'game.json', text: manifest }
    const preview = await service.checkRepair(request)
    expect(preview.revision).toBe(initial.revision)
    expect(preview.diagnostics.some((issue) => issue.file === file)).toBe(true)
    expect(await read('game.json')).toBe(brokenManifest)
    const first = await service.repair(request)
    expect(first.game?.title).toBe('Repair demo')
    expect(first.repairFiles?.[file]).toBe(brokenScene)
    expect(first.diagnostics.length).toBeGreaterThan(0)

    const fixed = await service.repair({
      path,
      expectedRevision: first.revision,
      file,
      text: scene,
    })

    expect(fixed.diagnostics).toEqual([])
    expect(fixed.repairFiles).toBeUndefined()
    expect(fixed.history?.canUndo).toBe(true)

    const undoScene = await service.restore({
      path,
      expectedRevision: fixed.revision,
      direction: 'undo',
    })

    expect(await read(file)).toBe(brokenScene)

    const undoManifest = await service.restore({
      path,
      expectedRevision: undoScene.revision,
      direction: 'undo',
    })

    expect(await read('game.json')).toBe(brokenManifest)

    const redoManifest = await service.restore({
      path,
      expectedRevision: undoManifest.revision,
      direction: 'redo',
    })

    const redoScene = await service.restore({
      path,
      expectedRevision: redoManifest.revision,
      direction: 'redo',
    })

    expect(redoScene.diagnostics).toEqual([])
    expect(await read(file)).toBe(scene)
    expect(await read('game.json')).toBe(manifest)
  })

  it('creates a missing referenced definition and removes it again on Undo', async () => {
    const text = await read(file)
    await unlink(join(root, path, file))
    const initial = await service.inspect(path)
    expect(initial.repairFiles?.[file]).toBeNull()
    const request = { path, expectedRevision: initial.revision, file, text }
    expect((await service.checkRepair(request)).diagnostics).toEqual([])
    await expect(read(file)).rejects.toMatchObject({ code: 'ENOENT' })
    const fixed = await service.repair(request)
    expect(fixed.diagnostics).toEqual([])

    const undo = await service.restore({
      path,
      expectedRevision: fixed.revision,
      direction: 'undo',
    })

    await expect(read(file)).rejects.toMatchObject({ code: 'ENOENT' })
    const redo = await service.restore({ path, expectedRevision: undo.revision, direction: 'redo' })
    expect(redo.diagnostics).toEqual([])
    expect(await read(file)).toBe(text)
  })

  it('repairs a missing stylesheet as exact CSS text', async () => {
    await unlink(join(root, path, 'theme.css'))
    const initial = await service.inspect(path)
    expect(initial.repairFiles?.['theme.css']).toBeNull()
    const text = '.ancadeba-button { color: gold; }\n'
    const request = { path, expectedRevision: initial.revision, file: 'theme.css', text }
    expect((await service.checkRepair(request)).diagnostics).toEqual([])
    const fixed = await service.repair(request)
    expect(fixed.diagnostics).toEqual([])
    expect(await read('theme.css')).toBe(text)
    await service.restore({ path, expectedRevision: fixed.revision, direction: 'undo' })
    await expect(read('theme.css')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('repairs cross-file references without stripping extension data and loads through the engine', async () => {
    const source = JSON.parse(await read(file))
    source.extension = { author: 'Keep me' }
    source.components.find((component: { id: string }) => component.id === 'menu').action.scene =
      'missing'
    await write(file, JSON.stringify(source))
    const initial = await service.inspect(path)
    expect(initial.diagnostics.some((issue) => issue.code === 'invalid_button_target')).toBe(true)
    source.components.find((component: { id: string }) => component.id === 'menu').action.scene =
      'start'
    const text = JSON.stringify(source, null, 4)
    const fixed = await service.repair({ path, expectedRevision: initial.revision, file, text })
    expect(fixed.diagnostics).toEqual([])
    expect(await read(file)).toBe(text)
    const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

    const loader = new GameLoader(
      new JsonResourceLoader(
        {
          readText: read,
          readBytes: async (name) => new Uint8Array(await readFile(join(root, path, name))),
        },
        logger,
      ),
    )

    expect((await loader.load()).scenes.has('adventure')).toBe(true)
  })

  it('permits partial schema repairs but rejects invalid JSON and uninspected paths before writing', async () => {
    await write(file, '{')
    const initial = await service.inspect(path)

    for (const name of ['../game.json', 'unreferenced.json', 'assets/images/a.svg'])
      await expect(
        service.repair({ path, expectedRevision: initial.revision, file: name, text: '{}' }),
      ).rejects.toMatchObject({ code: 'invalid_repair_file', outcome: 'not_applied' })
    await expect(
      service.repair({ path, expectedRevision: initial.revision, file, text: '{oops' }),
    ).rejects.toMatchObject({ code: 'invalid_json', outcome: 'not_applied' })
    expect(await read(file)).toBe('{')

    const partial = await service.repair({
      path,
      expectedRevision: initial.revision,
      file,
      text: '{"id":"adventure"}',
    })

    expect(partial.diagnostics.length).toBeGreaterThan(0)
    expect(partial.repairFiles?.[file]).toBe('{"id":"adventure"}')
  })

  it('rejects stale repair previews and saves without overwriting outside changes', async () => {
    const original = await read(file)
    await write(file, '{')
    const initial = await service.inspect(path)
    const request = { path, expectedRevision: initial.revision, file, text: original }
    await service.checkRepair(request)
    const external = '{"external":true}'
    await write(file, external)
    await expect(service.checkRepair(request)).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(service.repair(request)).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(await read(file)).toBe(external)
    expect((await service.inspect(path)).history?.canUndo).toBe(false)
  })

  it('rejects repairs of a healthy project', async () => {
    const initial = await service.inspect(path)
    await expect(
      service.repair({ path, expectedRevision: initial.revision, file, text: '{}' }),
    ).rejects.toMatchObject({ code: 'repair_unavailable', outcome: 'not_applied' })
  })

  it('preserves the invalid original and clears history after a publication failure', async () => {
    const original = await read(file)
    await write(file, '{')

    const failing: ProjectWorkspace = {
      list: (name) => workspace.list(name),
      read: (name) => workspace.read(name),
      write: async () => {
        throw new Error('Write failed')
      },
      create: (name, bytes) => workspace.create(name, bytes),
      removeCreated: (name, bytes) => workspace.removeCreated(name, bytes),
    }

    const failingService = new EditorProjectService(
      new WorkspaceProjectRepository(failing),
      new EditorCoordinator(),
    )

    const initial = await failingService.inspect(path)
    await expect(
      failingService.repair({ path, expectedRevision: initial.revision, file, text: original }),
    ).rejects.toThrow('Write failed')
    expect(await read(file)).toBe('{')
    expect((await failingService.inspect(path)).history?.canUndo).toBe(false)
  })

  it('reports an uncertain result if saved repair bytes cannot be reopened', async () => {
    const text = await read(file)
    await write(file, '{')

    class UnreadableAfterRepair extends WorkspaceProjectRepository {
      private saved = false
      override async restoreHistoryFiles(
        ...args: Parameters<WorkspaceProjectRepository['restoreHistoryFiles']>
      ) {
        await super.restoreHistoryFiles(...args)
        this.saved = true
      }
      override load(...args: Parameters<WorkspaceProjectRepository['load']>) {
        if (this.saved) throw new WorkspaceError(404, 'Post-write read failed')

        return super.load(...args)
      }
    }

    const failing = new EditorProjectService(
      new UnreadableAfterRepair(workspace),
      new EditorCoordinator(),
    )

    const initial = await failing.inspect(path)
    await expect(
      failing.repair({ path, expectedRevision: initial.revision, file, text }),
    ).rejects.toMatchObject({ status: 500, code: 'repair_save_uncertain', outcome: 'unknown' })
    expect(await read(file)).toBe(text)
  })

  it('exposes bounded, revision-checked repair previews and saves over HTTP', async () => {
    const text = await read(file)
    await write(file, '{')
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      service,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()

    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const base = `http://127.0.0.1:${address.port}`

    const initial = projectViewSchema.parse(
      await (await fetch(`${base}/api/editor/project?path=demo`)).json(),
    )

    expect(initial.repairFiles?.[file]).toBe('{')
    const request = { path, expectedRevision: initial.revision, file, text }

    const check = await fetch(`${base}/api/editor/repair/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    expect(check.status).toBe(200)
    expect(projectRepairCheckSchema.parse(await check.json()).diagnostics).toEqual([])

    const invalid = await fetch(`${base}/api/editor/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, text: 'x'.repeat(4 * 1024 * 1024 + 1) }),
    })

    expect(invalid.status).toBe(400)

    const saved = await fetch(`${base}/api/editor/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    expect(saved.status).toBe(200)
    expect(projectViewSchema.parse(await saved.json()).diagnostics).toEqual([])
  })
})
