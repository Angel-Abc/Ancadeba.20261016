import { CharacterViewRenderer } from './characterViewRenderer.js'
import { FormRenderer } from './formRenderer.js'
import { QuestLogComponentRenderer } from './questLogComponentRenderer.js'
import { SaveSlotsComponentRenderer } from './saveSlotsComponentRenderer.js'
import { SaveStatusComponentRenderer } from './saveStatusComponentRenderer.js'
import { SavePointComponentRenderer } from './savePointComponentRenderer.js'
import { CharacterProgressionComponentRenderer } from './characterProgressionComponentRenderer.js'
import { CharacterSheetRenderer } from './characterProfileRenderer.js'
import type { SceneComponentData } from '@ancadeba/game-runtime'
import { ButtonComponentRenderer } from './buttonComponentRenderer.js'
import { TextComponentRenderer } from './textComponentRenderer.js'
import { MessageHistoryComponentRenderer } from './messageHistoryComponentRenderer.js'
import { LanguageSelectComponentRenderer } from './languageSelectComponentRenderer.js'
import { GraphicComponentRenderer } from './graphicComponentRenderer.js'
import { MapViewComponentRenderer } from './mapViewComponentRenderer.js'
import { InventoryComponentRenderer } from './inventoryComponentRenderer.js'
import { CraftingComponentRenderer } from './craftingComponentRenderer.js'
import { ActionBarComponentRenderer } from './actionBarComponentRenderer.js'
import { ActionInfoComponentRenderer } from './actionInfoComponentRenderer.js'
import { NearbyComponentRenderer } from './nearbyComponentRenderer.js'
import { StatusPanelComponentRenderer } from './statusPanelComponentRenderer.js'
import { ItemDetailsComponentRenderer } from './itemDetailsComponentRenderer.js'
import { EquipmentComponentRenderer } from './equipmentComponentRenderer.js'
import { ShopComponentRenderer } from './shopComponentRenderer.js'
import { CombatComponentRenderer } from './combatComponentRenderer.js'
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
    const graphics = new GraphicComponentRenderer()
    this.renderers = {
      'save-slots': new SaveSlotsComponentRenderer(),
      'save-status': new SaveStatusComponentRenderer(),
      'save-point': new SavePointComponentRenderer(),
      text: new TextComponentRenderer(),
      'message-history': new MessageHistoryComponentRenderer(),
      graphic: graphics,
      'background-image': graphics,
      button: new ButtonComponentRenderer(),
      'language-select': new LanguageSelectComponentRenderer(),
      'map-view': new MapViewComponentRenderer(),
      inventory: new InventoryComponentRenderer(),
      crafting: new CraftingComponentRenderer(),
      'action-bar': new ActionBarComponentRenderer(),
      'action-info': new ActionInfoComponentRenderer(),
      nearby: new NearbyComponentRenderer(),
      'status-panel': new StatusPanelComponentRenderer(),
      'item-details': new ItemDetailsComponentRenderer(),
      equipment: new EquipmentComponentRenderer(),
      shop: new ShopComponentRenderer(),
      combat: new CombatComponentRenderer(),
      'quest-log': new QuestLogComponentRenderer(),
      'character-progression': new CharacterProgressionComponentRenderer(),
      form: new FormRenderer(),
      'character-view': new CharacterViewRenderer(graphics),
      'character-sheet': new CharacterSheetRenderer(),
      ...renderers,
    }
  }

  render(component: SceneComponentData, context: ComponentRenderContext): RenderedComponent {
    switch (component.type) {
      case 'save-slots':
        return this.renderers['save-slots'].render(component, context)
      case 'save-status':
        return this.renderers['save-status'].render(component, context)
      case 'save-point':
        return this.renderers['save-point'].render(component, context)
      case 'quest-log':
        return this.renderers['quest-log'].render(component, context)
      case 'character-progression':
        return this.renderers['character-progression'].render(component, context)
      case 'form':
        return this.renderers['form'].render(component, context)
      case 'character-view':
        return this.renderers['character-view'].render(component, context)
      case 'character-sheet':
        return this.renderers['character-sheet'].render(component, context)
      case 'combat':
        return this.renderers.combat.render(component, context)
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
      case 'action-info':
        return this.renderers['action-info'].render(component, context)
      case 'graphic':
        return this.renderers.graphic.render(component, context)
      case 'background-image':
        return this.renderers['background-image'].render(component, context)
      case 'text':
        return this.renderers.text.render(component, context)
      case 'message-history':
        return this.renderers['message-history'].render(component, context)
      case 'button':
        return this.renderers.button.render(component, context)
      case 'language-select':
        return this.renderers['language-select'].render(component, context)
      case 'map-view':
        return this.renderers['map-view'].render(component, context)
      case 'inventory':
        return this.renderers.inventory.render(component, context)
      case 'crafting':
        return this.renderers.crafting.render(component, context)
      default: {
        const unsupported: never = component
        throw new Error(`Unsupported scene component: ${String(unsupported)}`)
      }
    }
  }
}
