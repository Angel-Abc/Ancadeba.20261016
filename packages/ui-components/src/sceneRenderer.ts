import type { IGameLifecycle, SceneInstance } from '@ancadeba/game-runtime'
import { ComponentRenderer } from './componentRenderer.js'
import type {
  ComponentRenderContext,
  ComponentRendererOptions,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

export type SceneRendererOptions = ComponentRendererOptions

/** Renders only the active scene. Geometry comes from data; appearance comes from CSS. */
export class SceneRenderer {
  private scene: RenderedComponent | undefined
  private unsubscribe: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly target: HTMLElement,
    private readonly lifecycle: IGameLifecycle,
    private readonly options: SceneRendererOptions = {},
    private readonly components: IComponentRenderer = new ComponentRenderer(),
  ) {
    try {
      this.render(lifecycle.activeScene)
      this.unsubscribe = lifecycle.subscribeSceneChanges(({ current }) => this.render(current))
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    const scene = this.scene
    this.scene = undefined
    scene?.dispose()
  }

  private render(scene: SceneInstance | undefined): void {
    if (this.disposed) return
    const next = scene ? this.createScene(scene) : undefined
    const previous = this.scene
    this.scene = undefined
    try {
      previous?.dispose()
      if (next) this.target.append(next.element)
      this.scene = next
    } catch (error) {
      next?.dispose()
      throw error
    }
  }

  private createScene(scene: SceneInstance): RenderedComponent {
    const data = scene.data
    const document = this.target.ownerDocument
    const root = document.createElement('section')
    root.className = 'ancadeba-scene'
    root.dataset.sceneId = data.id
    root.setAttribute('aria-label', data.title)
    root.style.setProperty('--ge-scene-grid-rows', `${data.screen.grid.rows}`)
    root.style.setProperty('--ge-scene-grid-columns', `${data.screen.grid.columns}`)

    const components: RenderedComponent[] = []
    let active = true
    const rendered: RenderedComponent = {
      element: root,
      dispose() {
        if (!active) return
        active = false
        const errors: unknown[] = []
        try {
          for (const component of components.splice(0)) {
            try {
              component.dispose()
            } catch (error) {
              errors.push(error)
            }
          }
        } finally {
          root.remove()
        }
        if (errors.length) throw new AggregateError(errors, 'Scene component cleanup failed')
      },
    }
    const context: ComponentRenderContext = {
      ...this.options,
      document,
      bindings: scene.type === 'game' ? scene.game.bindings : undefined,
    }
    try {
      for (const component of data.components) {
        const rendered = this.components.render(component, context)
        components.push(rendered)
        const { element } = rendered
        element.dataset.componentId = component.id
        const { row, column, rowSpan, columnSpan } = component.placement
        element.style.setProperty('--ge-component-row', String(row))
        element.style.setProperty('--ge-component-column', String(column))
        element.style.setProperty('--ge-component-row-span', String(rowSpan))
        element.style.setProperty('--ge-component-column-span', String(columnSpan))
        root.append(element)
      }
      return rendered
    } catch (error) {
      rendered.dispose()
      throw error
    }
  }
}
