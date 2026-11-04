/// <reference lib="dom" />
import { readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import { gameSchema, languageCatalogSchema } from '@ancadeba/schemas'
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
import {
  ComponentRenderer,
  TextComponentRenderer,
  LanguageSelectComponentRenderer,
  mountGameView,
  SceneRenderer,
  type IComponentRenderer,
} from '@ancadeba/ui-components'
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

class CSSScopeRule {
  readonly cssRules: unknown[] = []
}

class TestElement extends EventTarget {
  readonly children: TestElement[] = []
  readonly style = new TestStyle()
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly sheet = { insertRule: vi.fn(), cssRules: [new CSSScopeRule()] }
  parent: TestElement | undefined
  className = ''
  media = ''
  readonly classList = {
    add: (name: string) => {
      this.className = [this.className, name].filter(Boolean).join(' ')
    },
  }
  tabIndex = -1
  title = ''
  value = ''
  disabled = false
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

  get firstChild(): TestElement | undefined {
    return this.children[0]
  }
  append(...children: TestElement[]): void {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }

  replaceChildren(...children: TestElement[]): void {
    this.textContent = ''
    this.append(...children)
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
    // @ts-expect-error -- Deliberately partial DOM fixture supplies only the operations used by these renderers.
    return this
  }
}

class TestDocument extends EventTarget {
  readonly defaultView = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  })
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
        // SAFETY: the paired lifecycle factory creates BindingDemoState for this engine.
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

function startSampleGame(target: TestElement): void {
  const button = target.find((element) => element.dataset.componentId === 'new-game')!
  button.dispatchEvent(new Event('click'))
}

function flush(engine: Engine): void {
  for (let batch = 0; batch < 4; batch++) engine.flushMessages()
}

describe('scene renderer', () => {
  it.each([
    { language: 'en', id: 'basic-game' },
    { language: 'nl', id: 'renamed-museum' },
  ])(
    'plays the museum puzzle and harbour route from data for $id ($language)',
    async ({ language, id }) => {
      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...source,
            readText: async (path) => {
              const contents = await source.readText(path)

              if (path !== 'game.json') return contents

              return JSON.stringify({ ...gameSchema.parse(JSON.parse(contents)), id })
            },
          },
          logger,
        ),
        [language],
      ).load()

      expect(game.id).toBe(id)
      expect(game.language).toBe(language)

      const catalog = languageCatalogSchema.parse(
        JSON.parse(await source.readText(`languages/${language}/messages.json`)),
      )

      const message = (key: string) => catalog[`museum.rules.${key}`]!
      const occurrences = (text: string, key: string) => text.split(message(key)).length - 1
      const { target } = setup(game)

      const engine = new Engine(
        { load: async () => game },
        new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)

      const component = (id: string) => target.find((node) => node.dataset.componentId === id)!

      const mapColumn = (id = 'museum-map') =>
        component(id)
          .find((node) => node.className === 'ancadeba-map-player')
          ?.style.getPropertyValue('--ge-map-player-column')

      const click = (id: string) => component(id).dispatchEvent(new Event('click'))

      const inspectLetter = () =>
        component('items').find((node) => node.dataset.inspectItem === 'folded-letter')

      const inspectChart = () =>
        component('items').find((node) => node.dataset.inspectItem === 'harbour-chart')

      expect(component('nearby').textContent).toContain(message('letter'))
      expect(component('player-status').textContent).toContain('40 / 40')
      expect(component('items').textContent).toContain('Empty')
      expect(inspectLetter()).toBeUndefined()
      expect(component('clock').textContent).toContain('09:00')
      expect(mapColumn()).toBe('2')

      click('take-letter')
      click('take-letter')
      flush(engine)
      expect(component('take-letter').disabled).toBe(true)
      expect(component('nearby').textContent).toContain(message('empty'))
      expect(component('items').textContent).toContain('Folded letter')
      expect(occurrences(component('event-log').textContent, 'pickup')).toBe(1)
      expect(engine.actions?.progression.worldTimeMs).toBe(0)

      click('walk-east')
      click('walk-east')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('gallery')
      expect(mapColumn()).toBe('6')
      expect(component('clock').textContent).toContain('09:01')
      expect(component('items').textContent).toContain('Folded letter')
      expect(component('event-log').textContent).toContain(message('pickup'))
      expect(component('event-log').textContent).toContain(`09:01  ${message('gallery')}`)
      expect(engine.actions?.progression.worldTimeMs).toBe(60_000)
      expect(component('nearby').textContent).toContain(message('caseLabel'))
      expect(component('press-crown').disabled).toBe(true)
      expect(component('press-heron').disabled).toBe(true)
      expect(component('take-chart').disabled).toBe(true)
      expect(inspectChart()).toBeUndefined()
      expect(component('items').textContent).not.toContain(message('clue'))

      engine.actions?.request('press-heron')
      engine.actions?.request('take-chart')
      engine.actions?.request('inspect-chart', 'harbour-chart')
      flush(engine)
      expect(component('nearby').textContent).toContain(message('caseLabel'))
      expect(component('event-log').textContent).not.toContain(message('chartRead'))
      expect(inspectChart()).toBeUndefined()

      inspectLetter()!.dispatchEvent(new Event('click'))
      flush(engine)
      expect(component('items').textContent).toContain(message('clue'))
      expect(component('event-log').textContent).toContain(message('read'))
      expect(component('press-heron').disabled).toBe(false)

      click('press-crown')
      flush(engine)
      expect(component('nearby').textContent).toContain(message('caseLabel'))
      expect(component('narrative').textContent).toContain(message('wrongSymbol'))

      click('press-heron')
      flush(engine)
      expect(component('nearby').textContent).toContain(message('caseOpenLabel'))
      expect(component('narrative').textContent).toContain(message('caseOpen'))
      expect(component('event-log').textContent).toContain(message('opened'))
      expect(component('press-heron').disabled).toBe(true)
      expect(component('take-chart').disabled).toBe(false)
      expect(component('nearby').textContent).toContain(message('caseOpenWithChart'))
      expect(inspectChart()).toBeUndefined()

      click('take-chart')
      click('take-chart')
      flush(engine)
      expect(component('take-chart').disabled).toBe(true)
      expect(component('nearby').textContent).not.toContain(message('caseOpenWithChart'))
      expect(component('narrative').textContent).toContain(message('caseEmpty'))
      expect(component('items').textContent).toContain('Harbour chart')
      expect(component('items').textContent).not.toContain(message('chartDetails'))
      expect(occurrences(component('event-log').textContent, 'chartPickup')).toBe(1)

      expect(component('clock').textContent).toContain('09:01')

      click('walk-west')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('standard')
      expect(mapColumn()).toBe('2')
      expect(component('clock').textContent).toContain('09:02')
      expect(component('take-letter').disabled).toBe(true)
      expect(component('items').textContent).toContain(message('clue'))

      click('walk-to-harbour')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('old-harbour')
      expect(component('follow-chart-to-buoy').disabled).toBe(true)
      expect(mapColumn('harbour-map')).toBe('2')

      engine.actions?.request('follow-chart-to-buoy')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('old-harbour')
      expect(component('clock').textContent).toContain('09:05')

      inspectChart()!.dispatchEvent(new Event('click'))
      inspectChart()!.dispatchEvent(new Event('click'))
      flush(engine)
      expect(component('items').textContent).toContain(message('chartDetails'))
      expect(occurrences(component('event-log').textContent, 'chartRead')).toBe(1)
      expect(component('follow-chart-to-buoy').disabled).toBe(false)

      click('follow-chart-to-buoy')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('shoals')
      expect(mapColumn('harbour-map')).toBe('4')
      expect(component('clock').textContent).toContain('09:09')

      click('follow-chart-to-landing')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('north-cliff-landing')
      expect(mapColumn('harbour-map')).toBe('6')
      expect(component('clock').textContent).toContain('09:12')
      expect(component('event-log').textContent).toContain(`09:12  ${message('landing')}`)
      expect(component('items').textContent).toContain(message('chartDetails'))

      click('return-to-buoy')
      flush(engine)
      click('return-to-harbour')
      flush(engine)
      click('walk-to-museum')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('standard')
      expect(component('clock').textContent).toContain('09:20')

      click('walk-east')
      flush(engine)
      expect(component('nearby').textContent).toContain(message('caseOpenLabel'))
      expect(component('take-chart').disabled).toBe(true)

      expect(component('event-log').textContent).not.toContain('09:00  ' + message('lobby'))

      engine.lifecycle?.enterScene('start-screen')
      startSampleGame(target)
      expect(component('take-letter').disabled).toBe(false)
      expect(component('items').textContent).toContain('Empty')
      expect(component('event-log').textContent).not.toContain(message('pickup'))
      expect(component('clock').textContent).toContain('09:00')

      click('walk-east')
      flush(engine)
      expect(component('nearby').textContent).toContain(message('caseLabel'))
      expect(component('press-heron').disabled).toBe(true)
      expect(component('take-chart').disabled).toBe(true)
      expect(inspectChart()).toBeUndefined()
    },
  )

  it('finishes an authored action when an observer throws after its effect commits', async ({
    onTestFinished,
  }) => {
    const logError = vi.fn<ILogger['error']>().mockReturnValue('')

    const engine = new Engine(
      loader,
      { mount: () => () => {} },
      { ...logger, error: logError },
      () => new MessageBus<EngineMessages>(),
      timing,
    )

    await engine.start()
    const lifecycle = engine.lifecycle!
    const game = lifecycle.startGame()
    lifecycle.enterScene('standard')

    const failNotification = () => {
      throw new Error('Observer failed')
    }

    const removeInventory = game.inventory!.subscribeChanges(failNotification)
    const removeScene = lifecycle.subscribeSceneChanges(failNotification)
    onTestFinished(() => {
      removeInventory()
      removeScene()
      engine.stop()
    })

    game.actions!.request('take-letter')
    game.actions!.request('walk-east')
    flush(engine)

    expect(lifecycle.activeScene?.data.id).toBe('gallery')
    expect(game.inventory?.snapshot.find(({ id }) => id === 'folded-letter')?.placement).toEqual({
      type: 'carried',
      owner: 'player',
    })
    expect(game.bindings?.read({ source: 'game.state', path: ['canTakeLetter'] })).toEqual({
      status: 'resolved',
      value: false,
    })
    expect(game.bindings?.read({ source: 'game.state', path: ['log'] })).toMatchObject({
      status: 'resolved',
      value: expect.stringContaining('09:01  Entered the east gallery.'),
    })
    expect(game.actions?.progression.worldTimeMs).toBe(60_000)
    expect(logError).toHaveBeenCalledTimes(2)
  })

  it('follows the Coast Road player at terrain speed and stops at forests and map edges', async ({
    onTestFinished,
  }) => {
    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          ...source,
          readText: (path) =>
            readFile(new URL(`../sample-games/square-map/${path}`, import.meta.url), 'utf8'),
        },
        logger,
      ),
    ).load()

    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })

    const { lifecycle, target } = setup(game)
    const dispose = mountGameView(target.asElement(), game, { lifecycle, input: undefined })
    const view = target.find((element) => element.dataset.componentId === 'coast-map')!
    const grid = view.children[0]!.children[0]!
    const player = grid.find((element) => element.className === 'ancadeba-map-player')!

    const cameraPosition = () =>
      ['--ge-map-x', '--ge-map-y'].map((property) => grid.style.getPropertyValue(property))

    const playerCell = () =>
      ['--ge-map-player-column', '--ge-map-player-row'].map((property) =>
        player.style.getPropertyValue(property),
      )

    const press = (key: string) => {
      const event = new Event('keydown', { cancelable: true })
      Object.defineProperty(event, 'key', { value: key })
      view.dispatchEvent(event)

      return event.defaultPrevented
    }

    expect(view.tabIndex).toBe(0)
    expect(
      grid.children.filter((element) => element.className === 'ancadeba-map-tile'),
    ).toHaveLength(16 * 10)
    expect(playerCell()).toEqual(['10', '5'])
    expect(cameraPosition()).toEqual(['5', '2'])
    expect(press('ArrowUp')).toBe(true)
    expect(playerCell()).toEqual(['10', '5'])
    expect(cameraPosition()).toEqual(['5', '2'])
    expect(press('ArrowRight')).toBe(true)
    vi.advanceTimersByTime(149)
    expect(playerCell()).toEqual(['10', '5'])
    expect(cameraPosition()).toEqual(['5', '2'])
    vi.advanceTimersByTime(1)
    expect(playerCell()).toEqual(['11', '5'])
    expect(cameraPosition()).toEqual(['6', '2'])
    expect(press('Enter')).toBe(false)

    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowRight']) {
      press(key)
      vi.advanceTimersByTime(150)
    }

    expect(playerCell()).toEqual(['13', '6'])
    expect(cameraPosition()).toEqual(['7', '3'])

    press('ArrowRight')
    vi.advanceTimersByTime(150)
    expect(playerCell()).toEqual(['13', '6'])
    press('ArrowLeft')
    vi.advanceTimersByTime(149)
    expect(playerCell()).toEqual(['13', '6'])
    vi.advanceTimersByTime(1)
    expect(playerCell()).toEqual(['14', '6'])

    for (let step = 0; step < 10; step++) {
      press('ArrowRight')
      vi.advanceTimersByTime(300)
      press('ArrowDown')
      vi.advanceTimersByTime(300)
    }

    expect(playerCell()).toEqual(['16', '10'])
    expect(cameraPosition()).toEqual(['7', '4'])

    press('ArrowLeft')
    lifecycle.leaveScene()
    vi.advanceTimersByTime(300)
    expect(press('ArrowLeft')).toBe(false)
    expect(playerCell()).toEqual(['16', '10'])
    dispose()
  })

  it('uses injected component renderers while owning placement and component lifetimes', async () => {
    const game = await loader.load()
    const { lifecycle, target, document } = setup(game)
    lifecycle.enterScene('start-screen')
    const dispose = vi.fn()

    const buttonRenderer: IComponentRenderer = {
      render: vi.fn((component, context) => {
        expect(component.type).toBe('button')
        expect(context.document).toBe(document)
        expect(context.bindings).toBeUndefined()
        const element = document.createElement('aside')
        element.className = 'custom-button'

        return { element: element.asElement(), dispose }
      }),
    }

    const renderer = new SceneRenderer(
      target.asElement(),
      lifecycle,
      {},
      new ComponentRenderer({
        text: new TextComponentRenderer(),
        button: buttonRenderer,
        'language-select': new LanguageSelectComponentRenderer(),
      }),
    )

    const menu = target.children[0]!
    expect(menu.children[0]!.tagName).toBe('H2')
    expect(menu.children[0]!.className.split(' ')).toContain('ancadeba-text')
    expect(menu.children[0]!.className.split(' ')).toContain('ancadeba-scene-item')
    const button = menu.children[1]!
    expect(button.tagName).toBe('ASIDE')
    expect(button.className.split(' ')).toEqual(['custom-button', 'ancadeba-scene-item'])
    expect(button.dataset.componentId).toBe('new-game')
    expect(button.style.getPropertyValue('--ge-component-row')).toBe('5')
    expect(button.style.getPropertyValue('--ge-component-column-span')).toBe('4')
    lifecycle.leaveScene()
    expect(dispose).toHaveBeenCalledTimes(3)
    expect(target.children).toHaveLength(0)
    renderer.dispose()
    renderer.dispose()
    expect(dispose).toHaveBeenCalledTimes(3)
  })

  it('releases earlier components if a later component renderer fails', async () => {
    const { lifecycle, target, document } = setup(await loader.load())
    lifecycle.enterScene('start-screen')
    const dispose = vi.fn()

    const components: IComponentRenderer = {
      render: vi
        .fn()
        .mockReturnValueOnce({ element: document.createElement('div').asElement(), dispose })
        .mockImplementationOnce(() => {
          throw new Error('Button renderer failed')
        }),
    }

    expect(() => new SceneRenderer(target.asElement(), lifecycle, {}, components)).toThrow(
      'Button renderer failed',
    )
    expect(dispose).toHaveBeenCalledOnce()
    expect(target.children).toHaveLength(0)
  })

  it('releases both scenes when a component cleanup fails during scene replacement', async () => {
    const { lifecycle, target, document } = setup(await loader.load())
    lifecycle.enterScene('start-screen')

    const dispose = vi.fn().mockImplementationOnce(() => {
      throw new Error('Cleanup failed')
    })

    const components: IComponentRenderer = {
      render: () => ({ element: document.createElement('div').asElement(), dispose }),
    }

    const renderer = new SceneRenderer(target.asElement(), lifecycle, {}, components)
    expect(() => lifecycle.enterScene('settings')).toThrow()
    expect(dispose).toHaveBeenCalledTimes(8)
    expect(target.children).toHaveLength(0)
    renderer.dispose()
    expect(dispose).toHaveBeenCalledTimes(8)
  })

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
    expect(standard.style.getPropertyValue('--ge-scene-compact-columns')).toBe(
      [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3].map((weight) => `minmax(0, ${weight}fr)`).join(' '),
    )
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
    expect(narrative.style.getPropertyValue('--ge-component-row-span')).toBe('7')
    expect(narrative.textContent).toContain('\n\n')
    const firstNode = standard
    lifecycle.enterScene('inventory')
    expect(firstNode.parent).toBeUndefined()
    expect(target.children).toHaveLength(1)
    expect(target.children[0]?.dataset.sceneId).toBe('inventory')
    const inventory = target.find((element) => element.dataset.componentId === 'items')!
    expect(inventory.className.split(' ')).toContain('ancadeba-scene-item')
    expect(
      inventory.find((element) => element.className === 'ancadeba-inventory-empty'),
    ).toBeDefined()

    playthrough.inventory?.move('folded-letter', { type: 'carried', owner: 'player' })
    playthrough.inventory?.move('harbour-chart', { type: 'carried', owner: 'player' })
    const itemList = inventory.find((element) => element.className === 'ancadeba-inventory-items')!
    expect(itemList.tagName).toBe('UL')
    expect(itemList.children.map((item) => item.textContent)).toEqual([
      'Folded letter',
      'Harbour chart',
    ])
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
    const heading = settings.components[0]!

    if (heading.type !== 'text') throw new Error('Expected text')

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
                ...heading,
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
    const heading = settings.components[0]!

    if (heading.type !== 'text') throw new Error('Expected text')

    const modified: GameData = {
      ...game,
      scenes: new Map([
        [
          'settings',
          {
            ...settings,
            components: [{ ...heading, text: literal }],
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
    startSampleGame(target)
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
  it('switches settings language immediately while preserving playthrough state and releasing listeners', async () => {
    const content = await loader.load()
    const { target } = setup(content)
    const engine = bindingEngine(content, createHost(target.asElement()))
    await engine.start()
    startSampleGame(target)
    const lifecycle = engine.lifecycle!
    const playthrough = lifecycle.currentGame!
    playthrough.actions!.request('damage')
    flush(engine)
    lifecycle.enterScene('settings')
    const settings = lifecycle.activeScene

    const selector = target.find(
      (element) => element.tagName === 'SELECT' && element.dataset.componentId === 'language',
    )!

    expect(selector.children.map(({ value, textContent }) => [value, textContent])).toEqual([
      ['en', 'English'],
      ['nl', 'Nederlands'],
    ])
    selector.value = 'nl'
    selector.dispatchEvent(new Event('change'))
    expect(lifecycle.activeScene).toBe(settings)
    expect(lifecycle.currentGame).toBe(playthrough)
    expect(target.find((element) => element.dataset.componentId === 'title')?.textContent).toBe(
      'Instellingen',
    )
    expect(
      target.find(
        (element) => element.tagName === 'SELECT' && element.dataset.componentId === 'language',
      )?.value,
    ).toBe('nl')
    expect(
      target.find((element) => element.className === 'ancadeba-game')?.attributes.get('lang'),
    ).toBe('nl')
    lifecycle.enterScene('standard')
    expect(
      target.find((element) => element.dataset.componentId === 'player-status')?.textContent,
    ).toContain('Gezondheid 33 / 40')
    expect(
      target.find((element) => element.dataset.componentId === 'footer')?.textContent,
    ).toContain('Beurt 1')
    selector.value = 'en'
    selector.dispatchEvent(new Event('change'))
    expect(content.localization?.current.language).toBe('nl')
    engine.stop()
    expect(target.children).toHaveLength(0)
    content.localization!.select('en')
    expect(target.children).toHaveLength(0)
  })

  it('opens the menu without a playthrough and routes buttons with listener cleanup', async () => {
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
    const menu = target.find((element) => element.dataset.sceneId === 'start-screen')!
    const buttons = menu.children.filter((element) => element.tagName === 'BUTTON')
    expect(buttons.map((button) => button.textContent)).toEqual([
      'New game',
      'Load Game',
      'Settings',
    ])
    expect(buttons.map((button) => button.disabled)).toEqual([false, true, false])
    expect(lifecycle.currentGame).toBeUndefined()
    buttons[2]!.dispatchEvent(new Event('click'))
    expect(lifecycle.activeScene?.data.id).toBe('settings')
    expect(lifecycle.currentGame).toBeUndefined()
    buttons[0]!.dispatchEvent(new Event('click'))
    expect(lifecycle.currentGame).toBeUndefined()
    target
      .find((element) => element.dataset.componentId === 'back')!
      .dispatchEvent(new Event('click'))
    startSampleGame(target)
    const first = lifecycle.currentGame!
    expect(lifecycle.activeScene?.data.id).toBe('standard')
    lifecycle.enterScene('start-screen')
    startSampleGame(target)
    expect(first.disposed).toBe(true)
    expect(lifecycle.currentGame).not.toBe(first)
    lifecycle.enterScene('start-screen')
    const detached = target.find((element) => element.dataset.componentId === 'new-game')!
    engine.stop()
    detached.dispatchEvent(new Event('click'))
    expect(target.children).toHaveLength(0)
  })

  it('updates bound text in place, diagnoses missing values, and follows all three scenes', async () => {
    const content = await loader.load()
    const { target } = setup(content)
    const engine = bindingEngine(content, createHost(target.asElement()))
    await engine.start()
    startSampleGame(target)
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
    startSampleGame(target)
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
    startSampleGame(target)
    expect(
      target.find((element) => element.dataset.componentId === 'player-status')?.textContent,
    ).toContain('Health 40 / 40')
    engine.stop()
  })

  it('shows editor diagnostics or standalone fallbacks without an application-state factory', async () => {
    const { rules: _rules, ...game } = await loader.load()
    const { target } = setup(game)

    const engine = new Engine(
      { load: async () => game },
      createHost(target.asElement()),
      logger,
      () => new MessageBus<EngineMessages>(),
      timing,
    )

    await engine.start()
    startSampleGame(target)
    const status = target.find((element) => element.dataset.componentId === 'player-status')!
    expect(status.textContent).toContain(
      _name === 'editor preview' ? 'Health [unresolved: health] / 40' : 'Health 40 / 40',
    )

    if (_name === 'editor preview') expect(status.title).toContain('(source-unavailable)')
    engine.stop()
  })

  it('selects the configured initial scene, follows changes, and remounts with the engine', async () => {
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
    const style = target.find((element) => element.tagName === 'STYLE')!
    expect(style.parent?.className).toBe('ancadeba-scene-viewport')
    expect(style.sheet.insertRule).toHaveBeenCalledExactlyOnceWith(
      `@scope {\n${engine.game?.stylesheet}\n}`,
      0,
    )
    expect(style.media).toBe('')
    expect(lifecycle.activeScene?.data.id).toBe('start-screen')
    expect(lifecycle.currentGame).toBeUndefined()
    startSampleGame(target)
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
    expect(target.find((element) => element.dataset.sceneId === 'start-screen')).toBeDefined()
    expect(target.find((element) => element.tagName === 'STYLE')).not.toBe(style)
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
    expect(select.value).toBe('start-screen')
    startSampleGame(target)
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
