export interface EditorShortcutActions {
  blocked(): boolean
  copy(): boolean
  paste(): boolean
  duplicate(): boolean
  delete(): boolean
  undo(): boolean
  redo(): boolean
}

/** Actions return whether the current editor selection can handle a shortcut. */
export function bindEditorShortcuts(window: Window, actions: EditorShortcutActions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.altKey ||
      actions.blocked()
    )
      return
    const target = event.target

    if (
      target &&
      'closest' in target &&
      typeof target.closest === 'function' &&
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], dialog[open], [role="dialog"], #preview-pane, #preview-form, #project-open-controls, #project-create-controls',
      )
    )
      return
    const key = event.key.toLowerCase()
    const modified = event.ctrlKey || event.metaKey
    let action: keyof Omit<EditorShortcutActions, 'blocked'> | undefined

    if (modified && !event.shiftKey) {
      if (key === 'c') action = 'copy'
      else if (key === 'v') action = 'paste'
      else if (key === 'd') action = 'duplicate'
      else if (key === 'z') action = 'undo'
      else if (key === 'y') action = 'redo'
    } else if (modified && event.shiftKey && key === 'z') action = 'redo'
    else if (!modified && !event.shiftKey && (key === 'delete' || key === 'backspace'))
      action = 'delete'

    if (
      !action ||
      ((action === 'copy' || action === 'delete') && window.getSelection?.()?.toString())
    )
      return

    if (actions[action]()) event.preventDefault()
  }

  window.addEventListener('keydown', onKeyDown)

  return () => window.removeEventListener('keydown', onKeyDown)
}
