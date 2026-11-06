import type { SceneComponentData } from '@ancadeba/game-runtime'
import { ButtonComponentRenderer } from './buttonComponentRenderer.js'
import { TextComponentRenderer } from './textComponentRenderer.js'
import { LanguageSelectComponentRenderer } from './languageSelectComponentRenderer.js'
import { GraphicComponentRenderer } from './graphicComponentRenderer.js'
import { MapViewComponentRenderer } from './mapViewComponentRenderer.js'
import { InventoryComponentRenderer } from './inventoryComponentRenderer.js'
import { ActionBarComponentRenderer } from './actionBarComponentRenderer.js'
import { NearbyComponentRenderer } from './nearbyComponentRenderer.js'
import { StatusPanelComponentRenderer } from './statusPanelComponentRenderer.js'
import { ItemDetailsComponentRenderer } from './itemDetailsComponentRenderer.js'
import { EquipmentComponentRenderer } from './equipmentComponentRenderer.js'
import { ShopComponentRenderer } from './shopComponentRenderer.js'
import type {
  ComponentRenderContext,
  ComponentRenderers,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Dispatches component data to its typed renderer. Renderers can be supplied by the host. */
export class ComponentRenderer implements IComponentRenderer {
  private readonly renderers: ComponentRenderers
  constructor(renderers: Partial<ComponentRenderers> = {}) {
    this.renderers = {
      text: new TextComponentRenderer(),
      graphic: new GraphicComponentRenderer(),
      button: new ButtonComponentRenderer(),
      'language-select': new LanguageSelectComponentRenderer(),
      'map-view': new MapViewComponentRenderer(),
      inventory: new InventoryComponentRenderer(),
      'action-bar': new ActionBarComponentRenderer(),
      nearby: new NearbyComponentRenderer(),
      'status-panel': new StatusPanelComponentRenderer(),
      'item-details': new ItemDetailsComponentRenderer(),
      equipment: new EquipmentComponentRenderer(),
      shop: new ShopComponentRenderer(),
      ...renderers,
    }
  }

  render(component: SceneComponentData, context: ComponentRenderContext): RenderedComponent {
    switch (component.type) {
      case 'shop':
        return this.renderers.shop.render(component, context)
      case 'item-details':
        return this.renderers['item-details'].render(component, context)
      case 'equipment':
        return this.renderers.equipment.render(component, context)
      case 'status-panel':
        return this.renderers['status-panel'].render(component, context)
      case 'nearby':
        return this.renderers.nearby.render(component, context)
      case 'action-bar':
        return this.renderers['action-bar'].render(component, context)
      case 'graphic':
        return this.renderers.graphic.render(component, context)
      case 'text':
        return this.renderers.text.render(component, context)
      case 'button':
        return this.renderers.button.render(component, context)
      case 'language-select':
        return this.renderers['language-select'].render(component, context)
      case 'map-view':
        return this.renderers['map-view'].render(component, context)
      case 'inventory':
        return this.renderers.inventory.render(component, context)
      default: {
        const unsupported: never = component
        throw new Error(`Unsupported scene component: ${String(unsupported)}`)
      }
    }
  }
}
