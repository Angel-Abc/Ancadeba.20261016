import type { StatusEffectDefinition } from '@ancadeba/schemas'
import type { ComponentRenderContext, RenderedComponent } from './componentRendering.js'

/** Keyboard and pointer access to effect descriptions without requesting a game action. */
export function renderStatusEffect(
  effect: StatusEffectDefinition,
  context: ComponentRenderContext,
  icon?: RenderedComponent,
) {
  const { document } = context
  let currentDescription = effect.description
  const element = document.createElement('div')
  element.className = 'ancadeba-status-effect'
  element.dataset.statusEffect = effect.id
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'ancadeba-status-effect-button'
  button.setAttribute('aria-label', effect.label)

  if (effect.description) button.setAttribute('aria-description', effect.description)
  const label = document.createElement('span')
  label.textContent = effect.label

  if (icon) button.append(icon.element)
  button.append(label)
  const description = document.createElement('span')
  description.className = 'ancadeba-status-effect-description'
  description.textContent = effect.description
  description.setAttribute('role', 'tooltip')
  description.hidden = true
  element.append(button, description)
  let active = true
  let hovered = false
  let focused = false
  let dismissed = false

  const show = () => {
    const wasHidden = description.hidden
    description.hidden =
      !active || element.hidden || dismissed || !(hovered || focused) || !currentDescription

    if (wasHidden && !description.hidden && focused)
      description.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  const enter = () => {
    hovered = true

    if (!focused) dismissed = false
    show()
  }

  const leave = () => {
    hovered = false
    show()
  }

  const focus = () => {
    focused = true
    dismissed = false
    show()
  }

  const blur = () => {
    focused = false
    show()
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      dismissed = true
      show()
      event.preventDefault()
    }
  }

  button.addEventListener('mouseenter', enter)
  button.addEventListener('mouseleave', leave)
  button.addEventListener('focus', focus)
  button.addEventListener('blur', blur)
  button.addEventListener('keydown', keydown)

  return {
    element,
    setText(name: string, text: string) {
      label.textContent = name
      button.setAttribute('aria-label', name)
      currentDescription = text
      button.setAttribute('aria-description', text)
      description.textContent = text
      show()
    },
    setVisible(visible: boolean) {
      element.hidden = !visible

      if (!visible) {
        focused = false
        hovered = false

        if (document.activeElement === button) context.onActionBarFocusLost?.()
      }

      show()
    },
    dispose() {
      active = false
      button.removeEventListener('mouseenter', enter)
      button.removeEventListener('mouseleave', leave)
      button.removeEventListener('focus', focus)
      button.removeEventListener('blur', blur)
      button.removeEventListener('keydown', keydown)
      icon?.dispose()
      element.remove()
    },
  }
}
