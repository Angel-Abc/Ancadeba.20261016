import type { IGameInput } from '@ancadeba/game-runtime'

/** Structural contract implemented by the runtime without a browser dependency. */
export interface KeyboardInputSink {
  readonly bindSceneKeys?: IGameInput['bindSceneKeys']
  readonly isSceneKey?: IGameInput['isSceneKey']
  readonly isReservedKey?: IGameInput['isReservedKey']
  readonly context?: string
  getKeyboardCodes?(context: string, input: string): readonly string[]
  subscribeContextChanges?(listener: (context: string) => void): () => void
  isKeyMapped(code: string): boolean
  pressKey(code: string): boolean
  releaseKey(code: string): boolean
  reset(): void
}

function usesNativeKeyboard(element: Element | null, allowButtons = false): boolean {
  if (element && 'isContentEditable' in element && element.isContentEditable === true) return true
  const button = element?.closest('button')

  // SAFETY: the button selector identifies an HTML button with an HTMLElement dataset.
  if (
    button &&
    (allowButtons || ('dataset' in button && (button as HTMLElement).dataset.actionBarSlot))
  )
    return false

  return Boolean(
    element &&
    (element.closest('input, textarea, select, button, [role="log"]') ||
      ('isContentEditable' in element && element.isContentEditable === true)),
  )
}

/** Attach to a mounted, focusable game surface. Does not focus it or flush messages. */
export function bindKeyboardInput(
  surface: HTMLElement,
  input: KeyboardInputSink,
  capturesKey?: (code: string) => boolean,
): () => void {
  const document = surface.ownerDocument
  const window = document.defaultView
  const tracked = new Set<string>()
  let disposed = false

  const reset = () => {
    tracked.clear()
    input.reset()
  }

  const hasFocus = (allowButtons: boolean) =>
    !document.hidden &&
    surface.contains(document.activeElement) &&
    !usesNativeKeyboard(document.activeElement, allowButtons)

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || document.activeElement?.closest('dialog[open]')) return
    const reserved = input.isReservedKey?.(event.code) === true

    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return

    if (
      !reserved &&
      !hasFocus(capturesKey?.(event.code) === true || input.isSceneKey?.(event.code) === true)
    )
      return

    // Native button activation owns Enter and Space, even when a game maps those codes.
    if (
      ['Enter', 'NumpadEnter', 'Space'].includes(event.code) &&
      document.activeElement?.closest('button')
    )
      return

    if (reserved) {
      // The surface owns this shortcut even when one of its editable controls has focus.
      event.preventDefault()
      event.stopPropagation()
    }

    if (event.repeat) {
      if (tracked.has(event.code) && input.isKeyMapped(event.code)) event.preventDefault()

      return
    }

    tracked.add(event.code)

    if (input.pressKey(event.code)) event.preventDefault()
  }

  const onKeyUp = (event: KeyboardEvent) => {
    // Releases must reach the sink even if the modifier state changed after keydown.
    if (!tracked.delete(event.code)) return

    if (input.releaseKey(event.code)) event.preventDefault()
  }

  // Give reserved shortcuts and claimed slots priority over descendants' keyboard handlers.
  const onCapturedKeyDown = (event: KeyboardEvent) => {
    if (input.isReservedKey?.(event.code) || capturesKey?.(event.code)) onKeyDown(event)
  }

  const onFocusIn = () => {
    if (usesNativeKeyboard(document.activeElement)) reset()
  }

  const onFocusOut = (event: FocusEvent) => {
    const target = event.relatedTarget

    if (!target || !('nodeType' in target) || target.nodeType !== 1) {
      reset()

      return
    }

    // SAFETY: nodeType 1 identifies an Element, including elements from another browsing context.
    const element = target as Element

    if (!surface.contains(element) || usesNativeKeyboard(element)) reset()
  }

  const onVisibilityChange = () => {
    if (document.hidden) reset()
  }

  surface.addEventListener('keydown', onKeyDown)
  surface.addEventListener('keydown', onCapturedKeyDown, true)
  surface.addEventListener('keyup', onKeyUp)
  surface.addEventListener('focusin', onFocusIn)
  surface.addEventListener('focusout', onFocusOut)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window?.addEventListener('blur', reset)

  return () => {
    if (disposed) return
    disposed = true
    surface.removeEventListener('keydown', onKeyDown)
    surface.removeEventListener('keydown', onCapturedKeyDown, true)
    surface.removeEventListener('keyup', onKeyUp)
    surface.removeEventListener('focusin', onFocusIn)
    surface.removeEventListener('focusout', onFocusOut)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window?.removeEventListener('blur', reset)
    reset()
  }
}
