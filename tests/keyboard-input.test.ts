/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vite-plus/test'
import { bindKeyboardInput } from '@ancadeba/ui-components'
import {
  Engine,
  InputController,
  type EngineMessages,
  type GameData,
  type IEngineHost,
} from '@ancadeba/game-runtime'
import { MessageBus, type ILogger } from '@ancadeba/utilities'
import { DomEngineHost } from '../apps/engine/src/engineHost.js'
import { EditorPreviewHost } from '../apps/editor-ui/src/previewHost.js'

// A focused EventTarget harness exercises real listener registration and cleanup
// without introducing DOM globals into the runtime or a browser-test dependency.
class TestElement extends EventTarget {
  readonly children: TestElement[] = []
  parent: TestElement | undefined
  tabIndex = -1
  className = ''
  textContent = ''
  isContentEditable = false

  constructor(
    readonly ownerDocument: TestDocument,
    readonly tagName = 'section',
  ) {
    super()
  }

  append(...children: TestElement[]): void {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }

  contains(element: TestElement | null): boolean {
    return (
      element !== null &&
      (element === this || this.children.some((child) => child.contains(element)))
    )
  }

  closest(): TestElement | null {
    return ['input', 'textarea', 'select'].includes(this.tagName)
      ? this
      : (this.parent?.closest() ?? null)
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }

  asElement(): HTMLElement {
    return this as unknown as HTMLElement
  }
}

class TestDocument extends EventTarget {
  readonly defaultView = new EventTarget()
  activeElement: TestElement | null = null
  hidden = false

  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName)
  }
}

function key(
  surface: TestElement,
  type: 'keydown' | 'keyup',
  code: string,
  options: Record<string, unknown> = {},
): Event {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, {
    code,
    key: 'unrelated-character',
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...options,
  })
  surface.dispatchEvent(event)
  return event
}

function setup() {
  const document = new TestDocument()
  const surface = document.createElement('section')
  const messages = new MessageBus<EngineMessages>()
  const input = new InputController(
    {
      virtualKeys: ['north', 'confirm'],
      keyboard: { KeyW: 'north', ArrowUp: 'north', Enter: 'confirm' },
      contexts: {
        gameplay: { north: 'moveNorth' },
        menu: { north: 'selectPrevious', confirm: 'accept' },
      },
      initialContext: 'gameplay',
    },
    messages,
  )
  const handler = vi.fn<(event: EngineMessages['input.virtual']) => void>()
  messages.subscribe('input.virtual', handler)
  const cleanup = bindKeyboardInput(surface.asElement(), input)
  return { document, surface, messages, input, handler, cleanup }
}

describe('shared keyboard adapter', () => {
  it('does not steal focus and only accepts input within the game surface', () => {
    const { document, surface, messages, handler, cleanup } = setup()
    expect(document.activeElement).toBeNull()
    expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(false)
    const child = document.createElement('button')
    surface.append(child)
    document.activeElement = child
    expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(key(surface, 'keyup', 'KeyW').defaultPrevented).toBe(true)
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
    cleanup()
  })

  it('matches codes, allows Shift, ignores shortcuts and composition, and preserves releases', () => {
    const { document, surface, messages, handler, cleanup } = setup()
    document.activeElement = surface
    for (const option of ['ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
      expect(key(surface, 'keydown', 'KeyW', { [option]: true }).defaultPrevented).toBe(false)
    }
    expect(key(surface, 'keydown', 'KeyW', { shiftKey: true, key: 'Z' }).defaultPrevented).toBe(
      true,
    )
    expect(
      key(surface, 'keyup', 'KeyW', { ctrlKey: true, isComposing: true }).defaultPrevented,
    ).toBe(true)
    expect(key(surface, 'keydown', 'KeyQ').defaultPrevented).toBe(false)
    expect(key(surface, 'keydown', 'Enter').defaultPrevented).toBe(false)
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
    cleanup()
  })

  it('prevents defaults for held mapped repeats without producing extra presses', () => {
    const { document, surface, messages, handler, cleanup } = setup()
    document.activeElement = surface
    key(surface, 'keydown', 'KeyW')
    expect(key(surface, 'keydown', 'KeyW', { repeat: true }).defaultPrevented).toBe(true)
    expect(key(surface, 'keydown', 'KeyQ', { repeat: true }).defaultPrevented).toBe(false)
    key(surface, 'keyup', 'KeyW')
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
    cleanup()
  })

  it.each(['input', 'textarea', 'select', 'contenteditable'])(
    'ignores editable %s controls',
    (tag) => {
      const { document, surface, messages, handler, cleanup } = setup()
      const editable = document.createElement(tag)
      editable.isContentEditable = tag === 'contenteditable'
      surface.append(editable)
      document.activeElement = editable
      expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(false)
      messages.flush()
      expect(handler).not.toHaveBeenCalled()
      cleanup()
    },
  )

  it.each(['outside', 'editable', 'window', 'hidden'])(
    'cancels held input on focus loss: %s',
    (kind) => {
      const { document, surface, messages, handler, cleanup } = setup()
      document.activeElement = surface
      key(surface, 'keydown', 'KeyW')
      if (kind === 'window') document.defaultView.dispatchEvent(new Event('blur'))
      else if (kind === 'hidden') {
        document.hidden = true
        document.dispatchEvent(new Event('visibilitychange'))
      } else {
        const target = document.createElement(kind === 'editable' ? 'input' : 'section')
        if (kind === 'editable') surface.append(target)
        document.activeElement = target
        const event = new Event('focusout')
        Object.assign(event, { relatedTarget: target })
        surface.dispatchEvent(event)
      }
      key(surface, 'keyup', 'KeyW')
      messages.flush()
      expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'cancelled'])
      document.hidden = false
      document.activeElement = surface
      key(surface, 'keydown', 'KeyW')
      messages.flush()
      expect(handler.mock.calls.at(-1)?.[0].phase).toBe('pressed')
      cleanup()
    },
  )

  it('does not reset when focus moves between noneditable descendants', () => {
    const { document, surface, messages, handler, cleanup } = setup()
    const child = document.createElement('button')
    surface.append(child)
    document.activeElement = surface
    key(surface, 'keydown', 'KeyW')
    document.activeElement = child
    const event = new Event('focusout')
    Object.assign(event, { relatedTarget: child })
    surface.dispatchEvent(event)
    surface.dispatchEvent(new Event('focusin'))
    key(surface, 'keyup', 'KeyW')
    messages.flush()
    expect(handler.mock.calls.map(([message]) => message.phase)).toEqual(['pressed', 'released'])
    cleanup()
  })

  it('removes all listeners and cleans up idempotently', () => {
    const { document, surface, input, messages, handler, cleanup } = setup()
    document.activeElement = surface
    key(surface, 'keydown', 'KeyW')
    cleanup()
    cleanup()
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'cancelled'])
    handler.mockClear()
    const reset = vi.spyOn(input, 'reset')
    key(surface, 'keydown', 'KeyW')
    document.defaultView.dispatchEvent(new Event('blur'))
    document.hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    surface.dispatchEvent(new Event('focusin'))
    messages.flush()
    expect(handler).not.toHaveBeenCalled()
    expect(reset).not.toHaveBeenCalled()
  })
})

describe.each([
  ['standalone', (element: HTMLElement): IEngineHost => new DomEngineHost(element)],
  ['editor preview', (element: HTMLElement): IEngineHost => new EditorPreviewHost(element)],
] as const)('%s host input integration', (_name, createHost) => {
  it('mounts focusable input, preserves queued delivery, and stops and restarts cleanly', async () => {
    const document = new TestDocument()
    const container = document.createElement('main')
    const game: GameData = {
      id: 'demo',
      title: 'Demo',
      description: '',
      version: '1',
      scenes: new Map(),
      input: {
        virtualKeys: ['north'],
        keyboard: { KeyW: 'north', ArrowUp: 'north' },
        contexts: { gameplay: { north: 'moveNorth' }, menu: { north: 'selectPrevious' } },
        initialContext: 'gameplay',
      },
    }
    const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
    const engine = new Engine(
      { load: async () => game },
      createHost(container.asElement()),
      logger,
      () => new MessageBus<EngineMessages>(),
    )
    await engine.start()
    const root = container.children[0]!
    expect(root.tabIndex).toBe(0)
    expect(document.activeElement).toBeNull()
    const handler = vi.fn()
    const oldMessages = engine.messages!
    oldMessages.subscribe('input.virtual', handler)
    document.activeElement = root
    key(root, 'keydown', 'KeyW')
    key(root, 'keydown', 'ArrowUp')
    key(root, 'keyup', 'KeyW')
    expect(handler).not.toHaveBeenCalled()
    key(root, 'keyup', 'ArrowUp')
    engine.flushMessages()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
    engine.input!.setContext('menu')
    key(root, 'keydown', 'KeyW')
    engine.flushMessages()
    expect(handler).toHaveBeenLastCalledWith({
      context: 'menu',
      input: 'selectPrevious',
      phase: 'pressed',
    })
    handler.mockClear()
    engine.stop()
    expect(container.children).toHaveLength(0)
    key(root, 'keyup', 'KeyW')
    key(root, 'keydown', 'KeyW')
    oldMessages.flush()
    expect(handler).not.toHaveBeenCalled()
    await engine.start()
    const next = container.children[0]!
    const nextHandler = vi.fn()
    engine.messages!.subscribe('input.virtual', nextHandler)
    document.activeElement = next
    key(next, 'keydown', 'KeyW')
    engine.flushMessages()
    expect(nextHandler).toHaveBeenCalledExactlyOnceWith({
      context: 'gameplay',
      input: 'moveNorth',
      phase: 'pressed',
    })
    engine.stop()
  })
})
