import {
  applyCommand,
  componentSourceSchema,
  createStarterProject,
  object,
  validateProject,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import { describe, expect, it } from 'vite-plus/test'

function project(): ProjectSnapshot {
  const documents = createStarterProject({ path: 'game', title: 'Clipboard test', description: '' })
  const source = object(documents['scenes/adventure.json'])

  return {
    revision: 'one',
    documents: {
      ...documents,
      'game.json': { ...object(documents['game.json']), scenes: ['start', 'adventure', 'target'] },
      'scenes/target.json': { ...source, id: 'target', components: [], custom: { keep: true } },
    },
  }
}

const button = {
  id: 'source',
  type: 'button',
  label: 'Visit',
  placement: { row: 2, column: 2, rowSpan: 2, columnSpan: 3, extension: { keep: true } },
  action: { type: 'enter-scene', scene: 'start', extension: { keep: ['nested'] } },
  extension: { text: 'source', nested: [{ id: 'source' }] },
}

describe('pasting component snapshots', () => {
  it('preserves complete raw settings, nested extensions, and references without modifying source objects', () => {
    const initial = project()
    const before = JSON.stringify(initial)
    const snapshot = JSON.stringify(button)

    const result = applyCommand(initial, {
      type: 'scene.pasteComponent',
      sceneId: 'target',
      newId: 'pasted',
      component: button,
    })

    expect(object(result.project.documents['scenes/target.json']).components).toEqual([
      { ...button, id: 'pasted' },
    ])
    expect(object(result.project.documents['scenes/target.json']).custom).toEqual({ keep: true })
    expect(result.changedFiles).toEqual(['scenes/target.json'])
    expect(JSON.stringify(initial)).toBe(before)
    expect(JSON.stringify(button)).toBe(snapshot)
    expect(validateProject(result.project.documents)).toEqual([])
  })

  it('checks the destination grid and preserves placement extensions when an override fits a smaller scene', () => {
    const initial = project()
    const source = object(initial.documents['scenes/target.json'])

    const small = {
      ...initial,
      documents: {
        ...initial.documents,
        'scenes/target.json': {
          ...source,
          screen: { type: 'grid', grid: { rows: 2, columns: 2 } },
        },
      },
    }

    const paste: EditorCommand = {
      type: 'scene.pasteComponent',
      sceneId: 'target',
      newId: 'copy',
      component: button,
    }

    expect(() => applyCommand(small, paste)).toThrow('invalid project')

    const pasted = applyCommand(small, {
      ...paste,
      placement: { row: 1, column: 1, rowSpan: 2, columnSpan: 2 },
    })

    expect(object(pasted.project.documents['scenes/target.json']).components).toEqual([
      {
        ...button,
        id: 'copy',
        placement: { row: 1, column: 1, rowSpan: 2, columnSpan: 2, extension: { keep: true } },
      },
    ])
  })

  it('requires local component references in the destination and allows copying dependencies first', () => {
    const nearby = {
      id: 'nearby',
      type: 'nearby',
      label: 'Nearby',
      placement: { row: 1, column: 1 },
      descriptionTarget: 'narrative',
      entries: {},
    }

    const paste: EditorCommand = {
      type: 'scene.pasteComponent',
      sceneId: 'target',
      newId: 'nearby',
      component: nearby,
    }

    expect(() => applyCommand(project(), paste)).toThrow('invalid project')

    const withText = applyCommand(project(), {
      type: 'scene.pasteComponent',
      sceneId: 'target',
      newId: 'narrative',
      component: { id: 'narrative', type: 'text', text: 'Text', placement: { row: 1, column: 1 } },
    }).project

    expect(validateProject(applyCommand(withText, paste).project.documents)).toEqual([])
  })

  it('allows singleton components in empty game destinations and rejects singleton or scene-type conflicts', () => {
    const bar = { id: 'actions', type: 'action-bar', placement: { row: 1, column: 1 }, slots: {} }

    const paste: EditorCommand = {
      type: 'scene.pasteComponent',
      sceneId: 'target',
      newId: 'bar',
      component: bar,
    }

    const result = applyCommand(project(), paste)
    expect(() => applyCommand(result.project, { ...paste, newId: 'bar-2' })).toThrow(
      'invalid project',
    )
    expect(() => applyCommand(project(), { ...paste, sceneId: 'start' })).toThrow('invalid project')
  })

  it('rejects overwrites, absent scenes, invalid IDs, and malformed component data', () => {
    const initial = project()
    const before = JSON.stringify(initial)

    const paste: EditorCommand = {
      type: 'scene.pasteComponent',
      sceneId: 'adventure',
      newId: 'menu',
      component: button,
    }

    expect(() => applyCommand(initial, paste)).toThrow('already exists')
    expect(() => applyCommand(initial, { ...paste, sceneId: 'missing' })).toThrow(
      'Scene does not exist',
    )
    expect(() => applyCommand(initial, { ...paste, newId: '../bad' })).toThrow(
      'Invalid editing command',
    )
    expect(componentSourceSchema.safeParse({ ...button, type: 'invalid' }).success).toBe(false)
    expect(JSON.stringify(initial)).toBe(before)
  })
})
