import type { ButtonComponentData } from '@ancadeba/game-runtime'
import { canEnterScene } from '@ancadeba/game-runtime'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Owns a native button and its activation listener. */
export class ButtonComponentRenderer implements IComponentRenderer<ButtonComponentData> {
  render(component: ButtonComponentData, context: ComponentRenderContext): RenderedComponent {
    const element = context.document.createElement('button')
    element.type = 'button'
    element.className = 'ancadeba-button'
    element.textContent = component.label
    const action = component.action
    const scene = context.scene
    const movement = scene?.type === 'game' ? scene.game.mapMovement : undefined
    const objects = scene?.type === 'game' ? scene.game.mapObjects : undefined
    let active = true

    const update = () => {
      if (action?.type === 'enter-scene') {
        const available =
          context.canEnterScene?.(action) ??
          (scene?.type === 'game' ? canEnterScene(scene.game.data, action, movement) : true)

        element.disabled = !context.onButtonActivate || !available
        element.title = available
          ? ''
          : (context.navigationUnavailableMessage?.() ?? 'The destination is currently blocked.')
        element.setAttribute('aria-description', element.title)

        return
      }

      if (action?.type === 'interact-map') {
        element.disabled = !scene || !objects?.getTarget(scene, action.mapView, action.object)

        return
      }

      if (action?.type === 'save-game' || action?.type === 'load-game') {
        element.disabled = !(action.type === 'save-game'
          ? context.saves?.canSave
          : context.saves?.canLoad)

        return
      }

      if (action?.type === 'move-map') {
        element.disabled = !scene || !movement?.canMove(scene, action.mapView, action.direction)

        return
      }

      if (action?.type !== 'request-action') {
        element.disabled = !action || !context.onButtonActivate

        return
      }

      const enabled = action.enabledWhen && context.bindings?.read(action.enabledWhen)
      element.disabled =
        !context.actions ||
        Boolean(action.enabledWhen && (enabled?.status !== 'resolved' || enabled.value !== true))
    }

    const onClick = () => {
      if (!active || !action) return

      // Recheck at activation even if a state change has not notified this button yet.
      if (action.type === 'enter-scene') update()

      if (element.disabled) return

      if (action.type === 'interact-map') {
        if (scene) objects?.interact(scene, action.mapView, action.object)

        return
      }

      if (action.type === 'save-game') {
        context.saves?.save()

        return
      }

      if (action.type === 'load-game') {
        if (context.onLoadGame) context.onLoadGame()
        else context.saves?.load()

        return
      }

      if (action.type === 'move-map') {
        if (scene) movement?.move(scene, action.mapView, action.direction)

        return
      }

      if (action.type === 'request-action') context.actions?.request(action.action)
      else context.onButtonActivate?.(action)
    }

    update()

    const unsubscribe =
      (action?.type === 'request-action' && action.enabledWhen) || action?.type === 'enter-scene'
        ? context.bindings?.subscribeChanges(update)
        : undefined

    const unsubscribeNavigation =
      action?.type === 'enter-scene' && !context.bindings
        ? context.subscribeNavigationChanges?.(update)
        : undefined

    const unsubscribeMovement =
      action?.type === 'move-map' || action?.type === 'interact-map'
        ? movement?.subscribeChanges(update)
        : undefined

    const unsubscribeSaves = context.saves?.subscribe(update)

    if (action) element.addEventListener('click', onClick)

    return {
      element,
      dispose() {
        if (!active) return
        active = false
        unsubscribe?.()
        unsubscribeNavigation?.()
        unsubscribeMovement?.()
        unsubscribeSaves?.()
        element.removeEventListener('click', onClick)
        element.remove()
      },
    }
  }
}
