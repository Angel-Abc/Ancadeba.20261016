/// <reference lib="dom" />
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  Engine,
  GameLifecycle,
  GameLoader,
  type EngineMessages,
  type GameData,
  type IEngineHost,
  type GameActionHandler,
  type EngineRuntimeServices,
} from '@ancadeba/game-runtime'
import {
  JsonResourceLoader,
  MessageBus,
  type ILogger,
  type IResourceSource,
} from '@ancadeba/utilities'
import { mountGameView, SceneRenderer } from '@ancadeba/ui-components'
import { DomEngineHost } from '../apps/engine/src/engineHost.js'
import { EditorPreviewHost } from '../apps/editor-ui/src/previewHost.js'

// A DOM surface harness verifies renderer ownership and real event listener cleanup.
// Actual CSS layout is also checked in a browser using this same sample game.
class TestStyle {
  private readonly properties = new Map<string, string>()

  setProperty(name: string, value: string): void {
    this.properties.set(name, value)
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? ''
  }
}

class TestElement extends EventTarget {
  readonly children: TestElement[] = []
  readonly style = new TestStyle()
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  parent: TestElement | undefined
  className = ''
  tabIndex = -1
  title = ''
  value = ''
  private content = ''

  constructor(
    readonly ownerDocument: TestDocument,
    readonly tagName: string,
  ) {
    super()
  }

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.content = value
    for (const child of [...this.children]) child.remove()
  }
  set innerHTML(_value: string) {
    throw new Error('Text must not be interpreted as HTML')
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  append(...children: TestElement[]): void {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }
  contains(element: TestElement | null): boolean {
    return (
      element !== null &&
      (element === this || this.children.some((child) => child.contains(element)))
    )
  }
  find(predicate: (element: TestElement) => boolean): TestElement | undefined {
    if (predicate(this)) return this
    for (const child of this.children) {
      const found = child.find(predicate)
      if (found) return found
    }
    return undefined
  }
  asElement(): HTMLElement {
    return this as unknown as HTMLElement
  }
}

class TestDocument extends EventTarget {
  readonly defaultView = new EventTarget()
  activeElement: TestElement | null = null
  hidden = false
  createElement(tag: string): TestElement {
    return new TestElement(this, tag.toUpperCase())
  }
}

const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
const timing = { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } }
const source: IResourceSource = {
  readText: (path) => readFile(new URL(`../sample-games/basic/${path}`, import.meta.url), 'utf8'),
  readBytes: async (path) =>
    new Uint8Array(await readFile(new URL(`../sample-games/basic/${path}`, import.meta.url))),
}
const loader = new GameLoader(new JsonResourceLoader(source, logger))

function setup(game: GameData) {
  const lifecycle = new GameLifecycle(game, {
    createGameState: () => ({ score: 0 }),
    createSceneState: () => undefined,
  })
  const document = new TestDocument()
  const target = document.createElement('main')
  return { lifecycle, document, target }
}

interface BindingDemoState {
  player: { health?: unknown }
}

function bindingEngine(
  game: GameData,
  host: IEngineHost,
  services: Pick<EngineRuntimeServices, 'clock' | 'scheduler'> = timing,
  elapsed = false,
) {
  return new Engine(
    { load: async () => game },
    host,
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      ...services,
      createGameLifecycle: (content) =>
        new GameLifecycle(content, {
          createGameState: (): BindingDemoState => ({ player: { health: 40 } }),
          createSceneState: () => undefined,
        }),
      createGameRules: (_content, instance) => {
        const state = instance.state as BindingDemoState
        return {
          handlers: new Map<string, GameActionHandler>([
            [
              'damage',
              () => {
                state.player.health = Number(state.player.health) - 7
                return { status: 'applied', advanceTurn: true, worldTimeCostMs: 1000 }
              },
            ],
            [
              'forget',
              () => {
                delete state.player.health
                return { status: 'applied' }
              },
            ],
            [
              'heal',
              () => {
                state.player.health = 40
                return { status: 'applied' }
              },
            ],
            [
              'markup',
              () => {
                state.player.health = '<b>{{turn}}</b>'
                return { status: 'applied' }
              },
            ],
          ]),
          inputBindings: [{ context: 'gameplay', input: 'interact', action: 'damage' }],
          ...(elapsed ? { worldTime: { mode: 'elapsed' as const, pulseMs: 10 } } : {}),
        }
      },
    },
  )
}

function flush(engine: Engine): void {
  for (let batch = 0; batch < 4; batch++) engine.flushMessages()
}

describe('scene renderer', () => {
  it('renders the three sample scenes with exact grid placement and semantic text', async () => {
    const game = await loader.load()
    const { lifecycle, target } = setup(game)
    const renderer = new SceneRenderer(target.asElement(), lifecycle)
    expect(target.children).toHaveLength(0)
    const playthrough = lifecycle.startGame()
    lifecycle.enterScene('standard')
    const standard = target.children[0]!
    expect(standard.dataset.sceneId).toBe('standard')
    expect(standard.attributes.get('aria-label')).toBe('Standard view')
    expect(standard.style.getPropertyValue('--ge-scene-grid-rows')).toBe('12')
    expect(standard.style.getPropertyValue('--ge-scene-grid-columns')).toBe('12')
    expect(standard.style).not.toHaveProperty('gridTemplateRows')
    expect(standard.style).not.toHaveProperty('gridTemplateColumns')
    const heading = standard.find((element) => element.dataset.componentId === 'location-title')!
    expect(heading.tagName).toBe('H2')
    expect(heading.textContent).toBe('In the Museum')
    expect(heading.style.getPropertyValue('--ge-component-row')).toBe('1')
    expect(heading.style.getPropertyValue('--ge-component-row-span')).toBe('2')
    expect(heading.style.getPropertyValue('--ge-component-column')).toBe('3')
    expect(heading.style.getPropertyValue('--ge-component-column-span')).toBe('8')
    expect(heading.style.getPropertyValue('--ge-component-text-align')).toBe('center')
    expect(heading.style).not.toHaveProperty('gridRow')
    expect(heading.style).not.toHaveProperty('gridColumn')
    expect(heading.style).not.toHaveProperty('textAlign')
    const narrative = standard.find((element) => element.dataset.componentId === 'narrative')!
    expect(narrative.tagName).toBe('DIV')
    expect(narrative.style.getPropertyValue('--ge-component-row')).toBe('3')
    expect(narrative.style.getPropertyValue('--ge-component-row-span')).toBe('8')
    expect(narrative.textContent).toContain('\n\n')
    const firstNode = standard
    lifecycle.enterScene('inventory')
    expect(firstNode.parent).toBeUndefined()
    expect(target.children).toHaveLength(1)
    expect(target.children[0]?.dataset.sceneId).toBe('inventory')
    expect(
      target.children[0]
        ?.find((element) => element.dataset.componentId === 'footer')
        ?.style.getPropertyValue('--ge-component-text-align'),
    ).toBe('end')
    lifecycle.enterScene('settings')
    expect(target.children[0]?.dataset.sceneId).toBe('settings')
    expect(lifecycle.currentGame).toBe(playthrough)
    lifecycle.enterScene('standard')
    expect(target.children[0]).not.toBe(firstNode)
    lifecycle.endGame()
    expect(target.children).toHaveLength(0)
    lifecycle.enterScene('settings')
    lifecycle.dispose()
    expect(target.children).toHaveLength(0)
    renderer.dispose()
  })

  it('keeps grid and placement variables local to each renderer instance', async () => {
    const game = await loader.load()
    const settings = game.scenes.get('settings')!
    const smaller: GameData = {
      ...game,
      scenes: new Map([
        [
          'settings',
          {
            ...settings,
            screen: { type: 'grid', grid: { rows: 6, columns: 8 } },
            components: [
              {
                ...settings.components[0]!,
                placement: { row: 2, column: 2, rowSpan: 3, columnSpan: 4 },
                presentation: { variant: 'heading', align: 'end' },
              },
            ],
          },
        ],
      ]),
    }
    const first = setup(game)
    const second = setup(smaller)
    const firstRenderer = new SceneRenderer(first.target.asElement(), first.lifecycle)
    const secondRenderer = new SceneRenderer(second.target.asElement(), second.lifecycle)
    first.lifecycle.enterScene('settings')
    second.lifecycle.enterScene('settings')
    const firstScene = first.target.children[0]!
    const secondScene = second.target.children[0]!
    expect(firstScene.style.getPropertyValue('--ge-scene-grid-rows')).toBe('12')
    expect(firstScene.style.getPropertyValue('--ge-scene-grid-columns')).toBe('12')
    expect(secondScene.style.getPropertyValue('--ge-scene-grid-rows')).toBe('6')
    expect(secondScene.style.getPropertyValue('--ge-scene-grid-columns')).toBe('8')
    expect(firstScene.children[0]?.style.getPropertyValue('--ge-component-row')).toBe('1')
    expect(secondScene.children[0]?.style.getPropertyValue('--ge-component-row')).toBe('2')
    expect(secondScene.children[0]?.style.getPropertyValue('--ge-component-text-align')).toBe('end')
    second.lifecycle.leaveScene()
    expect(first.target.children[0]).toBe(firstScene)
    firstRenderer.dispose()
    secondRenderer.dispose()
  })

  it('renders an already active scene and cleans up only the nodes it owns', async () => {
    const game = await loader.load()
    const { lifecycle, target, document } = setup(game)
    lifecycle.enterScene('settings')
    const sibling = document.createElement('aside')
    target.append(sibling)
    const renderer = new SceneRenderer(target.asElement(), lifecycle)
    expect(target.children).toHaveLength(2)
    renderer.dispose()
    renderer.dispose()
    expect(target.children).toEqual([sibling])
    lifecycle.leaveScene()
    lifecycle.enterScene('settings')
    expect(target.children).toEqual([sibling])
  })

  it('keeps markup literal and renders each component without interpreting HTML', async () => {
    const game = await loader.load()
    const literal = '<img src=x onerror="alert(1)">\n<script>example()</script>'
    const settings = game.scenes.get('settings')!
    const modified: GameData = {
      ...game,
      scenes: new Map([
        [
          'settings',
          {
            ...settings,
            components: [{ ...settings.components[0]!, text: literal }],
          },
        ],
      ]),
    }
    const { lifecycle, target } = setup(modified)
    lifecycle.enterScene('settings')
    const renderer = new SceneRenderer(target.asElement(), lifecycle)
    expect(target.children[0]?.children[0]?.textContent).toBe(literal)
    expect(target.children[0]?.children[0]?.children).toEqual([])
    renderer.dispose()
  })

  it('does not replace a rendered scene after rejected entry and releases it on game replacement', async () => {
    const game = await loader.load()
    const { lifecycle, target } = setup(game)
    lifecycle.startGame()
    lifecycle.enterScene('standard')
    const renderer = new SceneRenderer(target.asElement(), lifecycle)
    const original = target.children[0]
    expect(() => lifecycle.enterScene('missing')).toThrow('Unknown scene')
    expect(target.children[0]).toBe(original)
    lifecycle.startGame()
    expect(target.children).toHaveLength(0)
    renderer.dispose()
  })

  it('unsubscribes on renderer disposal and cleans partially mounted bound components after a failure', async () => {
    const content = await loader.load()
    const { target, document } = setup(content)
    const engine = bindingEngine(content, { mount: () => () => {} })
    await engine.start()
    const lifecycle = engine.lifecycle!
    const game = lifecycle.startGame()
    lifecycle.enterScene('standard')
    const read = vi.spyOn(game.bindings!, 'read')
    const createElement = document.createElement.bind(document)
    let calls = 0
    const create = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (++calls === 4) throw new Error('Cannot mount narrative')
      return createElement(tag)
    })
    expect(() => new SceneRenderer(target.asElement(), lifecycle)).toThrow('Cannot mount narrative')
    create.mockRestore()
    expect(target.children).toHaveLength(0)
    read.mockClear()
    game.actions!.request('damage')
    flush(engine)
    expect(read).not.toHaveBeenCalled()

    const renderer = new SceneRenderer(target.asElement(), lifecycle)
    expect(
      target.find((element) => element.dataset.componentId === 'player-status')?.textContent,
    ).toContain('Health 33 / 40')
    renderer.dispose()
    renderer.dispose()
    read.mockClear()
    game.actions!.request('damage')
    flush(engine)
    expect(read).not.toHaveBeenCalled()
    expect(target.children).toHaveLength(0)
    expect(lifecycle.activeScene?.data.id).toBe('standard')
    engine.stop()
  })

  it('updates rendered progression from elapsed time without actions and resumes after Settings', async () => {
    let now = 0
    let pulse: (() => void) | undefined
    const content = await loader.load()
    const { target } = setup(content)
    const engine = bindingEngine(
      content,
      new EditorPreviewHost(target.asElement()),
      {
        clock: { now: () => now },
        scheduler: {
          schedule(run, delay) {
            if (delay === 10) pulse = run
            return () => {}
          },
        },
      },
      true,
    )
    await engine.start()
    const lifecycle = engine.lifecycle!
    const standard = target.find((element) => element.dataset.sceneId === 'standard')!
    now = 25
    pulse!()
    flush(engine)
    expect(
      standard.find((element) => element.dataset.componentId === 'footer')?.textContent,
    ).toContain('Turn 0 · World time 25 ms')
    lifecycle.enterScene('settings')
    const read = vi.spyOn(lifecycle.currentGame!.bindings!, 'read')
    now = 40
    pulse!()
    flush(engine)
    expect(read).not.toHaveBeenCalled()
    lifecycle.enterScene('inventory')
    expect(
      target.find((element) => element.dataset.componentId === 'footer')?.textContent,
    ).toContain('Turn 0 · World time 40 ms')
    engine.stop()
  })
})

describe.each([
  ['engine', (element: HTMLElement): IEngineHost => new DomEngineHost(element)],
  ['editor preview', (element: HTMLElement): IEngineHost => new EditorPreviewHost(element)],
] as const)('%s rendering integration', (_name, createHost) => {
  it('updates bound text in place, diagnoses missing values, and follows all three scenes', async () => {
    const content = await loader.load()
    const { target } = setup(content)
    const engine = bindingEngine(content, createHost(target.asElement()))
    await engine.start()
    const lifecycle = engine.lifecycle!
    const game = lifecycle.currentGame!
    const standard = target.find((element) => element.dataset.sceneId === 'standard')!
    const status = standard.find((element) => element.dataset.componentId === 'player-status')!
    const heading = standard.find((element) => element.dataset.componentId === 'location-title')!
    const footer = standard.find((element) => element.dataset.componentId === 'footer')!
    expect(status.textContent).toContain('Health 40 / 40')
    expect(footer.textContent).toContain('Turn 0 · World time 0 ms')
    engine.input!.pressKey('Enter')
    engine.input!.releaseKey('Enter')
    flush(engine)
    expect(status.textContent).toContain('Health 33 / 40')
    expect(footer.textContent).toContain('Turn 1 · World time 1000 ms')
    expect(target.find((element) => element.dataset.sceneId === 'standard')).toBe(standard)
    expect(standard.find((element) => element.dataset.componentId === 'location-title')).toBe(
      heading,
    )

    game.actions!.request('forget')
    flush(engine)
    if (_name === 'editor preview') {
      expect(status.textContent).toContain('Health [unresolved: health] / 40')
      expect(status.title).toBe('health: game.state ["player","health"] (missing-path)')
      expect(status.dataset.bindingStatus).toBe('unresolved')
    } else {
      expect(status.textContent).toContain('Health 40 / 40')
      expect(status.textContent).not.toContain('[unresolved:')
      expect(status.title).toBe('')
      expect(status.dataset.bindingStatus).toBeUndefined()
    }
    game.actions!.request('heal')
    flush(engine)
    expect(status.textContent).toContain('Health 40 / 40')
    expect(status.title).toBe('')
    if (_name === 'editor preview') expect(status.dataset.bindingStatus).toBe('resolved')

    const detachedText = status.textContent
    const oldWrites = vi.spyOn(status, 'textContent', 'set')
    lifecycle.enterScene('inventory')
    const inventory = target.find((element) => element.dataset.sceneId === 'inventory')!
    const inventoryFooter = inventory.find((element) => element.dataset.componentId === 'footer')!
    expect(inventoryFooter.textContent).toContain('Health 40 / 40 · Turn 1')
    game.actions!.request('damage')
    flush(engine)
    expect(inventoryFooter.textContent).toContain('Health 33 / 40 · Turn 2 · World time 2000 ms')
    expect(status.textContent).toBe(detachedText)
    expect(oldWrites).not.toHaveBeenCalled()

    lifecycle.enterScene('settings')
    const settings = target.find((element) => element.dataset.sceneId === 'settings')!
    const settingsText = settings.textContent
    const read = vi.spyOn(game.bindings!, 'read')
    game.actions!.request('damage')
    flush(engine)
    expect(read).not.toHaveBeenCalled() // Settings owns no subscriptions to current-game data.
    expect(settings.textContent).toBe(settingsText)
    expect(lifecycle.currentGame).toBe(game)
    lifecycle.enterScene('standard')
    expect(
      target.find((element) => element.dataset.componentId === 'player-status')?.textContent,
    ).toContain('Health 26 / 40')
    expect(
      target.find((element) => element.dataset.componentId === 'footer')?.textContent,
    ).toContain('Turn 3 · World time 3000 ms')
    engine.stop()
    expect(target.children).toHaveLength(0)
  })

  it('renders bound values as literal text and rebinds after game replacement and engine restart', async () => {
    const content = await loader.load()
    const { target } = setup(content)
    const engine = bindingEngine(content, createHost(target.asElement()))
    await engine.start()
    const lifecycle = engine.lifecycle!
    const first = lifecycle.currentGame!
    const firstBindings = first.bindings
    first.actions!.request('markup')
    flush(engine)
    const status = target.find((element) => element.dataset.componentId === 'player-status')!
    expect(status.textContent).toContain('<b>{{turn}}</b>')
    expect(status.children).toEqual([])
    first.actions!.request('heal')
    engine.flushMessages() // Leave old outcome notifications queued.
    const second = lifecycle.startGame()
    lifecycle.enterScene('inventory')
    flush(engine)
    expect(
      target.find((element) => element.dataset.componentId === 'footer')?.textContent,
    ).toContain('Health 40 / 40 · Turn 0 · World time 0 ms')
    expect(second.bindings).not.toBe(firstBindings)
    expect(status.textContent).toContain('<b>{{turn}}</b>')
    lifecycle.endGame()
    expect(target.find((element) => element.dataset.sceneId === 'inventory')).toBeUndefined()
    lifecycle.enterScene('settings')
    lifecycle.startGame()
    expect(target.find((element) => element.dataset.sceneId === 'settings')).toBeDefined()
    engine.stop()
    await engine.start()
    expect(
      target.find((element) => element.dataset.componentId === 'player-status')?.textContent,
    ).toContain('Health 40 / 40')
    engine.stop()
  })

  it('shows editor diagnostics or standalone fallbacks without an application-state factory', async () => {
    const { target } = setup(await loader.load())
    const engine = new Engine(
      loader,
      createHost(target.asElement()),
      logger,
      () => new MessageBus<EngineMessages>(),
      timing,
    )
    await engine.start()
    const status = target.find((element) => element.dataset.componentId === 'player-status')!
    expect(status.textContent).toContain(
      _name === 'editor preview' ? 'Health [unresolved: health] / 40' : 'Health 40 / 40',
    )
    if (_name === 'editor preview') expect(status.title).toContain('(source-unavailable)')
    engine.stop()
  })

  it('selects the first scene, follows changes, and disposes and remounts with the engine', async () => {
    const { target } = setup(await loader.load())
    const engine = new Engine(
      loader,
      createHost(target.asElement()),
      logger,
      () => new MessageBus<EngineMessages>(),
      timing,
    )
    await engine.start()
    const lifecycle = engine.lifecycle!
    expect(lifecycle.activeScene?.data.id).toBe('standard')
    expect(engine.actions).toBe(lifecycle.currentGame?.actions)
    expect(target.find((element) => element.dataset.sceneId === 'standard')).toBeDefined()
    lifecycle.enterScene('inventory')
    expect(target.find((element) => element.dataset.sceneId === 'standard')).toBeUndefined()
    expect(target.find((element) => element.dataset.sceneId === 'inventory')).toBeDefined()
    lifecycle.enterScene('settings')
    expect(target.find((element) => element.dataset.sceneId === 'settings')).toBeDefined()
    lifecycle.endGame()
    expect(target.find((element) => element.dataset.sceneId === 'settings')).toBeDefined()
    engine.stop()
    expect(target.children).toHaveLength(0)
    await engine.start()
    expect(target.find((element) => element.dataset.sceneId === 'standard')).toBeDefined()
    engine.stop()
  })
})

describe('editor scene picker', () => {
  it('switches the three scenes and empty selection through the lifecycle, and removes its listener', async () => {
    const game = await loader.load()
    const { lifecycle, target } = setup(game)
    const cleanup = mountGameView(
      target.asElement(),
      game,
      { lifecycle, input: undefined },
      { scenePicker: true },
    )
    const select = target.find((element) => element.tagName === 'SELECT')!
    expect(select.value).toBe('standard')
    const playthrough = lifecycle.currentGame
    for (const id of ['inventory', 'settings', 'standard', '']) {
      select.value = id
      select.dispatchEvent(new Event('change'))
      expect(lifecycle.activeScene?.data.id ?? '').toBe(id)
      expect(lifecycle.currentGame).toBe(playthrough)
    }
    lifecycle.endGame()
    select.value = 'inventory'
    select.dispatchEvent(new Event('change'))
    expect(lifecycle.currentGame).not.toBe(playthrough)
    cleanup()
    cleanup()
    const enter = vi.spyOn(lifecycle, 'enterScene')
    select.value = 'settings'
    select.dispatchEvent(new Event('change'))
    expect(enter).not.toHaveBeenCalled()
    expect(target.children).toHaveLength(0)
  })

  it('cleans up a failed mount after selecting an initial scene', async () => {
    const game = await loader.load()
    const { lifecycle, target } = setup(game)
    vi.spyOn(lifecycle, 'enterScene').mockImplementationOnce(() => {
      throw new Error('Cannot enter scene')
    })
    expect(() =>
      mountGameView(
        target.asElement(),
        game,
        { lifecycle, input: undefined },
        { scenePicker: true },
      ),
    ).toThrow('Cannot enter scene')
    expect(target.children).toHaveLength(0)
  })
})
