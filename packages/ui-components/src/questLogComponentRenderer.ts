import type { QuestLogComponentDefinition } from '@ancadeba/schemas'
import type {
  IComponentRenderer,
  ComponentRenderContext,
  RenderedComponent,
} from './componentRendering.js'

export class QuestLogComponentRenderer implements IComponentRenderer<QuestLogComponentDefinition> {
  render(
    component: QuestLogComponentDefinition,
    context: ComponentRenderContext,
  ): RenderedComponent {
    const { document, scene } = context
    const quests = scene?.type === 'game' ? scene.game.quests : undefined
    const root = document.createElement('section')
    root.className = 'ancadeba-quest-log ancadeba-nearby'
    root.setAttribute('aria-label', component.label)
    const heading = document.createElement('h2')
    heading.textContent = component.label
    const list = document.createElement('div')
    const details = document.createElement('div')
    details.className = 'ancadeba-text'
    const rows = new Map<string, HTMLButtonElement>()
    let active = true

    for (const id of component.quests ??
      (scene?.type === 'game' ? [...(scene.game.data.quests?.keys() ?? [])] : [])) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.quest = id
      button.addEventListener('click', () => {
        if (active && scene) quests?.select(scene, component.id, id)
      })
      rows.set(id, button)
      list.append(button)
    }

    root.append(heading, list, details)

    const update = () => {
      if (!active) return
      const selected = scene && quests?.selected(scene, component.id)

      for (const [id, button] of rows) {
        const snapshot = quests?.snapshot(id)
        const definition = quests?.definition(id)
        button.hidden = !snapshot || !component.statuses.includes(snapshot.status)
        button.disabled = !quests
        button.textContent = `${snapshot?.tracked ? '★ ' : ''}${definition?.label ?? id}${snapshot && definition ? ` — ${definition.messages[snapshot.status]}` : ''}`
        button.setAttribute('aria-pressed', String(id === selected))

        if (button.hidden && document.activeElement === button) context.onActionBarFocusLost?.()
      }

      details.textContent = selected ? (quests?.text(selected) ?? '') : ''
    }

    update()
    const unsubscribe = quests?.subscribeChanges(update)

    return {
      element: root,
      dispose() {
        active = false
        unsubscribe?.()
        root.remove()
      },
    }
  }
}
