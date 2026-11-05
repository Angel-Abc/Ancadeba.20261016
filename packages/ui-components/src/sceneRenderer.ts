import type { IGameLifecycle, SceneInstance } from '@ancadeba/game-runtime'
import { ComponentRenderer } from './componentRenderer.js'
import type {
  ComponentRenderContext,
  ComponentRendererOptions,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

export interface SceneRendererOptions extends ComponentRendererOptions {
  readonly onActionBarFocusLost?: () => void
}

/** Renders only the active scene. Geometry comes from data; appearance comes from CSS. */
export class SceneRenderer {
  private scene: RenderedComponent | undefined
  private unsubscribe: (() => void) | undefined
  private unsubscribeLanguage: (() => void) | undefined
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
      this.unsubscribeLanguage = options.localization?.subscribe(() =>
        this.render(lifecycle.activeScene),
      )
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
    this.unsubscribeLanguage?.()
    this.unsubscribeLanguage = undefined
    const scene = this.scene
    this.scene = undefined
    scene?.dispose()
  }

  private render(scene: SceneInstance | undefined): void {
    if (this.disposed) return
    const focused = this.target.ownerDocument.activeElement

    const focusedButton =
      focused && this.scene?.element.contains(focused) && focused.tagName === 'BUTTON'

    // SAFETY: this renderer creates only HTML elements inside its owned scene.
    const focusedId =
      focused && this.scene?.element.contains(focused)
        ? (focused as HTMLElement).dataset.componentId
        : undefined

    const next = scene ? this.createScene(scene) : undefined
    const previous = this.scene
    this.scene = undefined

    try {
      previous?.dispose()

      if (next) this.target.append(next.element)
      this.scene = next

      if (focusedId)
        next?.element
          .querySelector<HTMLElement>(`select[data-component-id="${focusedId}"]`)
          ?.focus()

      const active = this.target.ownerDocument.activeElement

      if (
        focusedButton &&
        (!active || active === focused || active === this.target.ownerDocument.body)
      )
        this.options.onActionBarFocusLost?.()
    } catch (error) {
      next?.dispose()
      throw error
    }
  }

  private createScene(scene: SceneInstance): RenderedComponent {
    const data = this.options.localization?.current.scenes.get(scene.data.id) ?? scene.data
    const document = this.target.ownerDocument
    const root = document.createElement('section')
    root.className = 'ancadeba-scene'
    root.dataset.sceneId = data.id
    root.setAttribute('aria-label', data.title)
    const { rows, columns, compactColumns } = data.screen.grid

    root.style.setProperty('--ge-scene-grid-rows', String(rows))
    root.style.setProperty('--ge-scene-grid-columns', String(columns))

    if (compactColumns)
      root.style.setProperty(
        '--ge-scene-compact-columns',
        compactColumns.map((weight) => `minmax(0, ${weight}fr)`).join(' '),
      )

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
      scene,
      onActionBarFocusLost: this.options.onActionBarFocusLost,
      bindings: scene.type === 'game' ? scene.game.bindings : undefined,
      actions: scene.type === 'game' ? scene.game.actions : undefined,
      inventory: scene.type === 'game' ? scene.game.inventory : undefined,
      inventoryDefinition: scene.type === 'game' ? scene.game.data.inventory : undefined,
    }

    try {
      for (const component of data.components) {
        const rendered = this.components.render(component, context)
        components.push(rendered)
        const { element } = rendered
        element.classList.add('ancadeba-scene-item')
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
