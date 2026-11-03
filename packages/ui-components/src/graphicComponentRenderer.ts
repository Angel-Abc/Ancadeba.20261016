import {
  resolveGraphic,
  type GraphicComponentData,
  type GraphicResolution,
} from '@ancadeba/game-runtime'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'
import type { GraphicLease } from './graphicResources.js'
import type { GraphicAppearance } from '@ancadeba/schemas'

export interface RenderedGraphic extends RenderedComponent {
  setAppearance(appearance: GraphicAppearance): void
}

const namespace = 'http://www.w3.org/2000/svg'

export class GraphicComponentRenderer implements IComponentRenderer<GraphicComponentData> {
  render(initial: GraphicComponentData, context: ComponentRenderContext): RenderedGraphic {
    let component = initial
    const { document } = context
    const root = document.createElement('div')
    root.className = 'ancadeba-graphic'
    root.setAttribute('role', 'img')

    if (component.alt) root.setAttribute('aria-label', component.alt)
    else root.setAttribute('aria-hidden', 'true')
    let active = true
    let generation = 0
    let leases: GraphicLease[] = []
    let signature = ''

    const release = (items: GraphicLease[]) => {
      for (const item of items) item.release()
    }

    const report = (messages: readonly string[]) => {
      root.dataset.graphicDiagnostics = messages.join('\n')
      const existing = root.querySelector('.ancadeba-graphic-diagnostic')
      existing?.remove()

      if (context.bindingMode === 'editor' && messages.length) {
        const label = document.createElement('span')
        label.className = 'ancadeba-graphic-diagnostic'
        label.textContent = messages.join('\n')
        root.append(label)
      }
    }

    const show = async (resolution: GraphicResolution, current: number) => {
      if (!context.graphics) throw new Error('The game host has no graphics resource service')

      const results = await Promise.allSettled(
        resolution.pieces.map((piece) => context.graphics!.acquire(piece)),
      )

      const next = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )

      if (!active || current !== generation) {
        release(next)

        return
      }

      const failed = results.find((result) => result.status === 'rejected')

      if (failed?.status === 'rejected') {
        release(next)
        throw failed.reason
      }

      const svg = document.createElementNS(namespace, 'svg')
      const { x, y, width, height } = resolution.bounds
      svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`)
      svg.setAttribute(
        'preserveAspectRatio',
        component.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet',
      )
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      resolution.pieces.forEach((piece, index) => {
        const group = document.createElementNS(namespace, 'g')
        group.setAttribute('transform', piece.transform)
        group.setAttribute('data-layer', piece.layer)
        const image = document.createElementNS(namespace, 'image')
        image.setAttribute('href', next[index]!.url)

        for (const key of ['x', 'y', 'width', 'height'] as const)
          image.setAttribute(key, String(piece.image.bounds[key]))
        group.append(image)
        svg.append(group)
      })
      root.replaceChildren(svg)
      root.classList.remove('ancadeba-graphic--unavailable')

      if (component.alt) root.setAttribute('aria-label', component.alt)
      else root.setAttribute('aria-hidden', 'true')
      release(leases)
      leases = next
      report(
        resolution.diagnostics.map((diagnostic) => `${diagnostic.target}: ${diagnostic.message}`),
      )
    }

    const update = () => {
      if (!active) return
      const current = ++generation

      try {
        if (!context.assets) throw new Error('The game has no asset catalogue')

        const resolution = resolveGraphic(
          context.assets,
          component.visual,
          component.appearance,
          context.bindings,
        )

        root.hidden = !resolution.visible
        const nextSignature = JSON.stringify(resolution)

        if (signature === nextSignature) {
          generation--

          return
        }

        signature = nextSignature

        if (!resolution.visible) {
          release(leases)
          leases = []
          root.replaceChildren()

          return
        }

        void show(resolution, current).catch((error: unknown) => failure(error, current))
      } catch (error) {
        failure(error, current)
      }
    }

    const failure = (error: unknown, current: number) => {
      if (!active || current !== generation) return
      signature = ''
      release(leases)
      leases = []
      root.replaceChildren()
      root.classList.add('ancadeba-graphic--unavailable')
      root.textContent = component.alt ? `${component.alt} — unavailable` : 'Graphic unavailable'
      root.removeAttribute('aria-hidden')
      root.setAttribute('aria-label', root.textContent)
      report([error instanceof Error ? error.message : String(error)])
    }

    const unsubscribe = context.bindings?.subscribeChanges(update)
    update()

    return {
      element: root,
      setAppearance(appearance) {
        component = { ...component, appearance }
        update()
      },
      dispose() {
        if (!active) return
        active = false
        generation++
        unsubscribe?.()
        release(leases)
        leases = []
        root.remove()
      },
    }
  }
}
