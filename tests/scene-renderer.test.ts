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
})

describe.each([
  ['engine', (element: HTMLElement): IEngineHost => new DomEngineHost(element)],
  ['editor preview', (element: HTMLElement): IEngineHost => new EditorPreviewHost(element)],
] as const)('%s rendering integration', (_name, createHost) => {
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
