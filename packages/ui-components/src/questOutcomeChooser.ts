import type { ComponentRenderContext } from './componentRendering.js'
import { componentRuntimeText } from './runtimeText.js'

/** The same scene-owned chooser handles pointer and keyboard turn-in requests. */
export function bindQuestOutcomeChooser(root: HTMLElement, context: ComponentRenderContext) {
  const { scene, document } = context
  const quests = scene?.type === 'game' ? scene.game.quests : undefined

  if (!scene || !quests) return
  const t = componentRuntimeText(context)
  let dismiss: (() => void) | undefined

  const unsubscribe = quests.onChooseOutcome((source, questId) => {
    const quest = quests.definition(questId)

    if (source !== scene || !quest || dismiss) return
    const previousFocus = document.activeElement
    const dialog = document.createElement('dialog')
    dialog.className = 'ancadeba-confirmation ancadeba-outcomes'
    const heading = document.createElement('h2')
    heading.textContent = t('quest.chooseOutcome', { quest: quest.label })
    dialog.setAttribute('aria-label', heading.textContent)
    dialog.append(heading)
    let capture = quests.capture(scene)

    const rows = quest.outcomes.map((outcome) => {
      const section = document.createElement('section')
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.questOutcome = outcome.id
      const details = document.createElement('p')
      const reason = document.createElement('p')
      button.addEventListener('click', () => {
        if (dismiss !== close || button.disabled) return
        quests.request(scene, questId, 'turn-in', { capture, outcome: outcome.id })
      })
      section.append(button, details, reason)
      dialog.append(section)

      return { outcome, button, details, reason }
    })

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = t('confirmation.cancel')
    dialog.append(cancel)

    const refresh = () => {
      if (quests.snapshot(questId)?.status !== 'ready') {
        close()

        return
      }

      capture = quests.capture(scene)

      for (const { outcome, button, details, reason } of rows) {
        button.textContent = outcome.label
        details.textContent = [outcome.description, quests.settlementText(quest, outcome)]
          .filter(Boolean)
          .join('\n')
        const unavailable = quests.reason(scene, questId, 'turn-in', outcome.id)
        reason.textContent = unavailable ?? ''
        button.disabled = unavailable !== undefined
        button.setAttribute(
          'aria-description',
          [details.textContent, unavailable].filter(Boolean).join('\n'),
        )
      }
    }

    const stop = quests.subscribeChanges(refresh)

    function close() {
      if (dismiss !== close) return
      dismiss = undefined
      stop()
      dialog.close()
      dialog.remove()
      context.input?.reset()

      if (
        previousFocus &&
        root.contains(previousFocus) &&
        'focus' in previousFocus &&
        typeof previousFocus.focus === 'function'
      )
        previousFocus.focus()
    }

    dismiss = close
    cancel.addEventListener('click', close)
    dialog.addEventListener('close', close)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      close()
    })
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation()

      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    })
    dialog.addEventListener('keyup', (event) => event.stopPropagation())
    root.append(dialog)
    context.input?.reset()
    dialog.showModal()
    refresh()
    cancel.focus()
  })

  return () => {
    unsubscribe()
    dismiss?.()
  }
}
