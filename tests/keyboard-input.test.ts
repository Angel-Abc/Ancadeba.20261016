/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vite-plus/test'
import { bindKeyboardInput, createBrowserTiming } from '@ancadeba/ui-components'
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
  readonly dataset: Record<string, string> = {}
  readonly nodeType = 1
  readonly children: TestElement[] = []
  parent: TestElement | undefined
  tabIndex = -1
  className = ''
  textContent = ''
  isContentEditable = false
  readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

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

  closest(selector: string): TestElement | null {
    return selector
      .split(',')
      .map((tag) => tag.trim())
      .includes(this.tagName)
      ? this
      : (this.parent?.closest(selector) ?? null)
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }

  asElement(): HTMLElement {
    // @ts-expect-error -- Deliberately partial DOM fixture supplies only the operations used by these adapters.
    return this
  }
}

class TestWindow extends EventTarget {
  readonly performance = { now: () => 0 }
  readonly tasks = new Map<number, { run: () => void; delay: number }>()
  private nextId = 0

  setTimeout(run: () => void, delay: number): number {
    const id = ++this.nextId
    this.tasks.set(id, { run, delay })

    return id
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id)
  }

  runNext(): void {
    const [id, task] = this.tasks.entries().next().value!
    this.tasks.delete(id)
    task.run()
  }

  drain(): void {
    let count = 0

    while (this.tasks.size) {
      if (++count > 100) throw new Error('Browser tasks did not become idle')
      this.runNext()
    }
  }
}

class TestDocument extends EventTarget {
  readonly defaultView = new TestWindow()
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

function setup(capturesKey?: (code: string) => boolean) {
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
  const cleanup = bindKeyboardInput(surface.asElement(), input, capturesKey)

  return { document, surface, messages, input, handler, cleanup }
}

describe('browser timing adapter', () => {
  it('uses the injected window for deferred tasks, idempotent cancellation, and monotonic time', () => {
    const window = new TestWindow()
    const timing = createBrowserTiming(window)
    const received = vi.fn()
    const cancel = timing.scheduler.schedule(received, 10)
    const task = window.tasks.values().next().value!
    expect(task.delay).toBe(10)
    expect(timing.clock.now()).toBe(0)
    expect(received).not.toHaveBeenCalled()
    cancel()
    cancel()
    task.run()
    expect(received).not.toHaveBeenCalled()
    const cancelCompleted = timing.scheduler.schedule(received, 0)
    window.runNext()
    cancelCompleted()
    expect(received).toHaveBeenCalledTimes(1)
    expect(window.tasks.size).toBe(0)
  })
})

describe('shared keyboard adapter', () => {
  it('accepts claimed action-bar keys while an inventory Inspect button has focus', () => {
    const { document, surface, messages, input, handler, cleanup } = setup((code) =>
      ['KeyW', 'Enter', 'Space'].includes(code),
    )

    input.setContext('menu')
    const inspect = document.createElement('button')
    inspect.dataset.inspectItem = 'folded-letter'
    surface.append(inspect)
    document.activeElement = inspect
    surface.dispatchEvent(new Event('focusin'))
    expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(true)
    expect(key(surface, 'keydown', 'KeyW', { repeat: true }).defaultPrevented).toBe(true)
    expect(key(surface, 'keyup', 'KeyW').defaultPrevented).toBe(true)
    expect(key(surface, 'keydown', 'ArrowUp').defaultPrevented).toBe(false)
    expect(key(surface, 'keydown', 'Enter').defaultPrevented).toBe(false)
    expect(key(surface, 'keydown', 'Space').defaultPrevented).toBe(false)
    expect(key(surface, 'keydown', 'KeyW', { ctrlKey: true }).defaultPrevented).toBe(false)
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { context: 'menu', input: 'selectPrevious', phase: 'pressed' },
      { context: 'menu', input: 'selectPrevious', phase: 'released' },
    ])
    expect(document.activeElement).toBe(inspect)
    cleanup()
  })

  it.each(['input', 'textarea', 'select', 'contenteditable', 'outside'])(
    'ignores claimed action-bar keys while focus is in %s',
    (kind) => {
      const { document, surface, messages, handler, cleanup } = setup(() => true)
      const target = document.createElement(kind === 'outside' ? 'button' : kind)
      target.isContentEditable = kind === 'contenteditable'

      if (kind !== 'outside') surface.append(target)
      document.activeElement = target
      expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(false)
      messages.flush()
      expect(handler).not.toHaveBeenCalled()
      cleanup()
    },
  )

  it('accepts shortcuts on action-bar buttons while preserving native Enter and Space', () => {
    const { document, surface, messages, input, handler, cleanup } = setup()
    input.setContext('menu')
    const button = document.createElement('button')
    button.dataset.actionBarSlot = '1'
    surface.append(button)
    document.activeElement = button
    surface.dispatchEvent(new Event('focusin'))
    expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(true)
    expect(key(surface, 'keydown', 'KeyW', { repeat: true }).defaultPrevented).toBe(true)
    expect(key(surface, 'keyup', 'KeyW').defaultPrevented).toBe(true)
    expect(key(surface, 'keydown', 'Enter').defaultPrevented).toBe(false)
    expect(key(surface, 'keydown', 'Space').defaultPrevented).toBe(false)
    expect(key(surface, 'keydown', 'KeyW', { ctrlKey: true }).defaultPrevented).toBe(false)
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
    cleanup()
  })

  it('does not steal focus and only accepts input within the game surface', () => {
    const { document, surface, messages, handler, cleanup } = setup()
    expect(document.activeElement).toBeNull()
    expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(false)
    const child = document.createElement('div')
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

  it.each(['input', 'textarea', 'select', 'button', 'contenteditable'])(
    'preserves native keyboard behavior for %s controls',
    (tag) => {
      const { document, surface, messages, input, handler, cleanup } = setup()
      input.setContext('menu')
      const editable = document.createElement(tag)
      editable.isContentEditable = tag === 'contenteditable'
      surface.append(editable)
      document.activeElement = editable
      expect(key(surface, 'keydown', 'KeyW').defaultPrevented).toBe(false)
      expect(key(surface, 'keydown', 'Enter').defaultPrevented).toBe(false)
      expect(key(surface, 'keyup', 'Enter').defaultPrevented).toBe(false)
      messages.flush()
      expect(handler).not.toHaveBeenCalled()
      cleanup()
    },
  )

  it.each(['outside', 'editable', 'button', 'window', 'hidden'])(
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
        const target = document.createElement(
          kind === 'editable' ? 'input' : kind === 'button' ? 'button' : 'section',
        )

        if (kind === 'editable' || kind === 'button') surface.append(target)
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
    const child = document.createElement('div')
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

  it.each([null, new EventTarget(), Object.assign(new EventTarget(), { nodeType: 3 })])(
    'cancels input when focus moves to a non-element target: %#',
    (relatedTarget) => {
      const { document, surface, messages, handler, cleanup } = setup()
      document.activeElement = surface
      key(surface, 'keydown', 'KeyW')
      const event = new Event('focusout')
      Object.assign(event, { relatedTarget })
      surface.dispatchEvent(event)
      messages.flush()
      expect(handler.mock.calls.map(([message]) => message.phase)).toEqual(['pressed', 'cancelled'])
      cleanup()
    },
  )

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
  it('automatically dispatches input and timer wakeups and stops and restarts cleanly', async () => {
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
      createBrowserTiming(document.defaultView),
    )

    await engine.start()
    document.defaultView.drain()
    const wakeup = vi.fn()
    engine.messages!.subscribe('timer.wakeup', wakeup)
    document.hidden = true
    engine.timers!.schedule(0)
    document.defaultView.runNext()
    expect(wakeup).not.toHaveBeenCalled()
    document.defaultView.runNext()
    expect(wakeup).toHaveBeenCalledExactlyOnceWith({ timerId: 1, dueAt: 0, observedAt: 0 })
    document.hidden = false
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
    document.defaultView.runNext()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
    engine.input!.setContext('menu')
    key(root, 'keydown', 'KeyW')
    document.defaultView.runNext()
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
    document.defaultView.drain()
    expect(handler).not.toHaveBeenCalled()
    await engine.start()
    const next = container.children[0]!
    const nextHandler = vi.fn()
    engine.messages!.subscribe('input.virtual', nextHandler)
    document.activeElement = next
    key(next, 'keydown', 'KeyW')
    document.defaultView.drain()
    expect(nextHandler).toHaveBeenCalledExactlyOnceWith({
      context: 'gameplay',
      input: 'moveNorth',
      phase: 'pressed',
    })
    engine.stop()
    document.defaultView.drain()
  })
})
