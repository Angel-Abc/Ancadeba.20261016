import {
  MapDraftError,
  type MapDraft,
  type TilePoint,
  type TileRectangle,
  type TileMoveSource,
} from './mapDraft.js'

export type MapTileTool = 'paint' | 'select' | 'paste' | 'trigger' | 'object'

interface SelectedTiles {
  layer: string
  rectangle: TileRectangle
}

interface TileClipboard {
  tiles: (string | null)[][]
  source?: TileMoveSource
}

const contains = (rectangle: TileRectangle, point: TilePoint) =>
  point.x >= rectangle.x &&
  point.y >= rectangle.y &&
  point.x < rectangle.x + rectangle.width &&
  point.y < rectangle.y + rectangle.height

/** An editor-local clipboard: map data changes only when a validated paste commits. */
export class MapTileSelection {
  tool: MapTileTool = 'paint'
  selected: SelectedTiles | undefined
  anchor: TilePoint | undefined
  hover: TilePoint | undefined
  skipEmpty = true
  private groundReplacement = ''
  private clipboard: TileClipboard | undefined

  get groundFill() {
    return this.groundReplacement
  }
  set groundFill(value: string) {
    this.groundReplacement = value

    if (this.clipboard?.source && !this.clipboard.source.layer) this.clipboard.source.fill = value
  }

  get size() {
    return this.clipboard
      ? { width: this.clipboard.tiles[0]!.length, height: this.clipboard.tiles.length }
      : undefined
  }
  get moving() {
    return this.clipboard?.source !== undefined
  }

  reconcile(draft: MapDraft, layer: string) {
    if (!Object.hasOwn(draft.data.terrain, this.groundFill))
      this.groundFill = draft.data.tiles[0]?.[0] ?? Object.keys(draft.data.terrain)[0] ?? ''

    if (this.selected) {
      const rect = this.selected.rectangle

      if (
        this.selected.layer !== layer ||
        rect.x + rect.width > draft.data.width ||
        rect.y + rect.height > draft.data.height
      ) {
        this.selected = undefined
        this.anchor = undefined
      }
    }
  }

  begin(layer: string, point: TilePoint) {
    this.anchor = { ...point }
    this.selected = { layer, rectangle: { ...point, width: 1, height: 1 } }
  }
  extend(layer: string, point: TilePoint) {
    if (!this.anchor || this.selected?.layer !== layer) {
      this.begin(layer, point)

      return
    }

    const x = Math.min(this.anchor.x, point.x)
    const y = Math.min(this.anchor.y, point.y)
    this.selected = {
      layer,
      rectangle: {
        x,
        y,
        width: Math.abs(point.x - this.anchor.x) + 1,
        height: Math.abs(point.y - this.anchor.y) + 1,
      },
    }
  }
  isSelected(layer: string, point: TilePoint) {
    return this.selected?.layer === layer && contains(this.selected.rectangle, point)
  }

  copy(draft: MapDraft, layer: string, cut = false) {
    if (this.selected?.layer !== layer) throw new MapDraftError('invalidSelection')
    const rectangle = { ...this.selected.rectangle }
    const tiles = draft.copyRegion(rectangle, layer)
    this.clipboard = {
      tiles,
      ...(cut ? { source: { layer, rectangle, fill: layer ? null : this.groundFill } } : {}),
    }
    this.tool = 'paste'
    this.hover = { x: rectangle.x, y: rectangle.y }
  }

  setTool(tool: MapTileTool) {
    if (tool !== 'paste' && this.clipboard) delete this.clipboard.source
    this.tool = tool
    this.hover = undefined
  }
  cancel() {
    if (this.tool === 'paste') this.setTool('select')
    else {
      this.selected = undefined
      this.anchor = undefined
    }
  }

  preview(point: TilePoint, draft: MapDraft) {
    const size = this.size

    if (
      this.tool !== 'paste' ||
      !size ||
      !this.hover ||
      !contains({ ...this.hover, ...size }, point)
    )
      return undefined

    return {
      value: this.clipboard!.tiles[point.y - this.hover.y]![point.x - this.hover.x] ?? null,
      valid:
        this.hover.x >= 0 &&
        this.hover.y >= 0 &&
        this.hover.x + size.width <= draft.data.width &&
        this.hover.y + size.height <= draft.data.height,
    }
  }

  paste(draft: MapDraft, layer: string, point: TilePoint): boolean {
    if (!this.clipboard) throw new MapDraftError('invalidSelection')

    const changed = draft.pasteRegion(
      this.clipboard.tiles,
      point,
      layer,
      !layer || this.skipEmpty,
      this.clipboard.source,
    )

    this.selected = { layer, rectangle: { ...point, ...this.size! } }
    this.anchor = { ...point }
    delete this.clipboard.source
    this.hover = { ...point }

    return changed
  }
}
