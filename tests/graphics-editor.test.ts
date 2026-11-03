import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, readdir, unlink, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { beforeEach, afterEach, describe, expect, it } from 'vite-plus/test'
import { projectViewSchema } from '@ancadeba/editor-core'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'

const artwork =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 30"><rect width="20" height="30" fill="var(--fabric, #123456)"/></svg>'

const manifest = {
  'schema-version': '1.0.0',
  id: 'test',
  title: 'Assets',
  description: '',
  version: '1',
  scenes: [],
  extension: 'preserve',
}

const testsRoot = fileURLToPath(new URL('./', import.meta.url))

describe('revision-checked graphics authoring', () => {
  let root: string
  let server: Server
  let base: string
  let workspace: FileWorkspace
  beforeEach(async () => {
    root = await mkdtemp(join(testsRoot, '.tmp-graphics-editor-'))
    await mkdir(join(root, 'game'))
    await writeFile(join(root, 'game/game.json'), JSON.stringify(manifest))
    workspace = await FileWorkspace.open(root)
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      new EditorProjectService(new WorkspaceProjectRepository(workspace), new EditorCoordinator()),
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    // SAFETY: this server listens on a loopback TCP port rather than a Unix socket.
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )

    if (!root.startsWith(testsRoot) || !root.split(sep).at(-1)?.startsWith('.tmp-graphics-editor-'))
      throw new Error('Unexpected test cleanup path')
    await rm(root, { recursive: true, force: true })
  })

  const inspect = async () =>
    projectViewSchema.parse(await (await fetch(`${base}/api/editor/project?path=game`)).json())

  const command = (revision: string, command: unknown) =>
    fetch(`${base}/api/editor/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'game', expectedRevision: revision, command }),
    })

  const upload = (revision: string, source = artwork, id = 'art') => {
    const form = new FormData()
    form.set(
      'metadata',
      JSON.stringify({ path: 'game', expectedRevision: revision, id, format: 'svg' }),
    )
    form.set('file', new Blob([source], { type: 'image/svg+xml' }), 'art.svg')

    return fetch(`${base}/api/editor/assets/import`, { method: 'POST', body: form })
  }

  it('imports and replaces without overwriting artwork, and detects external byte edits', async () => {
    const initial = await inspect()
    expect((await upload(initial.revision)).status).toBe(200)
    const first = await inspect()
    const original = first.assets!.images.art!
    expect(original.colors).toEqual({ fabric: '#123456' })
    expect(await readFile(join(root, 'game', original.source), 'utf8')).toBe(artwork)
    expect(JSON.parse(await readFile(join(root, 'game/game.json'), 'utf8'))).toMatchObject({
      assets: 'assets.json',
      extension: 'preserve',
    })
    expect((await upload(first.revision, artwork.replace('#123456', '#654321'))).status).toBe(200)
    const replaced = await inspect()
    const latest = replaced.assets!.images.art!
    expect(latest.source).not.toBe(original.source)
    expect(await readFile(join(root, 'game', original.source), 'utf8')).toBe(artwork)
    await writeFile(join(root, 'game', latest.source), artwork)
    const changed = await inspect()
    expect(changed.revision).not.toBe(replaced.revision)
    expect(
      (await command(replaced.revision, { type: 'assets.upsertImage', id: 'art', image: latest }))
        .status,
    ).toBe(409)
    expect(
      (
        await command(changed.revision, {
          type: 'assets.upsertImage',
          id: 'art',
          image: {
            ...latest,
            colors: { fabric: '#abcdef' },
            palettes: { royal: { fabric: '#665191' } },
          },
        })
      ).status,
    ).toBe(200)
  })

  it('rejects invalid imports and missing registered sources before publishing definitions', async () => {
    const initial = await inspect()
    expect((await upload(initial.revision, artwork.replace('<rect', '<script'))).status).toBe(422)
    expect(
      (
        await command(initial.revision, {
          type: 'assets.upsertImage',
          id: '__proto__',
          image: {
            format: 'svg',
            source: 'art.svg',
            bounds: { x: 0, y: 0, width: 20, height: 30 },
          },
        })
      ).status,
    ).toBe(400)
    expect(await readdir(join(root, 'game'))).toEqual(['game.json'])
    expect(
      (
        await command(initial.revision, {
          type: 'assets.upsertImage',
          id: 'missing',
          image: {
            format: 'svg',
            source: 'missing.svg',
            bounds: { x: 0, y: 0, width: 20, height: 30 },
          },
        })
      ).status,
    ).toBe(422)
    expect(await readdir(join(root, 'game'))).toEqual(['game.json'])
  })

  it('can replace or unregister an unused broken source through the guarded repair path', async () => {
    await upload((await inspect()).revision)
    const first = await inspect()
    await unlink(join(root, 'game', first.assets!.images.art!.source))
    const broken = await inspect()
    expect(broken.diagnostics[0]?.code).toBe('invalid_asset_source')
    expect((await upload(broken.revision)).status).toBe(200)
    const repaired = await inspect()
    expect(repaired.diagnostics).toEqual([])
    await unlink(join(root, 'game', repaired.assets!.images.art!.source))
    expect(
      (
        await command((await inspect()).revision, {
          type: 'assets.remove',
          kind: 'images',
          id: 'art',
        })
      ).status,
    ).toBe(200)
    expect((await inspect()).assets?.images).toEqual({})
  })

  it('validates references and supports creating, editing, and removing graphic components', async () => {
    await upload((await inspect()).revision)
    expect(
      (
        await command((await inspect()).revision, {
          type: 'scene.create',
          scene: {
            'schema-version': '1.0.0',
            id: 'gallery',
            title: 'Gallery',
            type: 'stand-alone',
            screen: { type: 'grid', grid: { rows: 2, columns: 2 } },
            components: [],
          },
        })
      ).status,
    ).toBe(200)

    const component = {
      id: 'portrait',
      type: 'graphic',
      visual: 'art',
      alt: '',
      placement: { row: 1, column: 1 },
    }

    expect(
      (
        await command((await inspect()).revision, {
          type: 'scene.upsertGraphic',
          sceneId: 'gallery',
          component,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await command((await inspect()).revision, {
          type: 'assets.remove',
          kind: 'images',
          id: 'art',
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await command((await inspect()).revision, {
          type: 'scene.upsertGraphic',
          sceneId: 'gallery',
          component: { ...component, alt: 'Tunic', appearance: { colors: { fabric: '#abcdef' } } },
        })
      ).status,
    ).toBe(200)
    expect((await inspect()).scenes[0]?.components[0]).toMatchObject({
      alt: 'Tunic',
      appearance: { colors: { fabric: '#abcdef' } },
    })
    expect(
      (
        await command((await inspect()).revision, {
          type: 'scene.removeGraphic',
          sceneId: 'gallery',
          componentId: 'portrait',
        })
      ).status,
    ).toBe(200)
    expect((await inspect()).scenes[0]?.components).toEqual([])
  })

  it('bounds multipart requests and rejects malformed metadata', async () => {
    const form = new FormData()
    form.set('metadata', 'not json')
    form.set('file', new Blob([artwork]), 'art.svg')
    expect(
      (await fetch(`${base}/api/editor/assets/import`, { method: 'POST', body: form })).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${base}/api/editor/assets/import`, {
          method: 'POST',
          headers: {
            'Content-Type': 'multipart/form-data; boundary=test',
            'Content-Length': String(11 * 1024 * 1024),
          },
          body: new Uint8Array(11 * 1024 * 1024),
        })
      ).status,
    ).toBe(413)
  })

  it('reports a publication failure and preserves the original manifest, with an identifiable orphan source', async () => {
    const fault: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, bytes) => workspace.create(path, bytes),
      removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
      write: async (path, bytes) => {
        if (path === 'game/game.json') throw new Error('manifest write failed')

        return workspace.write(path, bytes)
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(fault),
      new EditorCoordinator(),
    )

    await expect(
      service.importAsset(
        { path: 'game', expectedRevision: (await inspect()).revision, id: 'art', format: 'svg' },
        new TextEncoder().encode(artwork),
      ),
    ).rejects.toMatchObject({ code: 'asset_publication_failed' })
    expect(JSON.parse(await readFile(join(root, 'game/game.json'), 'utf8'))).toEqual(manifest)
    expect(await readdir(join(root, 'game/assets/images'))).toHaveLength(1)
    expect(await readdir(join(root, 'game'))).not.toContain('assets.json')
  })
})
