import type { ActionBarComponentDefinition } from '@ancadeba/schemas'
import { cooldownRemaining } from '@ancadeba/game-runtime'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

function keyLabel(code: string): string {
  return code.replace(/^(?:Key(?=[A-Z]$)|Digit(?=[0-9]$))/, '')
}

/** Renders slot presentation while the game runtime owns activation and input routing. */
export class ActionBarComponentRenderer implements IComponentRenderer<ActionBarComponentDefinition> {
  render(
    component: ActionBarComponentDefinition,
    context: ComponentRenderContext,
  ): RenderedComponent {
    const { document, scene, input } = context
    const root = document.createElement('div')
    root.className = 'ancadeba-action-bar'
    const actionBar = scene?.type === 'game' ? scene.game.actionBar : undefined

    const buttons = new Map<
      string,
      {
        button: HTMLButtonElement
        badge: HTMLElement
        lock: HTMLElement
        empty: HTMLElement | undefined
      }
    >()

    const cleanups: (() => void)[] = []
    let active = true

    const update = () => {
      if (!active) return

      for (const [id, { button, badge, lock, empty }] of buttons) {
        const focused = document.activeElement === button

        const available =
          !['inventory-action', 'nearby-action'].includes(component.slots[id]!.action.type) ||
          Boolean(scene && actionBar?.getSlot(scene, component.id, id))

        button.disabled = !scene || !actionBar?.isEnabled(scene, component.id, id)
        button.hidden = !available
        const action = component.slots[id]!.action

        const definition =
          action.type === 'combat-action' && scene?.type === 'game'
            ? scene.game.combat?.definition(scene, action.combat)
            : undefined

        const required =
          action.type === 'combat-action' && action.command.type === 'queue-move'
            ? definition?.player.moveLevels?.[action.command.move]
            : undefined

        const leveling =
          definition?.player.leveling && scene?.type === 'game'
            ? scene.game.leveling?.snapshot(definition.player.leveling)
            : undefined

        const equipmentIssue =
          action.type === 'equipment-action' && scene?.type === 'game'
            ? scene.game.equipment?.reason(scene, action.equipment, action.operation)
            : undefined

        const itemIssue =
          action.type === 'item-use' && scene?.type === 'game'
            ? scene.game.itemUse?.reason(scene, action.inventory, action.combat)
            : undefined

        const moveIssue =
          action.type === 'combat-action' &&
          action.command.type === 'queue-move' &&
          scene?.type === 'game'
            ? scene.game.combat?.moveIssue(scene, action.combat, action.command.move)
            : undefined

        const combatSnapshot =
          moveIssue && action.type === 'combat-action' && scene?.type === 'game'
            ? scene.game.combat?.snapshot(scene, action.combat)
            : undefined

        const cooldown =
          combatSnapshot &&
          definition &&
          action.type === 'combat-action' &&
          action.command.type === 'queue-move'
            ? cooldownRemaining(
                combatSnapshot.cooldowns,
                definition.player.id,
                action.command.move,
                combatSnapshot.round,
              )
            : 0

        lock.textContent = moveIssue
          ? cooldown
            ? `⏳ ${cooldown}`
            : '🔒'
          : equipmentIssue
            ? '🔒'
            : required && (!leveling?.available || leveling.level < required)
              ? definition!.messages.requiresLevel.replaceAll('{level}', String(required))
              : ''
        lock.hidden = !lock.textContent
        lock.setAttribute('aria-hidden', String(Boolean(equipmentIssue || moveIssue)))
        button.title = itemIssue ?? moveIssue ?? equipmentIssue ?? lock.textContent
        button.setAttribute('aria-description', button.title)

        if (empty) empty.hidden = available

        if (focused && button.disabled) context.onActionBarFocusLost?.()

        const binding = component.slots[id]!.inputBinding

        const codes =
          available && binding && binding.context === input?.context
            ? (input.getKeyboardCodes?.(binding.context, binding.input) ?? [])
            : []

        badge.textContent = codes.map(keyLabel).join(' / ')
        badge.hidden = codes.length === 0
      }
    }

    try {
      for (let index = 1; index <= 15; index++) {
        const id = String(index)
        const slot = component.slots[id]

        if (!slot) {
          const empty = document.createElement('div')
          empty.className = 'ancadeba-action-bar-empty'
          empty.setAttribute('aria-hidden', 'true')
          root.append(empty)

          continue
        }

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ancadeba-button ancadeba-action-bar-button'
        button.dataset.actionBarSlot = id
        button.dataset.slotAction =
          slot.action.type === 'combat-action'
            ? `${slot.action.combat}:${slot.action.command.type}`
            : slot.action.type === 'shop-action'
              ? `${slot.action.shop}:${slot.action.operation}`
              : slot.action.type === 'equipment-action'
                ? `${slot.action.equipment}:${slot.action.operation}`
                : slot.action.type === 'move-map'
                  ? `${slot.action.mapView}:${slot.action.direction}`
                  : 'action' in slot.action
                    ? slot.action.action
                    : slot.action.type === 'item-use'
                      ? `${slot.action.inventory}:use`
                      : slot.action.scene
        const label = document.createElement('span')
        label.textContent = slot.label
        const badge = document.createElement('kbd')
        badge.className = 'ancadeba-action-bar-key'
        const lock = document.createElement('small')
        lock.className = 'ancadeba-action-bar-lock'
        button.append(label, badge, lock)

        const activate = () => {
          if (active && scene) actionBar?.activate(scene, component.id, id)
        }

        button.addEventListener('click', activate)
        cleanups.push(() => button.removeEventListener('click', activate))
        let empty: HTMLElement | undefined

        if (slot.action.type === 'inventory-action' || slot.action.type === 'nearby-action') {
          const cell = document.createElement('div')
          cell.className = 'ancadeba-action-bar-cell'
          empty = document.createElement('div')
          empty.className = 'ancadeba-action-bar-empty'
          empty.setAttribute('aria-hidden', 'true')
          cell.append(button, empty)
          root.append(cell)
        } else root.append(button)
        buttons.set(id, { button, badge, lock, empty })
      }

      update()
      const unsubscribeBindings = context.bindings?.subscribeChanges(update)

      if (unsubscribeBindings) cleanups.push(unsubscribeBindings)
      const unsubscribeInput = input?.subscribeContextChanges?.(update)

      if (unsubscribeInput) cleanups.push(unsubscribeInput)
      const unsubscribeContext = actionBar?.subscribeChanges(update)

      if (unsubscribeContext) cleanups.push(unsubscribeContext)
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup()
      root.remove()
      throw error
    }

    return {
      element: root,
      dispose() {
        if (!active) return
        active = false

        for (const cleanup of cleanups.reverse()) cleanup()
        root.remove()
      },
    }
  }
}
