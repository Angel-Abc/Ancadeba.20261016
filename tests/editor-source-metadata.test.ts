import { describe, expect, it } from 'vite-plus/test'
import {
  applyCommand,
  commandRequestSchema,
  createStarterProject,
  object,
  validateProject,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import {
  assetCatalogSchema,
  buttonComponentSchema,
  imageAssetSchema,
  mapViewComponentSchema,
  sceneSchema,
  textComponentSchema,
} from '@ancadeba/schemas'

const bounds = { x: 0, y: 0, width: 10, height: 10 }
const starter = () => createStarterProject({ path: 'metadata', title: 'Metadata', description: '' })

function assets() {
  const image = imageAssetSchema.parse({ format: 'svg', source: 'art.svg', bounds })

  const catalog = {
    'schema-version': '1.0.0',
    extension: { author: 'catalog' },
    images: {
      original: {
        ...image,
        extension: { author: 'image' },
        bounds: { ...bounds, extension: 'image bounds' },
        preview: { ...bounds, extension: 'preview' },
      },
      unused: { ...image, extension: 'unused image' },
    },
    parts: {
      cloth: {
        bounds: { ...bounds, extension: 'part bounds' },
        extension: 'part',
        pieces: [
          {
            id: 'first',
            image: 'original',
            layer: 'body',
            extension: 'first piece',
            sourceAnchor: { x: 0, y: 0, extension: 'source anchor' },
          },
          { id: 'second', image: 'original', layer: 'body', extension: 'second piece' },
        ],
      },
      spare: {
        bounds,
        extension: 'spare part',
        pieces: [{ id: 'piece', image: 'original', layer: 'body' }],
      },
    },
    compositions: {
      hero: {
        bounds: { ...bounds, extension: 'composition bounds' },
        extension: 'composition',
        layers: ['body'],
        anchors: {
          origin: { x: 0, y: 0, extension: 'origin' },
          unused: { x: 1, y: 1 },
        },
        slots: { outfit: { parts: ['cloth'], default: 'cloth', extension: 'slot' } },
      },
      unusedHero: { bounds, layers: ['body'], anchors: {}, slots: {}, extension: 'unused hero' },
    },
  }

  const documents = starter()

  return {
    catalog,
    parsed: assetCatalogSchema.parse(catalog),
    project: {
      revision: 'base',
      documents: {
        ...documents,
        'game.json': { ...object(documents['game.json']), assets: 'catalogue' },
        'assets/catalogue.json': catalog,
      },
    },
  }
}

function edit(source: ProjectSnapshot, command: EditorCommand) {
  expect(validateProject(source.documents)).toEqual([])
  const before = JSON.stringify(source)
  const result = applyCommand(source, command)

  expect(JSON.stringify(source)).toBe(before)
  expect(validateProject(result.project.documents)).toEqual([])

  return result.project
}

function components(entries: unknown[], additions: Record<string, unknown> = {}): ProjectSnapshot {
  const documents = starter()

  return {
    revision: 'base',
    documents: {
      ...documents,
      ...additions,
      'game.json': { ...object(documents['game.json']), ...object(additions['game.json']) },
      'scenes/adventure.json': {
        ...object(documents['scenes/adventure.json']),
        components: entries,
      },
    },
  }
}

const map = {
  'schema-version': '1.0.0',
  type: 'square-grid',
  width: 2,
  height: 2,
  terrain: { grass: { color: '#00ff00' } },
  tiles: [
    ['grass', 'grass'],
    ['grass', 'grass'],
  ],
}

const view = mapViewComponentSchema.parse({
  id: 'map',
  type: 'map-view',
  label: 'Map',
  placement: { row: 1, column: 1 },
  map: 'coast',
  viewport: { columns: 2, rows: 2 },
  playerSpawn: { x: 0, y: 0 },
})

const mapDocuments = { 'game.json': { maps: ['coast'] }, 'maps/coast.json': map }

describe('asset source metadata', () => {
  it.each([
    'image',
    'part',
    'composition',
    'remove image',
    'remove part',
    'remove composition',
  ] as const)('preserves untouched definitions during a focused %s operation', (operation) => {
    const { catalog, parsed, project } = assets()

    const cases = {
      image: {
        kind: 'images',
        id: 'added',
        command: { type: 'assets.upsertImage', id: 'added', image: parsed.images.original! },
      },
      part: {
        kind: 'parts',
        id: 'cloth',
        command: { type: 'assets.upsertPart', id: 'cloth', part: parsed.parts.cloth! },
      },
      composition: {
        kind: 'compositions',
        id: 'hero',
        command: {
          type: 'assets.upsertComposition',
          id: 'hero',
          composition: parsed.compositions.hero!,
        },
      },
      'remove image': {
        kind: 'images',
        id: 'unused',
        command: { type: 'assets.remove', kind: 'images', id: 'unused' },
      },
      'remove part': {
        kind: 'parts',
        id: 'spare',
        command: { type: 'assets.remove', kind: 'parts', id: 'spare' },
      },
      'remove composition': {
        kind: 'compositions',
        id: 'unusedHero',
        command: { type: 'assets.remove', kind: 'compositions', id: 'unusedHero' },
      },
    } satisfies Record<
      string,
      { kind: 'images' | 'parts' | 'compositions'; id: string; command: EditorCommand }
    >

    const { kind, id, command } = cases[operation]!
    const saved = object(edit(project, command).documents['assets/catalogue.json'])

    expect(saved.extension).toEqual(catalog.extension)

    for (const section of ['images', 'parts', 'compositions'] as const)
      for (const [name, definition] of Object.entries(catalog[section]))
        if (section !== kind || name !== id)
          expect(object(saved[section])[name]).toEqual(definition)

    if (command.type === 'assets.remove') expect(object(saved[kind])).not.toHaveProperty(id)
  })

  it('keeps targeted image extensions while clearing an omitted preview', () => {
    const { project } = assets()

    const saved = edit(project, {
      type: 'assets.upsertImage',
      id: 'original',
      image: imageAssetSchema.parse({ format: 'svg', source: 'replacement.svg', bounds }),
    })

    const catalog = JSON.parse(JSON.stringify(saved.documents['assets/catalogue.json']))

    expect(catalog.images.original).toMatchObject({
      source: 'replacement.svg',
      extension: { author: 'image' },
      bounds: { extension: 'image bounds' },
    })
    expect(catalog.images.original).not.toHaveProperty('preview')
  })

  it('keeps piece metadata by ID when reordering and removing pieces', () => {
    const { project, parsed } = assets()
    const cloth = parsed.parts.cloth!

    const reordered = edit(project, {
      type: 'assets.upsertPart',
      id: 'cloth',
      part: { ...cloth, pieces: [...cloth.pieces].reverse() },
    })

    expect(reordered.documents['assets/catalogue.json']).toMatchObject({
      parts: {
        cloth: {
          extension: 'part',
          bounds: { extension: 'part bounds' },
          pieces: [
            { id: 'second', extension: 'second piece' },
            { id: 'first', extension: 'first piece', sourceAnchor: { extension: 'source anchor' } },
          ],
        },
      },
    })

    const removed = edit(reordered, {
      type: 'assets.upsertPart',
      id: 'cloth',
      part: { ...cloth, pieces: [cloth.pieces[1]!] },
    })

    expect(removed.documents['assets/catalogue.json']).toMatchObject({
      parts: { cloth: { pieces: [{ id: 'second', extension: 'second piece' }] } },
    })
  })

  it('keeps composition metadata while removing deleted dictionary entries', () => {
    const { project, parsed } = assets()
    const hero = parsed.compositions.hero!

    const saved = edit(project, {
      type: 'assets.upsertComposition',
      id: 'hero',
      composition: { ...hero, anchors: { origin: { x: 2, y: 3 } } },
    })

    expect(saved.documents['assets/catalogue.json']).toMatchObject({
      compositions: {
        hero: {
          extension: 'composition',
          bounds: { extension: 'composition bounds' },
          anchors: { origin: { x: 2, y: 3, extension: 'origin' } },
          slots: { outfit: { extension: 'slot' } },
        },
      },
    })
    expect(
      object(object(object(saved.documents['assets/catalogue.json']).compositions).hero).anchors,
    ).not.toHaveProperty('unused')
  })
})

describe('component source metadata', () => {
  it('keeps nested text metadata and removes cleared bindings', () => {
    const text = textComponentSchema.parse({
      id: 'text',
      type: 'text',
      text: 'Before {{score}}',
      placement: { row: 1, column: 1 },
      bindings: { score: { source: 'game.state', path: ['score'] } },
    })

    const source = components([
      {
        ...text,
        extension: 'component',
        placement: { ...text.placement, extension: 'placement' },
        presentation: { ...text.presentation, extension: 'presentation' },
        bindings: { score: { ...text.bindings!.score, extension: 'binding', fallback: 'old' } },
      },
    ])

    const updated = edit(source, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: { ...text, text: 'After {{score}}' },
    })

    const component = object(updated.documents['scenes/adventure.json']).components

    expect(component).toMatchObject([
      {
        text: 'After {{score}}',
        extension: 'component',
        placement: { extension: 'placement' },
        presentation: { extension: 'presentation' },
        bindings: { score: { extension: 'binding', fallback: undefined } },
      },
    ])

    const cleared = edit(updated, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: textComponentSchema.parse({ ...text, text: 'Literal', bindings: undefined }),
    })

    expect(
      JSON.parse(JSON.stringify(cleared.documents['scenes/adventure.json'])).components[0],
    ).not.toHaveProperty('bindings')
  })

  it('keeps action and binding metadata while clearing obsolete action fields', () => {
    const button = buttonComponentSchema.parse({
      id: 'go',
      type: 'button',
      label: 'Go',
      placement: { row: 1, column: 1 },
      action: {
        type: 'request-action',
        action: 'go',
        enabledWhen: { source: 'game.state', path: ['ready'] },
      },
    })

    const source = components(
      [
        {
          ...button,
          action: {
            ...object(button.action),
            extension: 'action',
            enabledWhen: {
              source: 'game.state',
              path: ['ready'],
              extension: 'binding',
              fallback: 'old',
            },
          },
        },
      ],
      {
        'game.json': { rules: ['rules'] },
        'rules/rules.json': {
          state: [{ path: ['ready'], value: true }],
          actions: { go: [{ when: [], effects: [] }] },
        },
      },
    )

    const updated = edit(source, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: button,
    })

    expect(updated.documents['scenes/adventure.json']).toMatchObject({
      components: [
        {
          action: {
            extension: 'action',
            enabledWhen: { extension: 'binding', fallback: undefined },
          },
        },
      ],
    })

    const changed = edit(updated, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: buttonComponentSchema.parse({
        ...button,
        action: { type: 'enter-scene', scene: 'start' },
      }),
    })

    expect(
      JSON.parse(JSON.stringify(changed.documents['scenes/adventure.json'])).components[0].action,
    ).toEqual({ type: 'enter-scene', scene: 'start', extension: 'action' })
  })

  it('keeps map viewport and spawn metadata and permits clearing the spawn', () => {
    const source = components(
      [
        {
          ...view,
          viewport: { ...view.viewport, extension: 'viewport' },
          playerSpawn: { ...view.playerSpawn, extension: 'spawn' },
        },
      ],
      mapDocuments,
    )

    const updated = edit(source, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: { ...view, playerSpawn: { x: 1, y: 1 } },
    })

    expect(updated.documents['scenes/adventure.json']).toMatchObject({
      components: [
        {
          viewport: { extension: 'viewport' },
          playerSpawn: { x: 1, y: 1, extension: 'spawn' },
        },
      ],
    })

    const cleared = edit(updated, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: { ...view, playerSpawn: undefined },
    })

    expect(
      JSON.parse(JSON.stringify(cleared.documents['scenes/adventure.json'])).components[0],
    ).not.toHaveProperty('playerSpawn')
  })

  it('keeps destination tile metadata in a navigation action', () => {
    const button = buttonComponentSchema.parse({
      id: 'travel',
      type: 'button',
      label: 'Travel',
      placement: { row: 2, column: 1 },
      action: { type: 'enter-scene', scene: 'adventure', mapView: 'map', position: { x: 0, y: 0 } },
    })

    const source = components(
      [
        view,
        {
          ...button,
          action: { ...object(button.action), position: { x: 0, y: 0, extension: 'tile' } },
        },
      ],
      mapDocuments,
    )

    const saved = edit(source, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: buttonComponentSchema.parse({
        ...button,
        action: {
          type: 'enter-scene',
          scene: 'adventure',
          mapView: 'map',
          position: { x: 1, y: 1 },
        },
      }),
    })

    expect(saved.documents['scenes/adventure.json']).toMatchObject({
      components: [{ id: 'map' }, { action: { position: { x: 1, y: 1, extension: 'tile' } } }],
    })
  })

  it('preserves creation metadata through repeated request parsing and normalizes known fields', () => {
    const scene = {
      ...sceneSchema.parse({
        'schema-version': '1.0.0',
        id: 'created',
        title: 'Created',
        type: 'game',
        screen: { type: 'grid', grid: { rows: 10, columns: 10 } },
        components: [],
      }),
      title: '  Created  ',
      extension: { author: 'scene' },
      components: [
        {
          id: 'text',
          type: 'text',
          text: '{{score}}',
          extension: { author: 'component' },
          placement: { row: 1, column: 1, extension: 'placement' },
          presentation: { extension: 'presentation' },
          bindings: { score: { source: 'game.state', path: ['score'], extension: 'binding' } },
        },
      ],
    }

    const request = commandRequestSchema.parse(
      JSON.parse(
        JSON.stringify({
          path: 'game',
          expectedRevision: 'base',
          command: { type: 'scene.create', scene },
        }),
      ),
    )

    const saved = edit({ revision: 'base', documents: starter() }, request.command)
    scene.extension.author = 'changed'
    scene.components[0]!.extension.author = 'changed'

    expect(saved.documents['scenes/created.json']).toMatchObject({
      title: 'Created',
      extension: { author: 'scene' },
      components: [
        {
          extension: { author: 'component' },
          placement: { rowSpan: 1, columnSpan: 1, extension: 'placement' },
          presentation: { variant: 'body', align: 'start', extension: 'presentation' },
          bindings: { score: { extension: 'binding' } },
        },
      ],
    })
  })

  it('retains creation validation for nested component refinements', () => {
    const scene = {
      ...sceneSchema.parse({
        'schema-version': '1.0.0',
        id: 'created',
        title: 'Created',
        type: 'game',
        screen: { type: 'grid', grid: { rows: 2, columns: 2 } },
        components: [],
      }),
      components: [
        {
          id: 'text',
          type: 'text',
          text: '{{missing}}',
          extension: 'keep',
          bindings: {},
          placement: { row: 1, column: 1 },
        },
      ],
    }

    expect(
      commandRequestSchema.safeParse({
        path: 'game',
        expectedRevision: 'base',
        command: { type: 'scene.create', scene },
      }).success,
    ).toBe(false)
  })
})
