import { describe, expect, it } from 'vite-plus/test'
import { MapDraft } from '../apps/editor-ui/src/mapDraft.js'
import { MapDraftHistory } from '../apps/editor-ui/src/mapDraftHistory.js'

describe('map draft history', () => {
  it('restores detached ground, overlays, metadata and dimensions together in either direction', () => {
    const draft = new MapDraft()
    const initial = { map: structuredClone(draft.data), id: 'city' }
    const history = new MapDraftHistory(initial)
    draft.addLayer('buildings')
    draft.paint(1, 1, 'wall', 'buildings')
    history.record({ map: draft.data, id: 'city' }, 'buildings')
    const painted = structuredClone(draft.data)
    draft.resize(20, 14, 'wall')
    draft.data.terrain.wall!.walkable = true
    delete draft.data.terrain.ground!.color
    draft.data.tilesets = { sheet: { image: 'sheet', tileWidth: 32, tileHeight: 32 } }
    const resized = { map: structuredClone(draft.data), id: 'renamed' }
    history.record(resized, 'buildings')
    expect(history.undo()).toEqual({ state: { map: painted, id: 'city' }, layer: 'buildings' })
    expect(history.undo()?.state).toEqual(initial)
    expect(history.dirty).toBe(false)
    expect(history.undo()).toBeUndefined()
    expect(history.redo()?.state.map).toEqual(painted)
    expect(history.redo()?.state).toEqual(resized)
    expect(history.dirty).toBe(true)
    resized.map.tiles[0]![0] = 'wall'
    history.undo()!.state.map.tiles[0]![0] = 'wall'
    expect(history.redo()?.state.map.tiles[0]![0]).toBe('ground')
    expect(history.redo()).toBeUndefined()
  })

  it('coalesces one focused input session, breaks on a new action, and removes a reverted group', () => {
    const state = { map: new MapDraft().data, id: 'city' }
    const history = new MapDraftHistory(state)
    state.map.terrain.ground!.movementCostMs = 1
    history.record(state, '', 1)
    state.map.terrain.ground!.movementCostMs = 150
    history.record(state, '', 1)
    expect(history.undo()?.state.map.terrain.ground!.movementCostMs).toBeUndefined()
    expect(history.redo()?.state.map.terrain.ground!.movementCostMs).toBe(150)
    history.breakGroup()
    state.map.terrain.ground!.movementCostMs = 200
    history.record(state, '', 1)
    expect(history.undo()?.state.map.terrain.ground!.movementCostMs).toBe(150)
    expect(history.undo()?.state.map.terrain.ground!.movementCostMs).toBeUndefined()
    history.reset(state)
    state.id = 'temporary'
    history.record(state, '', 2)
    state.id = 'city'
    history.record(state, '', 2)
    expect(history.active).toBe(false)
    expect(history.dirty).toBe(false)
  })

  it('retains redo for unchanged actions and clears it only after an actual edit', () => {
    const state = { map: new MapDraft().data, id: 'city' }
    const history = new MapDraftHistory(state)
    state.map.tiles[0]![0] = 'wall'
    history.record(state)
    const restored = history.undo()!.state
    expect(history.record(restored)).toBe(false)
    expect(history.canRedo).toBe(true)
    restored.map.tiles[0]![1] = 'wall'
    history.record(restored)
    expect(history.canRedo).toBe(false)
    expect(history.undo()?.state.map.tiles[0]!.slice(0, 2)).toEqual(['ground', 'ground'])
  })

  it('preserves absent fields, undefined and invalid numeric drafts exactly', () => {
    const state = { map: new MapDraft().data, id: 'city' }
    const history = new MapDraftHistory(state)
    state.map.terrain.ground!.movementCostMs = undefined
    history.record(state)
    state.map.terrain.ground!.movementCostMs = NaN
    history.record(state)
    expect(history.undo()?.state.map.terrain.ground).toHaveProperty('movementCostMs', undefined)
    expect(history.undo()?.state.map.terrain.ground).not.toHaveProperty('movementCostMs')
    history.redo()
    expect(history.redo()?.state.map.terrain.ground!.movementCostMs).toBeNaN()
  })

  it('bounds retained steps and bytes while keeping the latest oversized action undoable', () => {
    const state = { map: new MapDraft().data, id: 'city' }
    const history = new MapDraftHistory(state, 2)

    for (const id of ['one', 'two', 'three']) {
      state.id = id
      history.record(state)
    }

    expect(history.undo()?.state.id).toBe('two')
    expect(history.undo()?.state.id).toBe('one')
    expect(history.undo()).toBeUndefined()
    expect(history.dirty).toBe(true)
    const small = new MapDraftHistory(state, 100, 1)
    state.id = 'four'
    small.record(state)
    state.id = 'five'
    small.record(state)
    expect(small.undo()?.state.id).toBe('four')
    expect(small.undo()).toBeUndefined()
    expect(small.redo()?.state.id).toBe('five')
  })

  it('changes the saved baseline without discarding drafts or falsely marking an external edit clean', () => {
    const state = { map: new MapDraft().data, id: 'city' }
    const history = new MapDraftHistory(state)
    state.map.tiles[0]![0] = 'wall'
    history.record(state)
    const external = structuredClone(state)
    external.map.tiles[0]![1] = 'wall'
    history.setBaseline(external)
    expect(history.dirty).toBe(true)
    history.undo()
    expect(history.dirty).toBe(true)
    expect(history.redo()?.state).toEqual(state)
    history.reset(external)
    expect(history.active).toBe(false)
    expect(history.dirty).toBe(false)
  })
})
