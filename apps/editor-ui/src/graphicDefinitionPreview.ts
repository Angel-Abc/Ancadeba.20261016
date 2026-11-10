import type { Translate } from '@ancadeba/utilities'
import type { AssetCatalog, GraphicAppearance } from '@ancadeba/schemas'
import type { RenderedGraphic } from '@ancadeba/ui-components'

export type GraphicDefinitionPreviewFactory = (
  catalog: AssetCatalog,
  id: string,
  appearance: GraphicAppearance,
) => RenderedGraphic | undefined

/** Uses the runtime renderer and overlays attachment markers in the same coordinate system. */
export function graphicDefinitionPreview(
  root: HTMLElement,
  create: GraphicDefinitionPreviewFactory | undefined,
  t: Translate,
) {
  let graphic: RenderedGraphic | undefined

  return {
    clear(message = '') {
      graphic?.dispose()
      graphic = undefined
      root.replaceChildren()

      if (message) {
        const help = root.ownerDocument.createElement('p')
        help.textContent = message
        root.append(help)
      }
    },
    render(catalog: AssetCatalog, id: string, appearance: GraphicAppearance) {
      this.clear()

      if (!create) return
      graphic = create(catalog, id, appearance)

      if (!graphic) return
      root.append(graphic.element)
      const definition = catalog.parts[id] ?? catalog.compositions[id]

      if (!definition) return

      const points =
        catalog.compositions[id]?.anchors ??
        Object.fromEntries(
          (catalog.parts[id]?.pieces ?? []).map((piece) => [piece.id, piece.sourceAnchor]),
        )

      const document = root.ownerDocument
      const namespace = 'http://www.w3.org/2000/svg'
      const overlay = document.createElementNS(namespace, 'svg')
      const { x, y, width, height } = definition.bounds
      overlay.setAttribute('viewBox', `${x} ${y} ${width} ${height}`)
      overlay.setAttribute('preserveAspectRatio', 'xMidYMid meet')
      overlay.setAttribute('role', 'img')
      overlay.setAttribute('aria-label', t('definitions.attachmentPoints'))
      overlay.classList.add('definition-anchor-overlay')
      const size = Math.max(width, height) / 60

      for (const [name, point] of Object.entries(points)) {
        const circle = document.createElementNS(namespace, 'circle')
        circle.setAttribute('cx', String(point.x))
        circle.setAttribute('cy', String(point.y))
        circle.setAttribute('r', String(size))
        const text = document.createElementNS(namespace, 'text')
        text.setAttribute('x', String(point.x + size * 2))
        text.setAttribute('y', String(point.y - size))
        text.setAttribute('font-size', String(size * 3))
        text.textContent = name
        overlay.append(circle, text)
      }

      root.append(overlay)
    },
  }
}
