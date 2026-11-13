import type { SceneComponentData } from '@ancadeba/game-runtime'
import { componentRuntimeText } from './runtimeText.js'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

type Component = Extract<SceneComponentData, { type: 'character-progression' }>

export class CharacterProgressionComponentRenderer implements IComponentRenderer<Component> {
  render(component: Component, context: ComponentRenderContext): RenderedComponent {
    const root = context.document.createElement('section')
    root.className = 'ancadeba-character-progression'
    const heading = context.document.createElement('h2')
    const summary = context.document.createElement('p')
    const progress = context.document.createElement('progress')
    const receipt = context.document.createElement('p')
    receipt.style.whiteSpace = 'pre-line'
    receipt.setAttribute('role', 'status')
    root.append(heading, summary, progress, receipt)
    const game = context.scene?.type === 'game' ? context.scene.game : undefined

    const update = () => {
      const profile = game?.data.leveling?.get(component.profile)
      const snapshot = game?.leveling?.snapshot(component.profile)
      heading.textContent = profile?.label ?? component.profile

      if (!profile || !snapshot?.available) {
        summary.textContent =
          profile?.messages.unavailable ?? componentRuntimeText(context)('progression.unavailable')
        progress.hidden = true
        receipt.textContent = ''

        return
      }

      progress.hidden = false
      progress.max = snapshot.progressMaximum
      progress.value = snapshot.progressValue
      progress.setAttribute('aria-label', profile.messages.xp)
      summary.textContent = `${profile.messages.level} ${snapshot.level} · ${profile.messages.xp} ${snapshot.xp} · ${snapshot.capped ? profile.messages.capped : `${profile.messages.next}: ${snapshot.nextLevelXp}`}`
      receipt.textContent = game?.leveling?.text(component.profile) ?? ''
    }

    update()
    const unsubscribe = game?.leveling?.subscribeChanges(update)

    return {
      element: root,
      dispose() {
        unsubscribe?.()
        root.remove()
      },
    }
  }
}
