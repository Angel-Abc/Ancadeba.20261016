import type {
  ButtonComponentData,
  IGameActions,
  IGameBindings,
  SceneComponentData,
  TextResolutionOptions,
  IGameLocalization,
  IGameInventory,
  IGameSaves,
  SceneInstance,
} from '@ancadeba/game-runtime'
import type { AssetCatalog, InventoryDefinition, SceneTransition } from '@ancadeba/schemas'
import type { IGraphicResources } from './graphicResources.js'
import type { KeyboardInputSink } from './keyboardInput.js'

type SceneNavigation = Extract<
  NonNullable<ButtonComponentData['action']>,
  { type: 'new-game' | 'enter-scene' }
>

export interface ComponentRendererOptions {
  readonly saves?: IGameSaves | undefined
  readonly onLoadGame?: (() => void) | undefined
  readonly input?: KeyboardInputSink | undefined
  readonly assets?: AssetCatalog | undefined
  readonly graphics?: IGraphicResources | undefined
  readonly localization?: IGameLocalization | undefined
  readonly bindingMode?: TextResolutionOptions['mode']
  readonly onButtonActivate?: (action: SceneNavigation) => void
  readonly canEnterScene?: (action: SceneTransition) => boolean
  readonly subscribeNavigationChanges?: (listener: () => void) => () => void
  readonly navigationUnavailableMessage?: () => string
}

export interface ComponentRenderContext extends ComponentRendererOptions {
  readonly scene?: SceneInstance | undefined
  readonly onActionBarFocusLost?: (() => void) | undefined
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
