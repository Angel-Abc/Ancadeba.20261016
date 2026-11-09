import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import {
  applyCommand,
  createStarterProject,
  inspectProject,
  object,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import { assetCatalogSchema, type AssetCatalog, graphicComponentSchema } from '@ancadeba/schemas'
import { resolveGraphic } from '@ancadeba/game-runtime'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'

const image = {
  format: 'svg' as const,
  source: 'assets/images/cloth.svg',
  bounds: { x: 0, y: 0, width: 20, height: 30 },
  colors: { fabric: '#123456' },
  palettes: {},
}

const starter = (): ProjectSnapshot => ({
  revision: 'one',
  documents: createStarterProject({ path: 'game', title: 'Graphics', description: '' }),
})

const source = () =>
  applyCommand(starter(), { type: 'assets.upsertImage', id: 'cloth', image }).project

const catalog = (): AssetCatalog =>
  assetCatalogSchema.parse({
    'schema-version': '1.0.0',
    images: { cloth: image },
    parts: {
      cloak: {
        bounds: image.bounds,
        colors: { shared: '#aabbcc' },
        palettes: { royal: { shared: '#665191' } },
        pieces: [
          {
            id: 'rear',
            image: 'cloth',
            layer: 'back',
            anchor: 'shoulder',
            sourceAnchor: { x: 10, y: 4 },
            scale: 2,
            rotation: 15,
            slots: { fabric: 'shared' },
          },
          { id: 'clasp', image: 'cloth', layer: 'front', anchor: 'shoulder' },
        ],
      },
    },
    compositions: {
      hero: {
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        layers: ['back', 'front'],
        anchors: { shoulder: { x: 40, y: 50 } },
        slots: { outfit: { parts: ['cloak'], default: 'cloak' } },
      },
    },
  })

const edit = (
  assets = catalog(),
): Extract<EditorCommand, { type: 'assets.updateDefinitions' }> => ({
  type: 'assets.updateDefinitions',
  parts: assets.parts,
  compositions: assets.compositions,
})

describe('graphic definition authoring', () => {
  it('saves parts, pieces, layers, anchors, slots and palettes as a single immutable update', () => {
    const initial = source()
    const before = JSON.stringify(initial)
    const saved = applyCommand(initial, edit())
    expect(JSON.stringify(initial)).toBe(before)
    expect(saved.changedFiles).toEqual(['assets/catalogue.json'])
    expect(inspectProject(saved.project).assets).toEqual(catalog())
    const graphic = resolveGraphic(catalog(), 'hero', { slots: {}, colors: {}, visible: true })
    expect(graphic.pieces.map((piece) => piece.layer)).toEqual(['back', 'front'])
    expect(graphic.pieces[0]!.transform).toBe(
      'translate(40 50) rotate(15) scale(2) translate(-10 -4)',
    )
    expect(graphic.pieces[0]!.colors.fabric).toBe('#aabbcc')
  })

  it('updates shared attachment references atomically and follows the new layer order', () => {
    const initial = applyCommand(source(), edit()).project
    const assets = catalog()
    assets.compositions.hero!.layers = ['front', 'rear']
    assets.compositions.hero!.anchors = { hand: { x: 60, y: 70 } }
    assets.parts.cloak!.pieces[0]!.layer = 'rear'

    for (const piece of assets.parts.cloak!.pieces) piece.anchor = 'hand'
    expect(() =>
      applyCommand(initial, {
        type: 'assets.upsertComposition',
        id: 'hero',
        composition: assets.compositions.hero!,
      }),
    ).toThrow('invalid project')
    const saved = inspectProject(applyCommand(initial, edit(assets)).project).assets!
    expect(
      resolveGraphic(saved, 'hero', { slots: {}, colors: {}, visible: true }).pieces.map(
        (piece) => piece.layer,
      ),
    ).toEqual(['front', 'rear'])
  })

  it.each([
    'image',
    'layer',
    'anchor',
    'default',
    'duplicate piece',
    'duplicate layer',
    'color mapping',
  ])('rejects an invalid %s without changing any definition', (problem) => {
    const initial = applyCommand(source(), edit()).project
    const assets = catalog()

    if (problem === 'image') assets.parts.cloak!.pieces[0]!.image = 'missing'

    if (problem === 'layer') assets.compositions.hero!.layers = ['front']

    if (problem === 'anchor') assets.compositions.hero!.anchors = {}

    if (problem === 'default') assets.compositions.hero!.slots.outfit!.default = 'missing'

    if (problem === 'duplicate piece')
      assets.parts.cloak!.pieces.push({ ...assets.parts.cloak!.pieces[0]! })

    if (problem === 'duplicate layer') assets.compositions.hero!.layers.push('front')

    if (problem === 'color mapping') assets.parts.cloak!.pieces[0]!.slots.fabric = 'missing'
    const before = JSON.stringify(initial)
    expect(() => applyCommand(initial, edit(assets))).toThrow('invalid project')
    expect(JSON.stringify(initial)).toBe(before)
  })

  it('preserves image data and extension fields by stable piece IDs while removing dictionary entries', () => {
    const initial = applyCommand(source(), edit()).project
    const data = catalog()
    const raw = object(structuredClone(data))
    object(object(raw.images).cloth).extension = 'image'
    const part = object(object(raw.parts).cloak)
    part.extension = 'part'
    const pieces = Array.isArray(part.pieces) ? part.pieces : []
    object(pieces[0]).extension = 'rear'
    object(pieces[1]).extension = 'clasp'
    object(object(object(raw.compositions).hero).anchors).unused = { x: 1, y: 2 }
    object(object(object(raw.compositions).hero).slots).unused = { parts: ['cloak'], default: null }

    const extended = {
      ...initial,
      documents: { ...initial.documents, 'assets/catalogue.json': raw },
    }

    data.parts.cloak!.pieces.reverse()
    delete data.parts.cloak!.colors.shared
    data.parts.cloak!.palettes = {}

    for (const piece of data.parts.cloak!.pieces) piece.slots = {}
    const saved = applyCommand(extended, edit(data)).project.documents['assets/catalogue.json']
    expect(saved).toMatchObject({
      images: { cloth: { extension: 'image' } },
      parts: {
        cloak: {
          extension: 'part',
          pieces: [
            { id: 'clasp', extension: 'clasp' },
            { id: 'rear', extension: 'rear' },
          ],
          colors: {},
          palettes: {},
        },
      },
    })
    expect(object(object(object(saved).compositions).hero).anchors).not.toHaveProperty('unused')
    expect(object(object(object(saved).compositions).hero).slots).not.toHaveProperty('unused')
  })

  it('protects referenced definitions and permits removal after atomic cleanup', () => {
    let initial = applyCommand(source(), edit()).project
    initial = applyCommand(initial, {
      type: 'scene.upsertGraphic',
      sceneId: 'adventure',
      component: graphicComponentSchema.parse({
        id: 'portrait',
        type: 'graphic',
        visual: 'hero',
        alt: 'Hero',
        placement: { row: 1, column: 1 },
      }),
    }).project
    expect(() =>
      applyCommand(initial, { type: 'assets.updateDefinitions', parts: {}, compositions: {} }),
    ).toThrow('invalid project')
    initial = applyCommand(initial, {
      type: 'scene.removeGraphic',
      sceneId: 'adventure',
      componentId: 'portrait',
    }).project
    expect(
      inspectProject(
        applyCommand(initial, { type: 'assets.updateDefinitions', parts: {}, compositions: {} })
          .project,
      ).assets!.images,
    ).toHaveProperty('cloth')
  })
})

describe('graphic definition persistence', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-graphic-definitions-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )
    await service.create({ path: 'game', title: 'Graphic definitions' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const apply = async (command: EditorCommand) =>
    service.apply({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      command,
    })

  const restore = async (direction: 'undo' | 'redo') =>
    service.restore({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      direction,
    })

  it('creates a catalog from an empty project and restores exact catalog and manifest bytes', async () => {
    const before = await workspace.read('game/game.json')
    await apply({
      type: 'assets.updateDefinitions',
      parts: {},
      compositions: {
        empty: {
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          layers: ['body'],
          anchors: { origin: { x: 0, y: 0 } },
          slots: {},
        },
      },
    })
    const saved = await workspace.read('game/assets/catalogue.json')
    await restore('undo')
    expect(await workspace.read('game/game.json')).toEqual(before)
    await expect(workspace.read('game/assets/catalogue.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await restore('redo')
    expect(await workspace.read('game/assets/catalogue.json')).toEqual(saved)
  })

  it('persists related edits without changing artwork and rejects stale or invalid saves', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 30"><rect width="20" height="30" fill="var(--fabric, #123456)"/></svg>',
    )

    await workspace.write('game/assets/images/cloth.svg', svg)
    await apply({ type: 'assets.upsertImage', id: 'cloth', image })
    await apply(edit())
    const saved = await workspace.read('game/assets/catalogue.json')
    const revision = (await service.inspect('game')).revision
    await apply({ type: 'game.updateMetadata', title: 'Changed', description: '', version: '1' })
    await expect(
      service.apply({ path: 'game', expectedRevision: revision, command: edit() }),
    ).rejects.toMatchObject({ status: 409 })
    const invalid = edit()
    invalid.compositions.hero!.layers = []
    await expect(apply(invalid)).rejects.toMatchObject({ status: 400 })
    expect(await workspace.read('game/assets/catalogue.json')).toEqual(saved)
    const changed = catalog()
    changed.compositions.hero!.anchors.shoulder!.x = 80
    await apply(edit(changed))
    expect((await service.inspect('game')).assets!.compositions.hero!.anchors.shoulder!.x).toBe(80)
    await restore('undo')
    expect(await workspace.read('game/assets/catalogue.json')).toEqual(saved)
    expect(await workspace.read('game/assets/images/cloth.svg')).toEqual(svg)
  })
})
