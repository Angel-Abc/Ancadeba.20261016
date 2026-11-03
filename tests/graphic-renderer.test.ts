/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  assetCatalogSchema,
  graphicAppearanceSchema,
  graphicComponentSchema,
} from '@ancadeba/schemas'
import {
  GraphicComponentRenderer,
  type GraphicLease,
  type IGraphicResources,
} from '@ancadeba/ui-components'

// A deliberately small DOM surface exercises asynchronous ownership without a browser singleton.
class Surface {
  readonly children: Surface[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly classes = new Set<string>()
  readonly classList = {
    add: (value: string) => this.classes.add(value),
    remove: (value: string) => this.classes.delete(value),
    contains: (value: string) => this.classes.has(value),
  }
  className = ''
  hidden = false
  textContent = ''
  parent: Surface | undefined
  constructor(
    readonly ownerDocument: SurfaceDocument,
    readonly tagName: string,
  ) {}
  append(...children: Surface[]) {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }
  replaceChildren(...children: Surface[]) {
    for (const child of [...this.children]) child.remove()
    this.textContent = ''
    this.append(...children)
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value)
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null
  }
  removeAttribute(key: string) {
    this.attributes.delete(key)
  }
  querySelector(selector: string): Surface | null {
    for (const child of this.children) {
      if (
        selector.startsWith('.')
          ? child.className === selector.slice(1)
          : child.tagName === selector
      )
        return child
      const descendant = child.querySelector(selector)

      if (descendant) return descendant
    }

    return null
  }
}

class SurfaceDocument {
  createElement(name: string) {
    return new Surface(this, name)
  }
  createElementNS(_namespace: string, name: string) {
    return this.createElement(name)
  }
  asDocument(): Document {
    // @ts-expect-error -- This partial DOM fixture supplies only the operations used by the graphic renderer.
    return this
  }
}

const catalog = assetCatalogSchema.parse({
  'schema-version': '1.0.0',
  images: {
    art: {
      format: 'svg',
      source: 'art.svg',
      bounds: { x: 0, y: 0, width: 20, height: 30 },
      colors: { fabric: '#123456' },
    },
  },
})

const component = graphicComponentSchema.parse({
  id: 'art',
  type: 'graphic',
  visual: 'art',
  alt: 'Tunic',
  placement: { row: 1, column: 1 },
})

describe('asynchronous graphic rendering', () => {
  it('keeps a complete appearance visible and ignores late older results', async () => {
    const document = new SurfaceDocument()
    const pending: { color: string; finish: (lease: GraphicLease) => void }[] = []

    const graphics: IGraphicResources = {
      acquire: (piece) =>
        new Promise((finish) => {
          pending.push({ color: piece.colors.fabric!, finish })
        }),
    }

    const rendered = new GraphicComponentRenderer().render(component, {
      document: document.asDocument(),
      assets: catalog,
      graphics,
    })

    const release = vi.fn()
    pending[0]!.finish({ url: 'first', release })
    await vi.waitFor(() =>
      expect(rendered.element.querySelector('image')?.getAttribute('href')).toBe('first'),
    )
    rendered.setAppearance(graphicAppearanceSchema.parse({ colors: { fabric: '#abcdef' } }))
    expect(rendered.element.querySelector('image')?.getAttribute('href')).toBe('first')
    rendered.setAppearance(graphicAppearanceSchema.parse({ colors: { fabric: '#fedcba' } }))
    const staleRelease = vi.fn()
    const latestRelease = vi.fn()
    pending[2]!.finish({ url: 'latest', release: latestRelease })
    await vi.waitFor(() =>
      expect(rendered.element.querySelector('image')?.getAttribute('href')).toBe('latest'),
    )
    expect(release).toHaveBeenCalledTimes(1)
    pending[1]!.finish({ url: 'stale', release: staleRelease })
    await vi.waitFor(() => expect(staleRelease).toHaveBeenCalledTimes(1))
    expect(rendered.element.querySelector('image')?.getAttribute('href')).toBe('latest')
    rendered.dispose()
    expect(latestRelease).toHaveBeenCalledTimes(1)
  })

  it('disposes subscriptions and releases a load that finishes after scene disposal', async () => {
    const document = new SurfaceDocument()
    let finish: ((lease: GraphicLease) => void) | undefined
    const unsubscribe = vi.fn()
    const release = vi.fn()

    const rendered = new GraphicComponentRenderer().render(component, {
      document: document.asDocument(),
      assets: catalog,
      graphics: {
        acquire: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      },
      bindings: {
        read: () => ({ status: 'resolved', value: true }),
        subscribeChanges: () => unsubscribe,
      },
    })

    rendered.dispose()
    rendered.dispose()
    finish!({ url: 'late', release })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(rendered.element.children.length).toBe(0)
  })

  it('shows an accessible diagnostic placeholder after a failed source', async () => {
    const rendered = new GraphicComponentRenderer().render(component, {
      document: new SurfaceDocument().asDocument(),
      assets: catalog,
      bindingMode: 'editor',
      graphics: {
        acquire: async () => {
          throw new Error('art.svg: missing file')
        },
      },
    })

    await vi.waitFor(() =>
      expect(rendered.element.dataset.graphicDiagnostics).toContain('missing file'),
    )
    expect(rendered.element.getAttribute('aria-label')).toContain('unavailable')
    expect(rendered.element.querySelector('.ancadeba-graphic-diagnostic')?.textContent).toContain(
      'art.svg',
    )
    rendered.dispose()
  })
})
