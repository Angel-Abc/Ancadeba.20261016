import type { Translate } from '@ancadeba/utilities'

/** Keeps destructive map actions inside the editor with native dialog focus management. */
export function mapConfirmation(document: Document, t: Translate) {
  let cancelPending: (() => void) | undefined

  return {
    ask(message: string): Promise<boolean> {
      cancelPending?.()

      return new Promise((resolve) => {
        const dialog = document.createElement('dialog')
        dialog.className = 'map-confirmation'
        dialog.setAttribute('aria-label', t('maps.confirmTitle'))
        const text = document.createElement('p')
        text.textContent = message
        const actions = document.createElement('div')
        actions.className = 'map-confirmation-actions'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = t('maps.cancel')
        const accept = document.createElement('button')
        accept.type = 'button'
        accept.textContent = t('maps.confirm')
        let settled = false

        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          cancelPending = undefined
          dialog.close()
          dialog.remove()
          resolve(value)
        }

        cancelPending = () => finish(false)
        cancel.addEventListener('click', () => finish(false))
        accept.addEventListener('click', () => finish(true))
        dialog.addEventListener('cancel', (event) => {
          event.preventDefault()
          finish(false)
        })
        dialog.addEventListener('close', () => finish(false))
        actions.append(cancel, accept)
        dialog.append(text, actions)
        document.body.append(dialog)
        dialog.showModal()
        cancel.focus()
      })
    },
    dispose: () => cancelPending?.(),
  }
}
