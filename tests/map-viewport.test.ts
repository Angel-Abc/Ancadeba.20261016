import { describe, expect, it } from 'vite-plus/test'
import { MapViewport, mapGridViewport, mapZoomLevels } from '../apps/editor-ui/src/mapViewport.js'

describe('map viewport', () => {
  it('centers minimap destinations at the current zoom and clamps to every map edge', () => {
    const camera = new MapViewport(64, 40)
    camera.centerOn(32, 20)
    expect(camera).toMatchObject({ x: 21, y: 13, zoom: 100 })
    camera.zoomTo(200)
    camera.centerOn(32, 20)
    expect(camera).toMatchObject({ x: 27, y: 17, zoom: 200 })
    camera.centerOn(63, 39)
    expect(camera).toMatchObject({ x: 52, y: 32, zoom: 200 })
    camera.centerOn(0, 0)
    expect(camera).toMatchObject({ x: 0, y: 0 })
    const small = new MapViewport(2, 2)
    small.centerOn(1, 1)
    expect(small).toMatchObject({ x: 0, y: 0 })
  })
  it('scales the visible region while keeping the map center stable', () => {
    const camera = new MapViewport(100, 80)
    camera.moveTo(30, 20)
    camera.zoomTo(200)
    expect(camera).toMatchObject({ x: 36, y: 24, zoom: 200, columns: 12, rows: 8 })
    camera.zoomTo(100)
    expect(camera).toMatchObject({ x: 30, y: 20, columns: 24, rows: 16 })
    camera.zoomTo(50)
    expect(camera).toMatchObject({ x: 18, y: 12, columns: 48, rows: 32 })
    camera.zoomTo(100)

    for (let cycle = 0; cycle < 5; cycle++) {
      camera.zoomTo(125)
      camera.zoomTo(100)
    }

    expect(camera).toMatchObject({ x: 30, y: 20 })
  })

  it('anchors pointer zoom to the corresponding map location and clamps at edges', () => {
    const camera = new MapViewport(80, 60)
    camera.moveTo(10, 10)
    camera.zoomTo(200, { x: 0.25, y: 0.75 })
    expect(camera).toMatchObject({ x: 13, y: 16, columns: 12, rows: 8 })
    camera.pan(1000, 1000)
    expect(camera).toMatchObject({ x: 68, y: 52 })
    expect(camera.pan(1, 1)).toBe(false)
    camera.zoomTo(50, { x: 1, y: 1 })
    expect(camera).toMatchObject({ x: 32, y: 28, columns: 48, rows: 32 })
    camera.pan(-1000, -1000)
    expect(camera).toMatchObject({ x: 0, y: 0 })
  })

  it('bounds zoom and the rendered tile count, including narrow and small maps', () => {
    const camera = new MapViewport(65_536, 1)
    expect(camera.zoomTo(37)).toBe(false)

    for (const zoom of mapZoomLevels) {
      camera.zoomTo(zoom)
      expect(camera.columns * camera.rows).toBeLessThanOrEqual(1536)
      expect(camera.rows).toBe(1)
    }

    expect(camera.canZoomIn).toBe(false)
    expect(camera.zoomBy(1)).toBe(false)
    camera.zoomTo(50)
    expect(camera.canZoomOut).toBe(false)
    expect(camera.zoomBy(-1)).toBe(false)
    const small = new MapViewport(2, 2)
    small.zoomTo(400)
    small.pan(10, 10)
    expect(small).toMatchObject({ x: 0, y: 0, columns: 2, rows: 2 })
  })

  it('restores valid camera settings and clamps them after a resize', () => {
    const saved = { ...mapGridViewport(), zoom: 200, x: 40, y: 30 }
    expect(new MapViewport(80, 60, saved)).toMatchObject({ x: 40, y: 30, zoom: 200 })
    expect(new MapViewport(5, 3, saved)).toMatchObject({
      x: 0,
      y: 0,
      zoom: 200,
      columns: 5,
      rows: 3,
    })
    expect(new MapViewport(80, 60, { ...saved, zoom: 17 })).toMatchObject({ zoom: 100 })
  })
})
