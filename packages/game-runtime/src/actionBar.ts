import type { IGameDialogue } from './dialogue.js'
import type { IGameQuests, StoryCapture } from './quests.js'
import type { IGameItemUse, ItemUseCapture } from './itemUse.js'
import { inventoryEntry, type ActionBarSlotDefinition } from '@ancadeba/schemas'
import type { IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { VirtualInput } from './input.js'
import {
  GameInventoryContext,
  type IGameInventorySelection,
  type InventorySelectionSnapshot,
} from './inventoryContext.js'
import type { EquipmentSelection, IGameEquipment } from './equipment.js'
import type { IGameMapMovement } from './mapMovement.js'
import type { IGameMapObjects } from './mapObjects.js'
import type { MapObject } from '@ancadeba/schemas'
import type { IGameNearby, NearbySelection } from './nearbyContext.js'
import type { IGameTrading, TradeSelection } from './trading.js'
import type { IGameCombat, CombatCapture } from './combat.js'
import type { ActionOrigin } from './actions.js'
import { canEnterScene } from './sceneNavigation.js'

export interface IGameActionBar {
  getSlot(scene: SceneInstance, bar: string, slot: string): ActionBarSlotDefinition | undefined
  getSelectedItem(scene: SceneInstance, inventory: string): string | undefined
  selectInventoryItem(scene: SceneInstance, inventory: string, item?: string): void
  subscribeChanges(listener: () => void): () => void
  isEnabled(scene: SceneInstance, bar: string, slot: string): boolean
  activate(scene: SceneInstance, bar: string, slot: string): void
}

interface CapturedSlot {
  readonly objectCapture?: MapObject | undefined
  readonly storyCapture?: StoryCapture | undefined
  readonly itemCapture?: ItemUseCapture | undefined
  readonly combatCapture?: CombatCapture | undefined
  readonly scene: SceneInstance
  readonly bar: string
  readonly slot: string
  readonly selection?:
    | InventorySelectionSnapshot
    | NearbySelection
    | EquipmentSelection
    | TradeSelection
    | undefined
}

/** Resolves scene-owned slots before general input bindings, independently of the host. */
export class GameActionBar implements IGameActionBar {
  private readonly gestures = new Map<string, CapturedSlot | null>()
  private captured = new WeakMap<VirtualInput, CapturedSlot | null>()
  private disposed = false
  private readonly inventoryContext: IGameInventorySelection
  private readonly ownedContext: GameInventoryContext | undefined

  constructor(
    private readonly lifecycle: IGameLifecycle,
    inventory = lifecycle.currentGame?.inventory,
    private readonly mapMovement: IGameMapMovement | undefined = lifecycle.currentGame?.mapMovement,
    private readonly nearby: IGameNearby | undefined = lifecycle.currentGame?.nearby,
    selection: IGameInventorySelection | undefined = lifecycle.currentGame?.inventorySelection,
    private readonly equipment: IGameEquipment | undefined = lifecycle.currentGame?.equipment,
    private readonly trading: IGameTrading | undefined = lifecycle.currentGame?.trading,
    private readonly combat: () => IGameCombat | undefined = () => lifecycle.currentGame?.combat,
    private readonly itemUse: () => IGameItemUse | undefined = () => lifecycle.currentGame?.itemUse,
    private readonly dialogue: () => IGameDialogue | undefined = () =>
      lifecycle.currentGame?.dialogue,
    private readonly quests: () => IGameQuests | undefined = () => lifecycle.currentGame?.quests,
    private readonly mapObjects: IGameMapObjects | undefined = lifecycle.currentGame?.mapObjects,
  ) {
    this.ownedContext = selection ? undefined : new GameInventoryContext(lifecycle, inventory)
    this.inventoryContext = selection ?? this.ownedContext!
  }

  getSelectedItem(scene: SceneInstance, inventory: string): string | undefined {
    return this.inventoryContext.get(scene, inventory)?.item
  }

  selectInventoryItem(scene: SceneInstance, inventory: string, item?: string): void {
    this.inventoryContext.select(scene, inventory, item)
  }

  subscribeChanges(listener: () => void): () => void {
    const inventory = this.inventoryContext.subscribe(listener)
    const maps = this.mapMovement?.subscribeChanges(listener)
    const nearby = this.nearby?.subscribeChanges(listener)
    const equipment = this.equipment?.subscribe(listener)
    const trading = this.trading?.subscribeChanges(listener)
    const combat = this.combat()?.subscribeChanges(listener)
    const items = this.itemUse()?.subscribeChanges(listener)
    const dialogue = this.dialogue()?.subscribeChanges(listener)
    const quests = this.quests()?.subscribeChanges(listener)

    return () => {
      inventory()
      maps?.()
      nearby?.()
      equipment?.()
      trading?.()
      combat?.()
      items?.()
      dialogue?.()
      quests?.()
    }
  }

  private definition(
    scene: SceneInstance,
    bar: string,
    slot: string,
  ): ActionBarSlotDefinition | undefined {
    const component = scene.data.components.find((component) => component.id === bar)

    return component?.type === 'action-bar' ? component.slots[slot] : undefined
  }

  private resolve(
    scene: SceneInstance,
    bar: string,
    slot: string,
  ):
    | {
        definition: ActionBarSlotDefinition
        objectCapture?: MapObject | undefined
        storyCapture?: StoryCapture | undefined
        itemCapture?: ItemUseCapture | undefined
        combatCapture?: CombatCapture | undefined
        payload?: string
        selection?:
          | InventorySelectionSnapshot
          | NearbySelection
          | EquipmentSelection
          | TradeSelection
      }
    | undefined {
    const definition = this.definition(scene, bar, slot)

    if (!definition) return

    if (definition.action.type === 'interact-map')
      return {
        definition,
        objectCapture: this.mapObjects?.getTarget(
          scene,
          definition.action.mapView,
          definition.action.object,
        ),
      }

    if (definition.action.type === 'dialogue-action') {
      const action = definition.action

      const reply =
        action.command.type === 'choose'
          ? this.dialogue()?.reply(scene, action.nearby, action.command.position)
          : undefined

      if (action.command.type === 'choose' && !reply) return

      return {
        definition: reply ? { ...definition, label: reply.label, labelKey: undefined } : definition,
        storyCapture: this.dialogue()?.capture(scene, action.nearby, action.command),
      }
    }

    if (definition.action.type === 'quest-action')
      return { definition, storyCapture: this.quests()?.capture(scene) }

    if (definition.action.type === 'item-use')
      return {
        definition,
        itemCapture: this.itemUse()?.capture(
          scene,
          definition.action.inventory,
          definition.action.combat,
        ),
      }

    if (definition.action.type === 'combat-action')
      return {
        definition,
        combatCapture: this.combat()?.capture(
          scene,
          definition.action.combat,
          definition.action.command,
        ),
      }

    if (definition.action.type === 'shop-action') {
      const selection = this.trading?.getSelection(scene, definition.action.shop)

      return selection ? { definition, selection } : { definition }
    }

    if (definition.action.type === 'equipment-action') {
      const selection = this.equipment?.get(scene, definition.action.equipment)

      return selection ? { definition, selection } : { definition }
    }

    if (definition.action.type === 'nearby-action') {
      const source = definition.action
      const selection = this.nearby?.getSelection(scene, source.nearby)
      const entry = selection && this.nearby?.getEntry(scene, source.nearby, selection.entry)
      const action = entry && inventoryEntry(entry.actions, source.action)

      if (!selection || !action) return

      return {
        definition: { ...definition, action: { type: 'request-action', ...action } },
        payload: selection.entry,
        selection,
      }
    }

    if (definition.action.type !== 'inventory-action') return { definition }

    if (scene.type !== 'game') return
    const source = definition.action
    const selection = this.inventoryContext.get(scene, source.inventory)
    const item = scene.game.inventory?.snapshot.find((item) => item.id === selection?.item)
    const definitionInventory = scene.game.data.inventory

    const type =
      item && definitionInventory && inventoryEntry(definitionInventory.itemTypes, item.itemType)

    const action =
      (type?.actions && inventoryEntry(type.actions, source.action)) ??
      (source.action === 'inspect' && type?.inspection
        ? { action: type.inspection.action }
        : undefined)

    if (!selection || !action) return

    return {
      definition: { ...definition, action: { type: 'request-action', ...action } },
      payload: selection.item,
      selection,
    }
  }

  getSlot(scene: SceneInstance, bar: string, slot: string): ActionBarSlotDefinition | undefined {
    return this.disposed || scene.disposed || scene !== this.lifecycle.activeScene
      ? undefined
      : this.resolve(scene, bar, slot)?.definition
  }

  isEnabled(scene: SceneInstance, bar: string, slot: string): boolean {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game'
    )
      return false
    const action = this.getSlot(scene, bar, slot)?.action

    if (!action) return false

    if (action.type === 'dialogue-action')
      return Boolean(
        this.dialogue() &&
        this.dialogue()?.reason(scene, action.nearby, action.command) === undefined,
      )

    if (action.type === 'quest-action') {
      const quest =
        action.quest ?? (action.journal && this.quests()?.selected(scene, action.journal))

      return Boolean(
        quest &&
        this.quests() &&
        this.quests()?.reason(scene, quest, action.operation) === undefined,
      )
    }

    if (action.type === 'item-use')
      return Boolean(
        this.itemUse() &&
        this.itemUse()?.reason(scene, action.inventory, action.combat) === undefined,
      )

    if (action.type === 'combat-action')
      return this.combat()?.canCommand(scene, action.combat, action.command) ?? false

    if (action.type === 'shop-action')
      return Boolean(
        this.trading && this.trading.checkTrade(scene, action.shop, action.operation) === undefined,
      )

    if (action.type === 'equipment-action')
      return this.equipment?.isEnabled(scene, action.equipment, action.operation) ?? false

    if (action.type === 'move-map')
      return this.mapMovement?.canMove(scene, action.mapView, action.direction) ?? false

    if (action.type === 'interact-map')
      return Boolean(this.mapObjects?.getTarget(scene, action.mapView, action.object))

    if (action.type === 'enter-scene')
      return canEnterScene(scene.game.data, action, this.mapMovement)

    if (action.type !== 'request-action') return true

    if (!scene.game.actions) return false

    if (!action.enabledWhen) return true
    const result = scene.game.bindings?.read(action.enabledWhen)

    return result?.status === 'resolved' && result.value === true
  }

  activate(scene: SceneInstance, bar: string, slot: string): void {
    const resolved = this.resolve(scene, bar, slot)
    this.activateSlot({
      scene,
      bar,
      slot,
      selection: resolved?.selection,
      combatCapture: resolved?.combatCapture,
      itemCapture: resolved?.itemCapture,
      storyCapture: resolved?.storyCapture,
      objectCapture: resolved?.objectCapture,
    })
  }

  private activateSlot(
    target: CapturedSlot,
    request?: (action: string, payload?: unknown) => void,
    origin: ActionOrigin = { type: 'direct' },
  ): void {
    const { scene, bar, slot } = target

    if (!this.isEnabled(scene, bar, slot) || scene.type !== 'game') return
    const resolved = this.resolve(scene, bar, slot)

    if (!resolved || resolved.selection !== target.selection) return
    const action = resolved.definition.action

    if (action.type === 'interact-map') {
      if (target.objectCapture && target.objectCapture === resolved.objectCapture)
        this.mapObjects?.interact(scene, action.mapView, target.objectCapture.id)

      return
    }

    if (action.type === 'dialogue-action' || action.type === 'quest-action') {
      if (
        !target.storyCapture ||
        target.storyCapture.signature !== resolved.storyCapture?.signature
      )
        return

      if (action.type === 'dialogue-action')
        this.dialogue()?.request(scene, action.nearby, action.command, target.storyCapture, origin)
      else {
        const quest =
          action.quest ?? (action.journal && this.quests()?.selected(scene, action.journal))

        if (quest)
          this.quests()?.request(scene, quest, action.operation, target.storyCapture, origin)
      }

      return
    }

    if (action.type === 'item-use') {
      if (resolved.itemCapture === target.itemCapture)
        this.itemUse()?.request(scene, action.inventory, action.combat, target.itemCapture, origin)

      return
    }

    if (action.type === 'combat-action') {
      if (resolved.combatCapture !== target.combatCapture) return
      this.combat()?.request(scene, action.combat, action.command, target.combatCapture, origin)

      return
    }

    if (action.type === 'shop-action') {
      this.trading?.trade(scene, action.shop, action.operation)

      return
    }

    if (action.type === 'equipment-action') {
      this.equipment?.activate(scene, action.equipment, action.operation)

      return
    }

    if (action.type === 'move-map') {
      this.mapMovement?.move(scene, action.mapView, action.direction)

      return
    }

    if (action.type === 'request-action') {
      if (request) request(action.action, resolved.payload)
      else scene.game.actions?.request(action.action, resolved.payload)

      return
    }

    if (action.type === 'inventory-action' || action.type === 'nearby-action') return

    if (action.type === 'new-game') this.lifecycle.startGame()
    this.lifecycle.enterScene(
      action.scene,
      action.type === 'enter-scene' && action.position && action.mapView
        ? { mapView: action.mapView, position: action.position }
        : undefined,
    )
  }

  /** Capture before queued delivery so a later scene cannot claim an earlier press. */
  captureInput(event: VirtualInput): void {
    if (this.disposed) return
    const key = JSON.stringify([event.context, event.input])
    let target = this.gestures.get(key) ?? null

    if (event.phase === 'pressed') {
      target = null
      const scene = this.lifecycle.activeScene

      if (scene?.type === 'game') {
        const bar = scene.data.components.find((component) => component.type === 'action-bar')

        const slot =
          bar &&
          Object.entries(bar.slots).find(
            ([, definition]) =>
              definition.inputBinding?.context === event.context &&
              definition.inputBinding.input === event.input,
          )

        const resolved = bar && slot && this.resolve(scene, bar.id, slot[0])

        if (bar && slot && (resolved || slot[1].action.type === 'dialogue-action'))
          target = {
            scene,
            bar: bar.id,
            slot: slot[0],
            selection: resolved?.selection,
            combatCapture: resolved?.combatCapture,
            itemCapture: resolved?.itemCapture,
            storyCapture: resolved?.storyCapture,
            objectCapture: resolved?.objectCapture,
          }
      }

      this.gestures.set(key, target)
    } else this.gestures.delete(key)

    this.captured.set(event, target)
  }

  handleInput(event: VirtualInput, request: (action: string, payload?: unknown) => void): boolean {
    if (!this.captured.has(event)) this.captureInput(event)
    const target = this.captured.get(event)

    if (!target) return false

    if (event.phase === 'pressed') this.activateSlot(target, request, { type: 'input', event })

    return true
  }

  dispose(): void {
    this.disposed = true
    this.ownedContext?.dispose()
    this.gestures.clear()
    this.captured = new WeakMap()
  }
}
