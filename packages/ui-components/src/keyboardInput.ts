/** Structural contract implemented by the runtime without a browser dependency. */
export interface KeyboardInputSink {
  isKeyMapped(code: string): boolean
  pressKey(code: string): boolean
  releaseKey(code: string): boolean
  reset(): void
}

function isEditable(element: Element | null): boolean {
  return Boolean(
    element &&
    (element.closest('input, textarea, select') ||
      ('isContentEditable' in element && element.isContentEditable === true)),
  )
}

/** Attach to a mounted, focusable game surface. Does not focus it or flush messages. */
export function bindKeyboardInput(surface: HTMLElement, input: KeyboardInputSink): () => void {
  const document = surface.ownerDocument
  const window = document.defaultView
  const tracked = new Set<string>()
  let disposed = false

  const reset = () => {
    tracked.clear()
    input.reset()
  }
  const hasFocus = () =>
    !document.hidden &&
    surface.contains(document.activeElement) &&
    !isEditable(document.activeElement)

  const onKeyDown = (event: KeyboardEvent) => {
    if (!hasFocus() || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
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
  const onFocusIn = () => {
    if (isEditable(document.activeElement)) reset()
  }
  const onFocusOut = (event: FocusEvent) => {
    const target = event.relatedTarget as Element | null
    if (!surface.contains(target) || isEditable(target)) reset()
  }
  const onVisibilityChange = () => {
    if (document.hidden) reset()
  }

  surface.addEventListener('keydown', onKeyDown)
  surface.addEventListener('keyup', onKeyUp)
  surface.addEventListener('focusin', onFocusIn)
  surface.addEventListener('focusout', onFocusOut)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window?.addEventListener('blur', reset)

  return () => {
    if (disposed) return
    disposed = true
    surface.removeEventListener('keydown', onKeyDown)
    surface.removeEventListener('keyup', onKeyUp)
    surface.removeEventListener('focusin', onFocusIn)
    surface.removeEventListener('focusout', onFocusOut)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window?.removeEventListener('blur', reset)
    reset()
  }
}
