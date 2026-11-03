import type {
  ButtonComponentData,
  IGameBindings,
  SceneComponentData,
  TextResolutionOptions,
  IGameLocalization,
} from '@ancadeba/game-runtime'

export interface ComponentRendererOptions {
  readonly localization?: IGameLocalization | undefined
  readonly bindingMode?: TextResolutionOptions['mode']
  readonly onButtonActivate?: (action: NonNullable<ButtonComponentData['action']>) => void
}

export interface ComponentRenderContext extends ComponentRendererOptions {
  readonly document: Document
  readonly bindings?: IGameBindings | undefined
}

export interface RenderedComponent {
  readonly element: HTMLElement
  dispose(): void
}

export interface IComponentRenderer<TComponent extends SceneComponentData = SceneComponentData> {
  render(component: TComponent, context: ComponentRenderContext): RenderedComponent
}

export type ComponentRenderers = {
  readonly [TType in SceneComponentData['type']]: IComponentRenderer<
    Extract<SceneComponentData, { type: TType }>
  >
}
