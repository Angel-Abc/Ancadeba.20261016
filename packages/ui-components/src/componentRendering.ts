import type {
  ButtonComponentData,
  IGameBindings,
  SceneComponentData,
  TextResolutionOptions,
  IGameLocalization,
  IGameInventory,
} from '@ancadeba/game-runtime'
import type { AssetCatalog, InventoryDefinition } from '@ancadeba/schemas'
import type { IGraphicResources } from './graphicResources.js'

export interface ComponentRendererOptions {
  readonly assets?: AssetCatalog | undefined
  readonly graphics?: IGraphicResources | undefined
  readonly localization?: IGameLocalization | undefined
  readonly bindingMode?: TextResolutionOptions['mode']
  readonly onButtonActivate?: (action: NonNullable<ButtonComponentData['action']>) => void
}

export interface ComponentRenderContext extends ComponentRendererOptions {
  readonly document: Document
  readonly bindings?: IGameBindings | undefined
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
