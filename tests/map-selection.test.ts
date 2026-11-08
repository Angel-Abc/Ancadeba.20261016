import { describe, expect, it } from 'vite-plus/test'
import { MapDraft } from '../apps/editor-ui/src/mapDraft.js'
import { MapTileSelection } from '../apps/editor-ui/src/mapTileSelection.js'

function building() {
  const draft = new MapDraft()
  draft.resize(10, 6, 'ground')
  draft.addTerrain('roof')
  draft.addTerrain('door')
  draft.addLayer('buildings')
  draft.addLayer('decoration')
  draft.paint(1, 1, 'roof', 'buildings')
  draft.paint(2, 1, 'roof', 'buildings')
  draft.paint(1, 2, 'wall', 'buildings')
  draft.paint(2, 2, 'door', 'buildings')
  draft.paint(3, 2, 'wall', 'buildings')
  const selection = new MapTileSelection()
  selection.reconcile(draft, 'buildings')
  selection.begin('buildings', { x: 3, y: 2 })
  selection.extend('buildings', { x: 1, y: 1 })

  return { draft, selection }
}

describe('map tile selections', () => {
  it('copies a reversed rectangle, pastes it repeatedly, and skips empty cells on the target layer', () => {
    const { draft, selection } = building()
    selection.copy(draft, 'buildings')
    expect(selection.size).toEqual({ width: 3, height: 2 })
    selection.hover = { x: 5, y: 1 }
    expect(selection.preview({ x: 7, y: 1 }, draft)).toMatchObject({ value: null, valid: true })
    draft.paint(7, 1, 'door', 'buildings')
    expect(selection.paste(draft, 'buildings', { x: 5, y: 1 })).toBe(true)
    expect(draft.copyRegion({ x: 5, y: 1, width: 3, height: 2 }, 'buildings')).toEqual([
      ['roof', 'roof', 'door'],
      ['wall', 'door', 'wall'],
    ])
    selection.skipEmpty = false
    selection.paste(draft, 'buildings', { x: 5, y: 1 })
    expect(draft.tile(7, 1, 'buildings')).toBeNull()
    selection.paste(draft, 'buildings', { x: 5, y: 4 })
    expect(draft.tile(6, 5, 'buildings')).toBe('door')
    expect(draft.data.tiles.every((row) => row.every((tile) => tile === 'ground'))).toBe(true)
    expect(draft.data.layers![1]!.tiles.every((row) => row.every((tile) => tile === null))).toBe(
      true,
    )
  })

  it('keeps cut source tiles intact until a valid paste and moves overlapping groups without losing tiles', () => {
    const { draft, selection } = building()
    const source = draft.copyRegion(selection.selected!.rectangle, 'buildings')
    selection.copy(draft, 'buildings', true)
    const before = JSON.stringify(draft.data)
    expect(selection.moving).toBe(true)
    expect(() => selection.paste(draft, 'buildings', { x: 9, y: 5 })).toThrow('pasteOutsideMap')
    expect(JSON.stringify(draft.data)).toBe(before)
    expect(selection.moving).toBe(true)
    selection.paste(draft, 'buildings', { x: 2, y: 1 })
    expect(draft.copyRegion({ x: 2, y: 1, width: 3, height: 2 }, 'buildings')).toEqual(source)
    expect(draft.tile(1, 1, 'buildings')).toBeNull()
    expect(draft.tile(1, 2, 'buildings')).toBeNull()
    expect(selection.moving).toBe(false)
    selection.paste(draft, 'decoration', { x: 5, y: 3 })
    expect(draft.tile(6, 4, 'decoration')).toBe('door')
    expect(draft.tile(3, 2, 'buildings')).toBe('door')
  })

  it('cancels a pending move without changes and rejects stale cut data atomically', () => {
    const { draft, selection } = building()
    selection.copy(draft, 'buildings', true)
    const before = JSON.stringify(draft.data)
    selection.cancel()
    expect(selection.moving).toBe(false)
    expect(JSON.stringify(draft.data)).toBe(before)
    selection.copy(draft, 'buildings', true)
    draft.paint(1, 1, 'wall', 'buildings')
    const edited = JSON.stringify(draft.data)
    expect(() => selection.paste(draft, 'decoration', { x: 5, y: 3 })).toThrow('cutSourceChanged')
    expect(JSON.stringify(draft.data)).toBe(edited)
  })

  it('takes detached snapshots, supports copying between layers, and rejects deleted terrain IDs', () => {
    const { draft, selection } = building()
    selection.copy(draft, 'buildings')
    draft.paint(1, 1, 'door', 'buildings')
    selection.reconcile(draft, 'decoration')
    expect(selection.selected).toBeUndefined()
    selection.paste(draft, 'decoration', { x: 5, y: 1 })
    expect(draft.tile(5, 1, 'decoration')).toBe('roof')
    draft.removeTerrain('roof', 'wall')
    const before = JSON.stringify(draft.data)
    expect(() => selection.paste(draft, 'decoration', { x: 1, y: 4 })).toThrow(
      'clipboardTerrainMissing',
    )
    expect(JSON.stringify(draft.data)).toBe(before)
  })

  it('moves ground selections with replacement terrain, leaves valid ground under empty clipboard cells, and validates malformed transfers', () => {
    const { draft, selection } = building()
    draft.paint(1, 1, 'roof')
    draft.paint(2, 1, 'door')
    selection.begin('', { x: 1, y: 1 })
    selection.extend('', { x: 2, y: 1 })
    selection.groundFill = 'ground'
    selection.copy(draft, '', true)
    selection.paste(draft, '', { x: 5, y: 1 })
    expect(draft.data.tiles[1]!.slice(1, 3)).toEqual(['ground', 'ground'])
    expect(draft.data.tiles[1]!.slice(5, 7)).toEqual(['roof', 'door'])
    selection.begin('buildings', { x: 1, y: 1 })
    selection.extend('buildings', { x: 3, y: 2 })
    selection.copy(draft, 'buildings')
    selection.skipEmpty = false
    selection.paste(draft, '', { x: 5, y: 3 })
    expect(draft.tile(7, 3)).toBe('ground')
    const before = JSON.stringify(draft.data)
    expect(() => draft.pasteRegion([['wall'], []], { x: 0, y: 0 })).toThrow('invalidSelection')
    expect(() => draft.pasteRegion([[null]], { x: 0, y: 0 }, '', false)).toThrow(
      'invalidGroundFill',
    )
    expect(() => draft.pasteRegion([['wall']], { x: -1, y: 0 })).toThrow('pasteOutsideMap')
    expect(JSON.stringify(draft.data)).toBe(before)
  })

  it('clears a selection cropped by resizing and reports invalid paste previews without changing data', () => {
    const { draft, selection } = building()
    selection.copy(draft, 'buildings')
    selection.hover = { x: 9, y: 5 }
    expect(selection.preview({ x: 9, y: 5 }, draft)).toMatchObject({ valid: false, value: 'roof' })
    draft.resize(2, 2, 'ground')
    selection.reconcile(draft, 'buildings')
    expect(selection.selected).toBeUndefined()
    expect(selection.size).toEqual({ width: 3, height: 2 })
  })
})
