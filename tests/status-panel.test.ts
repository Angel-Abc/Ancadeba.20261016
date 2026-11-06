import { describe, expect, it } from 'vite-plus/test'
import {
  sceneSchema,
  statusPanelComponentSchema,
  statusPanelIssues,
  assetCatalogSchema,
  type GameBindingDefinition,
} from '@ancadeba/schemas'
import { resolveStatusValue, statusBarFill, type IGameBindings } from '@ancadeba/game-runtime'
import { applyCommand, inspectProject, object, validateProject } from '@ancadeba/editor-core'

const binding: GameBindingDefinition = { source: 'game.state', path: ['health'], fallback: '40' }

const panel = statusPanelComponentSchema.parse({
  id: 'player',
  type: 'status-panel',
  label: 'Player',
  placement: { row: 1, column: 1 },
  rows: [{ id: 'health', type: 'bar', label: 'Health', value: binding, maximum: 40 }],
  effects: [
    {
      id: 'poison',
      label: 'Poisoned',
      description: 'Losing health.',
      visibleWhen: { source: 'game.state', path: ['poisoned'] },
    },
  ],
})

describe('status panel data and resolution', () => {
  it('resolves constants and bindings without coercing invalid resources or inventing zero values', () => {
    const source: IGameBindings = {
      read: () => ({
        status: 'unresolved',
        diagnostic: { source: binding.source, path: binding.path, reason: 'missing-path' },
      }),
      subscribeChanges: () => () => {},
    }

    expect(resolveStatusValue(binding, source, true)).toEqual({
      value: undefined,
      issue: 'missing-path',
    })
    expect(resolveStatusValue(binding, source)).toEqual({ value: '40', issue: 'missing-path' })
    expect(resolveStatusValue(12, undefined, true)).toEqual({ value: 12 })
    expect(resolveStatusValue('A name', undefined)).toEqual({ value: 'A name' })

    for (const value of ['40', true, NaN, Infinity]) {
      source.read = () => ({ status: 'resolved', value })
      expect(resolveStatusValue(binding, source, true).value).toBeUndefined()
    }

    source.read = () => ({ status: 'resolved', value: 23 })
    expect(resolveStatusValue(binding, source, true)).toEqual({ value: 23 })
  })

  it('clamps visual fill and rejects unavailable or invalid maximums', () => {
    expect(statusBarFill(25, 50)).toBe(50)
    expect(statusBarFill(-10, 50)).toBe(0)
    expect(statusBarFill(100, 50)).toBe(100)
    expect(statusBarFill(Number.MAX_VALUE, Number.MIN_VALUE)).toBe(100)

    for (const maximum of [0, -1, NaN, Infinity, undefined, '50'])
      expect(statusBarFill(10, maximum)).toBeUndefined()
    expect(statusBarFill(undefined, 50)).toBeUndefined()
  })

  it('requires game scenes, unique IDs, and valid asset references while retaining old scene definitions', () => {
    const scene = {
      'schema-version': '1.0.0',
      id: 'room',
      title: 'Room',
      type: 'game',
      screen: { type: 'grid', grid: { rows: 3, columns: 3 } },
      components: [panel],
    }

    expect(sceneSchema.safeParse(scene).success).toBe(true)
    expect(() => sceneSchema.parse({ ...scene, type: 'stand-alone' })).toThrow('game scene')
    expect(() =>
      statusPanelComponentSchema.parse({ ...panel, rows: [panel.rows[0], panel.rows[0]] }),
    ).toThrow('unique')
    expect(
      sceneSchema.safeParse({
        ...scene,
        components: [
          { id: 'plain', type: 'text', text: 'Old game', placement: { row: 1, column: 1 } },
        ],
      }).success,
    ).toBe(true)
    expect(statusPanelIssues({ ...panel, portrait: 'missing' })).toHaveLength(1)

    const assets = assetCatalogSchema.parse({
      'schema-version': '1.0.0',
      images: {
        face: { format: 'svg', source: 'face.svg', bounds: { x: 0, y: 0, width: 10, height: 10 } },
      },
    })

    expect(
      statusPanelIssues(
        { ...panel, portrait: 'face', effects: [{ ...panel.effects[0]!, icon: 'face' }] },
        assets,
      ),
    ).toEqual([])
    expect(
      statusPanelIssues(
        { ...panel, effects: [{ ...panel.effects[0]!, icon: 'missing' }] },
        assets,
      )[0]!.path,
    ).toEqual(['effects', 0, 'icon'])
  })

  it('edits and removes panels without losing extensions and protects referenced rule fields', () => {
    const scene = {
      'schema-version': '1.0.0',
      id: 'room',
      title: 'Room',
      type: 'game',
      screen: { type: 'grid', grid: { rows: 3, columns: 3 } },
      components: [],
    }

    const state = [
      { path: ['health'], value: 40 },
      { path: ['poisoned'], value: false },
    ]

    const project = {
      revision: 'one',
      documents: {
        'game.json': {
          'schema-version': '1.0.0',
          id: 'status',
          title: 'Status',
          version: '1',
          scenes: ['room'],
          rules: ['state'],
        },
        'scenes/room.json': scene,
        'rules/state.json': { state, actions: {} },
      },
    }

    const created = applyCommand(project, {
      type: 'scene.upsertStatusPanel',
      sceneId: 'room',
      component: panel,
    })

    const raw = object(created.project.documents['scenes/room.json'])

    const extended = {
      ...created.project,
      documents: {
        ...created.project.documents,
        'scenes/room.json': {
          ...raw,
          extension: 'scene',
          components: [
            { ...panel, extension: 'panel', rows: [{ ...panel.rows[0]!, extension: 'row' }] },
          ],
        },
      },
    }

    const updated = applyCommand(extended, {
      type: 'scene.upsertStatusPanel',
      sceneId: 'room',
      component: { ...panel, label: 'Updated' },
    })

    const saved = object(updated.project.documents['scenes/room.json'])
    expect(saved.extension).toBe('scene')
    expect(saved.components).toEqual([
      expect.objectContaining({
        extension: 'panel',
        label: 'Updated',
        rows: [expect.objectContaining({ extension: 'row' })],
      }),
    ])
    expect(inspectProject(updated.project).scenes[0]!.components[0]!.type).toBe('status-panel')

    for (const fields of [
      state.slice(1),
      [{ path: ['health'], value: 'wrong' }, state[1]!],
      [state[0]!, { path: ['poisoned'], value: 'wrong' }],
    ]) {
      expect(() =>
        applyCommand(updated.project, {
          type: 'game.updateRules',
          ruleId: 'state',
          rules: { state: fields, actions: {} },
        }),
      ).toThrow('status panel bindings')
    }

    expect(
      validateProject({
        ...updated.project.documents,
        'scenes/room.json': { ...scene, components: [{ ...panel, portrait: 'missing' }] },
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_status_panel' })]))

    const removed = applyCommand(updated.project, {
      type: 'scene.removeStatusPanel',
      sceneId: 'room',
      componentId: 'player',
    })

    expect(inspectProject(removed.project).scenes[0]!.components).toEqual([])
  })
})
