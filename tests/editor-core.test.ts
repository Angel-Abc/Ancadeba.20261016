import { describe, expect, it } from 'vite-plus/test'
import {
  applyCommand,
  capabilities,
  inspectProject,
  object,
  validateProject,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'

const scene = {
  'schema-version': '1.0.0' as const,
  id: 'start',
  title: 'Start',
  description: '',
  type: 'stand-alone' as const,
  screen: {
    type: 'grid' as const,
    grid: { rows: 4, columns: 6, extension: 'grid' },
    extension: 'screen',
  },
  components: [],
  extension: { author: 'human' },
}

function project(): ProjectSnapshot {
  return {
    revision: 'original',
    documents: {
      'game.json': {
        'schema-version': '1.0.0',
        id: 'test',
        title: 'Game',
        description: '',
        version: '1',
        scenes: ['start'],
        extension: 'manifest',
      },
      'scenes/start.json': scene,
    },
  }
}

describe('editor core', () => {
  it('updates nested layout without mutating source or dropping extension properties', () => {
    const original = project()
    const before = JSON.stringify(original)

    const result = applyCommand(original, {
      type: 'scene.updateLayout',
      sceneId: 'start',
      rows: 12,
      columns: 16,
    })

    expect(JSON.stringify(original)).toBe(before)
    expect(result.changedFiles).toEqual(['scenes/start.json'])
    expect(result.project.documents['game.json']).toBe(original.documents['game.json'])
    expect(result.project.documents['scenes/start.json']).toEqual({
      ...scene,
      screen: { ...scene.screen, grid: { ...scene.screen.grid, rows: 12, columns: 16 } },
    })
  })

  it('adds a scene and reference as one semantic change', () => {
    const result = applyCommand(project(), {
      type: 'scene.create',
      scene: { ...scene, id: 'shop' },
    })

    expect(result.changedFiles).toEqual(['scenes/shop.json', 'game.json'])
    expect(result.project.documents['scenes/shop.json']).toEqual({ ...scene, id: 'shop' })
    expect(inspectProject(result.project).game?.scenes).toEqual(['start', 'shop'])
    expect(validateProject(result.project.documents)).toEqual([])
    expect(() =>
      applyCommand(result.project, { type: 'scene.create', scene: { ...scene, id: 'shop' } }),
    ).toThrow('Scene ID already exists')
  })

  it('retains scene bounds and binding validation when extending the creation schema', () => {
    const component = {
      id: 'score',
      type: 'text' as const,
      placement: { row: 4, column: 6, rowSpan: 1, columnSpan: 1 },
      text: 'Score: {{score}}',
      bindings: { score: { source: 'game.state' as const, path: ['score'] } },
      presentation: { variant: 'body' as const, align: 'start' as const },
    }

    const created = { ...scene, id: 'play', type: 'game' as const, components: [component] }
    const result = applyCommand(project(), { type: 'scene.create', scene: created })
    expect(result.project.documents['scenes/play.json']).toEqual(created)

    for (const invalid of [
      { ...created, type: 'stand-alone' as const },
      { ...created, components: [component, component] },
      { ...created, screen: { type: 'grid' as const, grid: { rows: 3, columns: 6 } } },
      { ...created, screen: { type: 'grid' as const, grid: { rows: 4, columns: 5 } } },
    ]) {
      expect(() => applyCommand(project(), { type: 'scene.create', scene: invalid })).toThrow(
        'Invalid editing command',
      )
    }
  })

  it('edits game and scene metadata without changing IDs or other properties', () => {
    const original = project()

    const game = applyCommand(original, {
      type: 'game.updateMetadata',
      title: 'New',
      description: 'Description',
      version: '2',
    })

    expect(game.project.documents['game.json']).toMatchObject({
      id: 'test',
      title: 'New',
      version: '2',
      extension: 'manifest',
    })

    const changed = applyCommand(original, {
      type: 'scene.updateMetadata',
      sceneId: 'start',
      title: 'New scene',
      description: 'Text',
    })

    expect(changed.project.documents['scenes/start.json']).toMatchObject({
      id: 'start',
      title: 'New scene',
      extension: scene.extension,
    })
  })

  it('rejects invalid commands and missing targets', () => {
    expect(() =>
      applyCommand(project(), {
        type: 'scene.updateLayout',
        sceneId: 'start',
        rows: 0,
        columns: 1,
      }),
    ).toThrow('Invalid editing command')
    expect(() =>
      applyCommand(project(), {
        type: 'scene.updateMetadata',
        sceneId: 'missing',
        title: 'X',
        description: '',
      }),
    ).toThrow('Scene does not exist')
  })

  it('returns file and property diagnostics and blocks edits to invalid projects', () => {
    const invalid = project()
    invalid.documents = { ...invalid.documents, 'scenes/start.json': { ...scene, id: 'other' } }
    expect(inspectProject(invalid).diagnostics).toContainEqual({
      code: 'scene_id_mismatch',
      file: 'scenes/start.json',
      path: ['id'],
      message: 'Expected scene ID start',
    })
    expect(inspectProject(invalid).scenes).toEqual([])
    expect(() =>
      applyCommand(invalid, {
        type: 'game.updateMetadata',
        title: 'New',
        description: '',
        version: '1',
      }),
    ).toThrow('Fix project diagnostics')
    expect(
      validateProject({
        'game.json': { ...object(project().documents['game.json']), input: 'controls' },
      }).map((d) => d.file),
    ).toContain('input/controls.json')
  })

  it('normalizes newly created scene metadata and detaches extension data from its input', () => {
    const input = { ...scene, id: 'shop', title: '  Shop  ', extension: { author: 'human' } }
    const result = applyCommand(project(), { type: 'scene.create', scene: input })
    input.extension.author = 'changed'
    expect(result.project.documents['scenes/shop.json']).toMatchObject({
      title: 'Shop',
      extension: { author: 'human' },
    })
  })

  it('publishes machine-readable requests and examples for every command', () => {
    expect(capabilities.commands).toHaveLength(16)
    expect(capabilities.requestSchema).toHaveProperty('properties')

    for (const command of capabilities.commands) expect(command.example.type).toBe(command.type)
  })
})
