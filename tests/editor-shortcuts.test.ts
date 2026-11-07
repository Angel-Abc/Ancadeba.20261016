import { describe, expect, it, vi } from 'vite-plus/test'
import { bindEditorShortcuts } from '../apps/editor-ui/src/editorShortcuts.js'

function keyboard() {
  let blocked = false
  let selectedText = ''

  const actions = {
    blocked: () => blocked,
    copy: vi.fn(() => true),
    paste: vi.fn(() => true),
    duplicate: vi.fn(() => true),
    delete: vi.fn(() => true),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
  }

  const window = Object.assign(new EventTarget(), {
    getSelection: () => ({ toString: () => selectedText }),
  })

  // @ts-expect-error -- The shortcut binder only needs keyboard events and the current text selection.
  const dispose = bindEditorShortcuts(window, actions)

  const press = (
    key: string,
    options: {
      ctrlKey?: boolean
      metaKey?: boolean
      shiftKey?: boolean
      altKey?: boolean
      repeat?: boolean
      isComposing?: boolean
      prevented?: boolean
      target?: string
    } = {},
  ) => {
    const event = new Event('keydown', { cancelable: true })
    const { target, prevented, ...modifiers } = options
    Object.assign(event, {
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      ...modifiers,
    })

    if (target)
      Object.defineProperty(event, 'target', {
        value: { closest: (selector: string) => (selector.includes(target) ? {} : null) },
      })

    if (prevented) event.preventDefault()
    window.dispatchEvent(event)

    return event
  }

  return {
    actions,
    press,
    dispose,
    block: () => {
      blocked = true
    },
    selectText: () => {
      selectedText = 'Selected text'
    },
  }
}

describe('editor keyboard shortcuts', () => {
  it.each(['ctrlKey', 'metaKey'] as const)(
    'routes copy, paste, duplicate, and history with %s',
    (modifier) => {
      const { actions, press, dispose } = keyboard()

      try {
        for (const [key, action] of [
          ['c', 'copy'],
          ['V', 'paste'],
          ['d', 'duplicate'],
          ['z', 'undo'],
          ['y', 'redo'],
        ] as const) {
          expect(press(key, { [modifier]: true }).defaultPrevented).toBe(true)
          expect(actions[action]).toHaveBeenCalledTimes(1)
        }

        expect(press('z', { [modifier]: true, shiftKey: true }).defaultPrevented).toBe(true)
        expect(actions.redo).toHaveBeenCalledTimes(2)
      } finally {
        dispose()
      }
    },
  )

  it.each(['Delete', 'Backspace'])(
    'routes unmodified %s through the component deletion action',
    (key) => {
      const { actions, press, dispose } = keyboard()

      try {
        expect(press(key).defaultPrevented).toBe(true)
        expect(actions.delete).toHaveBeenCalledTimes(1)
        expect(press(key, { ctrlKey: true }).defaultPrevented).toBe(false)
        expect(press(key, { shiftKey: true }).defaultPrevented).toBe(false)
        expect(actions.delete).toHaveBeenCalledTimes(1)
      } finally {
        dispose()
      }
    },
  )

  it.each([
    'input',
    'textarea',
    'select',
    'contenteditable',
    '[role="textbox"]',
    '[role="combobox"]',
    'dialog[open]',
    '[role="dialog"]',
    '#preview-pane',
    '#preview-form',
    '#project-open-controls',
    '#project-create-controls',
  ])('preserves native keys in %s', (target) => {
    const { actions, press, dispose } = keyboard()

    try {
      expect(press('c', { ctrlKey: true, target }).defaultPrevented).toBe(false)
      expect(press('v', { metaKey: true, target }).defaultPrevented).toBe(false)
      expect(press('d', { ctrlKey: true, target }).defaultPrevented).toBe(false)
      expect(press('Delete', { target }).defaultPrevented).toBe(false)
      expect(actions.copy).not.toHaveBeenCalled()
      expect(actions.paste).not.toHaveBeenCalled()
      expect(actions.duplicate).not.toHaveBeenCalled()
      expect(actions.delete).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('ignores repeated keys, composition, handled events, unsupported modifiers, and busy/conflicted state', () => {
    const { actions, press, dispose, block } = keyboard()

    try {
      for (const options of [
        { repeat: true },
        { isComposing: true },
        { altKey: true },
        { shiftKey: true },
      ])
        expect(press('d', { ctrlKey: true, ...options }).defaultPrevented).toBe(false)
      press('d', { ctrlKey: true, prevented: true })
      expect(press('c').defaultPrevented).toBe(false)
      block()
      expect(press('d', { ctrlKey: true }).defaultPrevented).toBe(false)
      expect(actions.duplicate).not.toHaveBeenCalled()
      expect(actions.copy).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('leaves copy and delete native for selected text, and unhandled actions retain browser defaults', () => {
    const { actions, press, dispose, selectText } = keyboard()

    try {
      actions.paste.mockReturnValue(false)
      expect(press('v', { ctrlKey: true }).defaultPrevented).toBe(false)
      selectText()
      expect(press('c', { ctrlKey: true }).defaultPrevented).toBe(false)
      expect(press('Delete').defaultPrevented).toBe(false)
      expect(actions.copy).not.toHaveBeenCalled()
      expect(actions.delete).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('removes its listener when disposed', () => {
    const { actions, press, dispose } = keyboard()
    dispose()
    press('d', { ctrlKey: true })
    expect(actions.duplicate).not.toHaveBeenCalled()
  })
})
