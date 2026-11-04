import type {
  ButtonComponentData,
  IGameActions,
  IGameBindings,
  SceneComponentData,
  TextResolutionOptions,
  IGameLocalization,
  IGameInventory,
} from '@ancadeba/game-runtime'
import type { AssetCatalog, InventoryDefinition } from '@ancadeba/schemas'
import type { IGraphicResources } from './graphicResources.js'

type SceneNavigation = Exclude<
  NonNullable<ButtonComponentData['action']>,
  { type: 'request-action' }
>

export interface ComponentRendererOptions {
  readonly assets?: AssetCatalog | undefined
  readonly graphics?: IGraphicResources | undefined
  readonly localization?: IGameLocalization | undefined
  readonly bindingMode?: TextResolutionOptions['mode']
  readonly onButtonActivate?: (action: SceneNavigation) => void
}

export interface ComponentRenderContext extends ComponentRendererOptions {
  readonly document: Document
  readonly bindings?: IGameBindings | undefined
  readonly actions?: IGameActions | undefined
  readonly inventory?: IGameInventory | undefined
  readonly inventoryDefinition?: InventoryDefinition | undefined
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
