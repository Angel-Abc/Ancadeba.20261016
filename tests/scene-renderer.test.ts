/// <reference lib="dom" />
import { readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import {
  gameSchema,
  gameRulesSchema,
  languageCatalogSchema,
  mapDefinitionSchema,
} from '@ancadeba/schemas'
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
  applyMapCellAppearance,
} from '@ancadeba/ui-components'
import { DomEngineHost } from '../apps/engine/src/engineHost.js'
import { EditorPreviewHost } from '../apps/editor-ui/src/previewHost.js'

// A DOM surface harness verifies renderer ownership and real event listener cleanup.
// Actual CSS layout is also checked in a browser using this same sample game.
class TestStyle {
  backgroundColor = ''
  backgroundImage = ''
  backgroundPosition = ''
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
  hidden = false
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
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

      return this.dataset[key] ?? null
    }

    return this.attributes.get(name) ?? null
  }

  get firstChild(): TestElement | undefined {
    return this.children[0]
  }
  focus(): void {
    this.ownerDocument.activeElement = this
  }
  append(...children: TestElement[]): void {
    for (const child of children) {
      child.remove()
      child.parent = this
      this.children.push(child)
    }
  }
  prepend(...children: TestElement[]): void {
    for (const child of [...children].reverse()) {
      child.remove()
      child.parent = this
      this.children.unshift(child)
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
  querySelector(selector: string): TestElement | null {
    return (
      this.find((node) =>
        selector.startsWith('.')
          ? node.className.split(' ').includes(selector.slice(1))
          : node.tagName.toLowerCase() === selector,
      ) ?? null
    )
  }
  asElement(): HTMLElement {
    // @ts-expect-error -- Deliberately partial DOM fixture supplies only the operations used by these renderers.
    return this
  }
}

class TestDocument extends EventTarget {
  readonly defaultView = Object.assign(new EventTarget(), {
    confirm: vi.fn(() => true),
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

const squareMapSource: IResourceSource = {
  readText: (path) =>
    readFile(new URL(`../sample-games/square-map/${path}`, import.meta.url), 'utf8'),
  readBytes: async (path) =>
    new Uint8Array(await readFile(new URL(`../sample-games/square-map/${path}`, import.meta.url))),
}

const loader = new GameLoader(new JsonResourceLoader(source, logger))

// Keep text-binding regressions independent of the sample's optional status presentation.
const textBindingLoader = new GameLoader(
  new JsonResourceLoader(
    {
      ...source,
      readText: async (path) => {
        const text = await source.readText(path)

        if (!path.startsWith('scenes/')) return text
        const scene = JSON.parse(text)
        scene.components = scene.components.map(
          (component: { id: string; type: string; placement: unknown }) =>
            component.id === 'player-status' && component.type === 'status-panel'
              ? {
                  id: component.id,
                  type: 'text',
                  placement: component.placement,
                  textKey:
                    scene.id === 'gallery'
                      ? 'scenes.gallery.components.player-status.text'
                      : 'scenes.standard.components.player-status.text',
                  bindings: {
                    health: { source: 'game.state', path: ['player', 'health'], fallback: '40' },
                  },
                }
              : component,
        )

        return JSON.stringify(scene)
      },
    },
    logger,
  ),
)

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

interface StatusDemoState {
  player: { health?: unknown; maximumHealth: number; level: number; gold: string | number }
  letterRead: boolean
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
  it.each([false, true])(
    'displays interception and restores consumed lethal protection in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: async (path) => {
          const raw = await readFile(
            new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url),
            'utf8',
          )

          if (path !== 'rules/state.json') return raw
          const rules = JSON.parse(raw)
          rules.state.find((field: { path: string[] }) => field.path[0] === 'player-health').value =
            1

          return JSON.stringify(rules)
        },
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument(),
        target = document.createElement('main')

      const saves = new Map<string, string>()

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          ...timing,
          saveStore: {
            read: (id) => saves.get(id),
            write: (id, value) => {
              saves.set(id, value)
            },
          },
        },
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('diving-gear')
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!

      const click = (id: string) => {
        slot(id).dispatchEvent(new Event('click'))
        flush(engine)
      }

      const snapshot = () =>
        engine.lifecycle!.currentGame!.combat!.snapshot(engine.lifecycle!.activeScene!, 'combat')!

      engine.lifecycle!.currentGame!.inventorySelection!.select(
        engine.lifecycle!.activeScene!,
        'gear-items',
        'rescue-charm',
      )
      flush(engine)
      click('1')
      click('8')
      expect(engine.lifecycle!.activeScene!.data.id).toBe('water-interception')
      expect(target.textContent).toContain('previews are before interception')
      click('15')
      expect(snapshot().health.player).toBe(1)
      expect(snapshot().outcome).toBeUndefined()
      expect(target.textContent).toContain('Lethal-hit prevention changes')
      expect(engine.saves!.save()).toBe(true)
      click('15')
      const defeated = snapshot()
      expect(defeated.outcome).toBe('defeat')
      expect(engine.saves!.load()).toBe(true)
      click('15')
      expect(snapshot().outcome).toBe('defeat')
      expect(snapshot().log).toEqual(defeated.log)
    },
  )

  it.each([false, true])(
    'shows equipment/status passives and restores once-only source history in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: async (path) => {
          const raw = await readFile(
            new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url),
            'utf8',
          )

          if (path !== 'combat-libraries/environments.json') return raw
          const library = JSON.parse(raw)
          library.passives['tidal-relief'].triggers['water-relief'].once = true

          return JSON.stringify(library)
        },
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument(),
        target = document.createElement('main')

      const saves = new Map<string, string>()

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          ...timing,
          saveStore: {
            read: (id) => saves.get(id),
            write: (id, value) => {
              saves.set(id, value)
            },
          },
        },
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('diving-gear')
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!

      const click = (id: string) => {
        slot(id).dispatchEvent(new Event('click'))
        flush(engine)
      }

      const snapshot = () =>
        engine.lifecycle!.currentGame!.combat!.snapshot(engine.lifecycle!.activeScene!, 'combat')!

      engine.lifecycle!.currentGame!.inventorySelection!.select(
        engine.lifecycle!.activeScene!,
        'gear-items',
        'tidal-charm',
      )
      flush(engine)
      expect(target.textContent).toContain('Grants passive Tidal relief')
      click('1')
      click('6')
      expect(engine.lifecycle!.activeScene!.data.id).toBe('water-passives')
      click('6')
      click('12')
      click('15')
      expect(snapshot().resources.exhaustion).toBe(4)
      expect(target.textContent).toContain('Current reserve (Conductive attunement) activates')
      expect(target.textContent).toContain('Tidal relief (Tidal charm) activates')
      expect(
        target.find((node) => node.dataset.statusEffect === 'conductive-attunement')!.textContent,
      ).toContain('Passives: Current reserve')
      expect(engine.saves!.save()).toBe(true)
      click('15')
      const next = snapshot()
      expect(next.resources.exhaustion).toBe(14)
      expect(engine.saves!.load()).toBe(true)
      click('15')
      expect(snapshot().log).toEqual(next.log)
      expect(snapshot().resources).toEqual(next.resources)
      click('8')
      click('15')
      engine.lifecycle!.enterScene('underwater-boss-passives')
      click('6')
      click('12')
      click('15')
      expect(snapshot().resources.seal).toBe(18)
      expect(target.textContent).toContain('Current reserve (Conductive attunement) activates')
    },
  )

  it.each([false, true])(
    'explains action requirements and restores queued requirement failures in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: (path) =>
          readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url), 'utf8'),
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument()
      const target = document.createElement('main')
      const saves = new Map<string, string>()

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          ...timing,
          saveStore: {
            read: (id) => saves.get(id),
            write: (id, value) => {
              saves.set(id, value)
            },
          },
        },
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('water-requirements')
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!

      const snapshot = () =>
        engine.lifecycle!.currentGame!.combat!.snapshot(engine.lifecycle!.activeScene!, 'combat')!

      const click = (id: string) => {
        slot(id).dispatchEvent(new Event('click'))
        flush(engine)
      }

      expect(slot('7').disabled).toBe(true)
      expect(slot('7').title).toContain('Rhythm dive unavailable')
      expect(slot('7').title).toContain('current 0')
      expect(slot('7').attributes.get('aria-description')).toBe(slot('7').title)

      for (let i = 0; i < 3; i++) click('6')
      expect(slot('7').disabled).toBe(true)
      click('15')
      expect(slot('7').disabled).toBe(false)
      click('7')
      click('7')
      expect(engine.saves!.save()).toBe(true)
      click('15')
      const first = snapshot()
      expect(first.log.some((entry) => entry.type === 'requirementsUnavailable')).toBe(true)
      expect(first.resources.stamina).toBe(82)
      expect(slot('7').disabled).toBe(true)
      expect(target.textContent).toContain('Rhythm dive unavailable: requires')
      expect(engine.saves!.load()).toBe(true)
      expect(snapshot().plan).toHaveLength(2)
      click('15')
      expect(snapshot().log).toEqual(first.log)
      expect(snapshot().resources).toEqual(first.resources)
      click('8')
      click('15')
      engine.lifecycle!.enterScene('underwater-boss-requirements')
      expect(slot('11').disabled).toBe(true)
      expect(slot('11').title).toContain('Seal release unavailable')
      expect(slot('11').title).toContain('Phase')
      expect(slot('11').title).toContain('OR')
    },
  )

  it.each([false, true])(
    'compares diving gear, equips it and displays defenses and granted moves in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: (path) =>
          readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url), 'utf8'),
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('diving-gear')
      const game = engine.lifecycle!.currentGame!
      const scene = engine.lifecycle!.activeScene!
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!
      game.inventorySelection!.select(scene, 'gear-items', 'diving-suit')
      flush(engine)
      expect(target.textContent).toContain('Equipment comparison')
      expect(target.textContent).toContain('water resistance 25%')
      slot('1').dispatchEvent(new Event('click'))
      flush(engine)
      game.inventorySelection!.select(scene, 'gear-items', 'rebreather')
      flush(engine)
      expect(target.textContent).toContain('exhaustion gains: +0, then -50%')
      expect(target.textContent).toContain('Grants Purge valve')
      slot('1').dispatchEvent(new Event('click'))
      slot('3').dispatchEvent(new Event('click'))
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('water-gear')
      expect(
        target.find((node) => node.dataset.combatEquipment === 'player')!.textContent,
      ).toContain('Rebreather')
      expect(
        target.find((node) => node.dataset.combatDamageDefenses === 'player')!.textContent,
      ).toContain('water: resistance 25%')
      expect(slot('6').disabled).toBe(false)
      slot('6').dispatchEvent(new Event('click'))
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(target.textContent).toContain('equipment changes gain 10 → 5')
      const battle = engine.lifecycle!.activeScene!
      expect(game.combat!.snapshot(battle, 'combat')!.resources.exhaustion).toBe(0)
      expect(game.inventory!.move('rebreather', { type: 'carried', owner: 'diver' }).status).toBe(
        'rejected',
      )
      game.combat!.request(battle, 'combat', { type: 'escape' })
      game.combat!.request(battle, 'combat', { type: 'end-turn' })
      flush(engine)
      engine.lifecycle!.enterScene('underwater-boss-gear')
      expect(
        target.find((node) => node.dataset.combatDamageDefenses === 'player')!.textContent,
      ).toContain('water: resistance 75%')
      expect(slot('6').disabled).toBe(false)
    },
  )

  it.each([false, true])(
    'shows restriction reasons, utility recovery and status immunity in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: async (path) => {
          const source = await readFile(
            new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url),
            'utf8',
          )

          if (path !== 'combat/water.json') return source
          const combat = JSON.parse(source)
          combat.mechanics.triggers['start-controls'] = {
            event: 'encounter-start',
            effects: [
              { type: 'apply-status', actor: 'player', status: 'silenced' },
              { type: 'apply-status', actor: 'player', status: 'disarmed' },
            ],
          }

          return JSON.stringify(combat)
        },
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('water-controls')
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!
      slot('11').dispatchEvent(new Event('click'))
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(slot('12').disabled).toBe(true)
      expect(slot('12').title).toContain('blocked (spell)')
      expect(slot('13').disabled).toBe(true)
      expect(slot('13').title).toContain('blocked (weapon)')
      expect(slot('3').disabled).toBe(false)
      expect(
        target.find((node) => node.dataset.combatRestrictions === 'player')!.textContent,
      ).toContain('spell, weapon')
      expect(
        target.find((node) => node.dataset.statusEffect === 'silenced')!.textContent,
      ).toContain('Blocked move categories: spell')
      slot('3').dispatchEvent(new Event('click'))
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(slot('12').disabled).toBe(false)
      expect(slot('13').disabled).toBe(false)
      target
        .find(
          (node) => node.tagName === 'BUTTON' && node.textContent === 'Return to standard controls',
        )!
        .dispatchEvent(new Event('click'))
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('water')
      expect(target.textContent).toContain('Round 3')
      // Both fights share the diver loadout; finish the first before starting another.
      slot('8').dispatchEvent(new Event('click'))
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      engine.lifecycle!.enterScene('underwater-boss-controls')
      expect(
        target.find((node) => node.dataset.combatRestrictions === 'guardian')!.textContent,
      ).toContain('Dazed, Disarmed')
      slot('1').dispatchEvent(new Event('click'))
      flush(engine)
      expect(target.find((node) => node.dataset.combatActor === 'player')!.textContent).toContain(
        'immune to Disarmed',
      )
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(target.textContent).toContain('Tidal guardian is immune to Disarmed')
    },
  )

  it.each([false, true])(
    'shows typed previews, defenses and immune periodic damage in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: (path) =>
          readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url), 'utf8'),
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('water')
      const defenses = target.find((node) => node.dataset.combatDamageDefenses === 'eel')!
      expect(defenses.textContent).toContain('water: resistance 50%')
      expect(defenses.textContent).toContain('lightning: vulnerability 50%')
      expect(defenses.textContent).toContain('Immune to poison')
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!

      for (const id of ['11', '12', '13']) {
        slot(id).dispatchEvent(new Event('click'))
        flush(engine)
      }

      const player = target.find((node) => node.dataset.combatActor === 'player')!
      expect(player.textContent).toContain('6–6 water')
      expect(player.textContent).toContain('18–18 lightning')
      expect(player.textContent).toContain('Immune to poison')
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(target.textContent).toContain('6 water damage')
      expect(target.textContent).toContain('18 lightning damage')
      expect(target.find((node) => node.dataset.statusEffect === 'venom')!.textContent).toContain(
        '0 damage',
      )
    },
  )

  it.each([false, true])(
    'shows scaled status badges, effective AP and increased queued costs in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: async (path) => {
          const text = await readFile(
            new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url),
            'utf8',
          )

          if (path === 'combat/water.json' || path === 'combat/rough-water.json') {
            const encounter = JSON.parse(text)

            if (path === 'combat/water.json') encounter.mechanics.resources.exhaustion.initial = 55
            else encounter.mechanicsOverrides.resources.exhaustion = { initial: 55 }

            return JSON.stringify(encounter)
          }

          return text
        },
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('water')
      expect(target.textContent).toContain(
        'Enemy plans are previews. Conditional enemies choose again before each action.',
      )
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!
      slot('6').dispatchEvent(new Event('click'))
      slot('6').dispatchEvent(new Event('click'))
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(target.find((node) => node.dataset.combatActor === 'player')!.textContent).toContain(
        'AP 2/2',
      )
      expect(target.find((node) => node.dataset.statusEffect === 'rhythm')!.textContent).toContain(
        'Stacks: 1',
      )
      expect(
        target.find((node) => node.dataset.statusEffect === 'exhausted')!.textContent,
      ).toContain('AP budget -1')
      engine.lifecycle!.enterScene('rough-water')
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(
        target.find((node) => node.dataset.statusEffect === 'exhausted')!.textContent,
      ).toContain('Action AP cost +1')
      slot('3').dispatchEvent(new Event('click'))
      flush(engine)
      expect(target.find((node) => node.dataset.combatActor === 'swimmer')!.textContent).toContain(
        'AP 1/3',
      )
      expect(target.textContent).toContain('Float and recover · 2 AP')
      expect(slot('2').disabled).toBe(true)
      expect(slot('2').title).toContain('AP')
    },
  )

  it.each([false, true])(
    'renders combat meters and boss phase transitions in preview=%s',
    async (preview) => {
      const resources: IResourceSource = {
        readText: (path) =>
          readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url), 'utf8'),
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url)),
          ),
      }

      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('boss')
      const meter = (id: string) => target.find((node) => node.dataset.combatResource === id)!

      expect(meter('seal').textContent).toContain('Seal energy: 0/100')
      expect(
        meter('seal')
          .find((node) => node.tagName === 'METER')!
          .attributes.get('aria-label'),
      ).toBe('Seal energy')
      expect(target.textContent).toContain('First seal')

      for (let index = 0; index < 4; index++) {
        target.find((node) => node.dataset.actionBarSlot === '1')!.dispatchEvent(new Event('click'))
        target
          .find((node) => node.dataset.actionBarSlot === '15')!
          .dispatchEvent(new Event('click'))
        flush(engine)
      }

      expect(meter('seal').textContent).toContain('0/100')
      expect(meter('breaks').textContent).toContain('Seals broken: 1/3')
      expect(target.textContent).toContain('Second seal')
      engine.lifecycle!.enterScene('water')
      expect(meter('exhaustion').textContent).toContain('Diver · Exhaustion: 0/100')
      engine.lifecycle!.enterScene('boss')
      expect(meter('breaks').textContent).toContain('1/3')
    },
  )

  it('composites visible object layers above unchanged ground in the saved draw order', () => {
    const document = new TestDocument()
    const cell = new TestElement(document, 'DIV')

    const map = mapDefinitionSchema.parse({
      'schema-version': '1.0.0',
      type: 'square-grid',
      width: 1,
      height: 1,
      terrain: {
        grass: { color: '#336633' },
        tree: { color: '#114411' },
        roof: { color: '#aa3333' },
      },
      tiles: [['grass']],
      layers: [
        { id: 'trees', tiles: [['tree']] },
        { id: 'buildings', tiles: [['roof']] },
      ],
    })

    const paint = () =>
      applyMapCellAppearance(cell.asElement(), map, 0, 0, undefined, () => undefined)

    paint()
    expect(cell.style.backgroundColor).toBe('#336633')
    expect(cell.children.map((child) => child.dataset.mapLayer)).toEqual(['trees', 'buildings'])
    expect(cell.children[1]!.style.backgroundColor).toBe('#aa3333')
    map.layers!.reverse()
    paint()
    expect(cell.children.map((child) => child.dataset.mapLayer)).toEqual(['buildings', 'trees'])
    map.layers![1]!.visible = false
    paint()
    expect(cell.children.map((child) => child.dataset.mapLayer)).toEqual(['buildings'])
    map.layers![0]!.tiles[0]![0] = null
    paint()
    expect(cell.children).toHaveLength(0)
    expect(cell.style.backgroundColor).toBe('#336633')
  })

  it('saves from the browser controls, confirms replacement, and resumes through the menu after remounting', async () => {
    const storage = new Map<string, string>()

    const saveStore = {
      read: (id: string) => storage.get(id),
      write: (id: string, value: string) => {
        storage.set(id, value)
      },
    }

    const document = new TestDocument()
    const target = new TestElement(document, 'DIV')

    const create = () =>
      new Engine(
        loader,
        new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        { ...timing, saveStore },
      )

    const first = create()
    onTestFinished(() => first.stop())
    await first.start()

    const button = (label: string) => {
      const found = target.find((node) => node.tagName === 'BUTTON' && node.textContent === label)

      if (!found) throw new Error(`Missing button: ${label}`)

      return found
    }

    expect(button('Save progress').disabled).toBe(true)
    const menuLoad = target.find((node) => node.dataset.componentId === 'load-game')!
    expect(menuLoad.disabled).toBe(true)
    target
      .find((node) => node.dataset.componentId === 'new-game')!
      .dispatchEvent(new Event('click'))
    expect(button('Save progress').disabled).toBe(false)
    button('Save progress').dispatchEvent(new Event('click'))
    expect(target.find((node) => node.attributes.get('role') === 'status')!.textContent).toBe(
      'Progress saved on this device.',
    )
    first.actions!.request('walk-east')

    for (let count = 0; count < 20; count++) first.flushMessages()
    expect(first.lifecycle!.activeScene!.data.id).toBe('gallery')
    document.defaultView.confirm.mockReturnValueOnce(false)
    button('Load progress').dispatchEvent(new Event('click'))
    expect(first.lifecycle!.activeScene!.data.id).toBe('gallery')
    button('Load progress').dispatchEvent(new Event('click'))
    expect(first.lifecycle!.activeScene!.data.id).toBe('standard')
    const oldSave = button('Save progress')
    first.stop()
    const saved = storage.get('basic-game')
    oldSave.dispatchEvent(new Event('click'))
    expect(storage.get('basic-game')).toBe(saved)
    const second = create()
    onTestFinished(() => second.stop())
    await second.start()
    const load = target.find((node) => node.dataset.componentId === 'load-game')!
    expect(load.disabled).toBe(false)
    load.dispatchEvent(new Event('click'))
    expect(second.lifecycle!.activeScene!.data.id).toBe('standard')
    expect(target.find((node) => node.attributes.get('role') === 'status')!.textContent).toBe(
      'Saved progress loaded.',
    )
  })

  it.each(['preview', 'standalone'])(
    'updates status resources and keyboard-accessible effects in %s',
    async (host) => {
      const game = await loader.load()
      const { document, target } = setup(game)

      let state: StatusDemoState

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          ...timing,
          createGameLifecycle: (data) =>
            new GameLifecycle(data, {
              createGameState: () => {
                state = {
                  player: { health: 40, maximumHealth: 40, level: 1, gold: 12 },
                  letterRead: true,
                }

                return state
              },
              createSceneState: () => undefined,
            }),
          createGameRules: () => ({
            handlers: new Map<string, GameActionHandler>([
              [
                'overheal',
                () => {
                  state.player.health = 60

                  return { status: 'applied' }
                },
              ],
              [
                'maximum',
                () => {
                  state.player.maximumHealth = 100

                  return { status: 'applied' }
                },
              ],
              [
                'invalid',
                () => {
                  state.player.maximumHealth = 0

                  return { status: 'applied' }
                },
              ],
              [
                'missing',
                () => {
                  delete state.player.health
                  state.player.maximumHealth = 40

                  return { status: 'applied' }
                },
              ],
              [
                'markup',
                () => {
                  state.player.gold = '<b>{{gold}}</b>'

                  return { status: 'applied' }
                },
              ],
              [
                'hide',
                () => {
                  state.letterRead = false

                  return { status: 'applied' }
                },
              ],
            ]),
          }),
        },
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)
      const panel = () => target.find((node) => node.dataset.componentId === 'player-status')!
      const row = (id: string) => panel().find((node) => node.dataset.statusRow === id)!
      const fill = () => row('health').find((node) => node.className === 'ancadeba-status-fill')!

      const request = (id: string) => {
        engine.actions!.request(id)
        flush(engine)
      }

      expect(row('health').textContent).toBe('Health 40 / 40')
      expect(fill().style.getPropertyValue('--ge-status-fill')).toBe('100%')
      const meter = row('health').find((node) => node.attributes.get('role') === 'meter')!
      expect(meter.attributes.get('aria-valuemax')).toBe('40')
      request('overheal')
      expect(row('health').textContent).toBe('Health 60 / 40')
      expect(fill().style.getPropertyValue('--ge-status-fill')).toBe('100%')
      request('maximum')
      expect(fill().style.getPropertyValue('--ge-status-fill')).toBe('60%')
      expect(meter.attributes.get('aria-valuemax')).toBe('100')
      request('invalid')
      expect(meter.hidden).toBe(true)
      expect(panel().dataset.bindingStatus).toBe('unresolved')
      request('missing')
      expect(row('health').textContent).toBe('Health — / 40')

      if (host === 'preview') expect(panel().title).toContain('missing-path')
      else expect(panel().title).toBe('')
      request('markup')
      const gold = row('gold').find((node) => node.className === 'ancadeba-status-value')!
      expect(gold.textContent).toBe('<b>{{gold}}</b>')
      expect(gold.children).toEqual([])
      const effect = panel().find((node) => node.dataset.statusEffect === 'informed')!
      expect(effect.hidden).toBe(false)
      const button = effect.find((node) => node.tagName === 'BUTTON')!
      const tooltip = effect.find((node) => node.attributes.get('role') === 'tooltip')!
      expect(tooltip.hidden).toBe(true)
      button.focus()
      button.dispatchEvent(new Event('focus'))
      expect(tooltip.hidden).toBe(false)
      const escape = new Event('keydown', { cancelable: true })
      Object.defineProperty(escape, 'key', { value: 'Escape' })
      button.dispatchEvent(escape)
      expect(tooltip.hidden).toBe(true)
      expect(escape.defaultPrevented).toBe(true)
      button.dispatchEvent(new Event('mouseenter'))
      expect(tooltip.hidden).toBe(true)
      button.dispatchEvent(new Event('blur'))
      button.dispatchEvent(new Event('mouseleave'))
      button.dispatchEvent(new Event('mouseenter'))
      expect(tooltip.hidden).toBe(false)
      request('hide')
      expect(effect.hidden).toBe(true)
      expect(tooltip.hidden).toBe(true)
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      game.localization!.select('nl')
      expect(row('health').textContent).toBe('Gezondheid — / 40')
      const old = panel()
      engine.stop()
      await engine.start()
      startSampleGame(target)
      expect(row('health').textContent).toBe('Gezondheid 40 / 40')
      expect(panel()).not.toBe(old)
    },
  )

  it('opens the editor preview at the scene being edited instead of the start screen', async () => {
    const game = await new GameLoader(new JsonResourceLoader(source, logger), ['en']).load()
    const { target } = setup(game)

    const engine = new Engine(
      { load: async () => game },
      new EditorPreviewHost(target.asElement(), undefined, undefined, undefined, () => 'shop'),
      logger,
      () => new MessageBus<EngineMessages>(),
      timing,
    )

    onTestFinished(() => engine.stop())
    await engine.start()

    expect(target.find((node) => node.dataset.componentId === 'merchant-items')).toBeDefined()
    expect(target.find((node) => node.dataset.componentId === 'new-game')).toBeUndefined()
  })

  it.each([
    { host: 'preview', language: 'en' },
    { host: 'standalone', language: 'nl' },
  ])(
    'selects nearby targets and presents localized descriptions and commands in $host ($language)',
    async ({ host, language }) => {
      const game = await new GameLoader(new JsonResourceLoader(source, logger), [language]).load()
      const { document, target } = setup(game)

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)

      const catalog = languageCatalogSchema.parse(
        JSON.parse(await source.readText(`languages/${language}/messages.json`)),
      )

      const component = (id: string) => target.find((node) => node.dataset.componentId === id)!
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!
      const curator = target.find((node) => node.dataset.nearbyEntry === 'curator')!
      expect(slot('6').hidden).toBe(true)
      curator.focus()
      curator.dispatchEvent(new Event('click'))
      expect(curator.attributes.get('aria-pressed')).toBe('true')
      expect(component('narrative').textContent).toContain(catalog['nearby.curator.description'])
      expect(slot('6').hidden).toBe(false)
      expect(slot('8').hidden).toBe(true)
      expect(slot('1').hidden).toBe(false)
      engine.input!.pressKey('KeyA')
      engine.input!.releaseKey('KeyA')
      flush(engine)
      expect(component('narrative').textContent).toContain(catalog['nearby.curator.reply'])
      const letter = target.find((node) => node.dataset.nearbyEntry === 'folded-letter')!
      letter.focus()
      letter.dispatchEvent(new Event('click'))
      expect(curator.attributes.get('aria-pressed')).toBe('false')
      expect(slot('6').hidden).toBe(true)
      expect(slot('8').hidden).toBe(false)
      expect(component('narrative').textContent).toContain(catalog['nearby.letter.description'])
      engine.input!.pressKey('KeyD')
      engine.input!.releaseKey('KeyD')
      flush(engine)
      expect(letter.parent!.hidden).toBe(true)
      expect(slot('8').hidden).toBe(true)
      expect(component('narrative').textContent).not.toContain(catalog['nearby.letter.description'])
      const item = target.find((node) => node.dataset.itemId === 'folded-letter')!
      item.dispatchEvent(new Event('click'))
      curator.dispatchEvent(new Event('click'))
      expect(slot('4').hidden).toBe(false)
      expect(slot('6').hidden).toBe(false)

      const clear = component('nearby').find(
        (node) => node.tagName === 'BUTTON' && node.textContent === 'Clear nearby selection',
      )!

      clear.focus()
      clear.dispatchEvent(new Event('click'))
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      expect(slot('6').hidden).toBe(true)
      expect(slot('4').hidden).toBe(false)
      curator.dispatchEvent(new Event('click'))
      game.localization!.select(language === 'en' ? 'nl' : 'en')

      const translated = languageCatalogSchema.parse(
        JSON.parse(
          await source.readText(`languages/${language === 'en' ? 'nl' : 'en'}/messages.json`),
        ),
      )

      expect(component('narrative').textContent).toContain(translated['nearby.curator.description'])
      engine.lifecycle!.enterScene('old-harbour')
      expect(slot('7').hidden).toBe(true)
      const boat = target.find((node) => node.dataset.nearbyEntry === 'boat')!
      boat.dispatchEvent(new Event('click'))
      slot('7').dispatchEvent(new Event('click'))
      flush(engine)
      expect(component('narrative').textContent).toContain(translated['nearby.boat.result'])
    },
  )

  it.each([undefined, true, false])(
    'retains optional inline inspection when inline is %s',
    async (inline) => {
      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...source,
            readText: async (path) => {
              const text = await source.readText(path)

              if (path !== 'inventory/museum.json') return text
              const inventory = JSON.parse(text)
              inventory.itemTypes['folded-letter'].inspection.inline = inline

              return JSON.stringify(inventory)
            },
          },
          logger,
        ),
      ).load()

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
      engine.actions!.request('take-letter')
      flush(engine)
      const inspect = target.find((node) => node.dataset.inspectItem === 'folded-letter')
      expect(Boolean(inspect)).toBe(inline !== false)

      if (!inspect) return
      inspect.focus()
      inspect.dispatchEvent(new Event('click'))
      flush(engine)

      const catalog = languageCatalogSchema.parse(
        JSON.parse(await source.readText('languages/en/messages.json')),
      )

      expect(target.find((node) => node.dataset.componentId === 'items')!.textContent).toContain(
        catalog['museum.rules.clue'],
      )
      engine.input!.pressKey('KeyQ')
      engine.input!.releaseKey('KeyQ')
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('old-harbour')
    },
  )

  it.each([
    { host: 'standalone', firstKey: 'KeyQ', badge: 'Q / 1' },
    { host: 'preview', firstKey: 'KeyY', badge: 'Y / 1' },
  ])(
    'renders and activates game-defined action-bar keys in $host',
    async ({ host, firstKey, badge }) => {
      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...source,
            readText: async (path) => {
              const text = await source.readText(path)

              if (path !== 'input/controls.json') return text
              const input = JSON.parse(text)
              delete input.keyboard.KeyQ
              input.keyboard[firstKey] = 'slot-1'
              input.keyboard.Digit1 = 'slot-1'

              return JSON.stringify(input)
            },
          },
          logger,
        ),
      ).load()

      const { document, target } = setup(game)

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)
      const surface = target.find((node) => node.className === 'ancadeba-game')!
      const actionBar = () => target.find((node) => node.dataset.componentId === 'action-bar')!

      const button = (slot: string) =>
        actionBar().find((node) => node.dataset.actionBarSlot === slot)!

      expect(actionBar().children).toHaveLength(15)
      expect(button('1').children[1]!.textContent).toBe(badge)
      expect(button('2').disabled).toBe(false)
      expect(button('4').hidden).toBe(true)
      button('2').focus()
      button('2').dispatchEvent(new Event('click'))
      flush(engine)
      expect(button('2').disabled).toBe(true)
      expect(document.activeElement).toBe(surface)
      const item = target.find((node) => node.dataset.itemId === 'folded-letter')!
      item.focus()
      item.dispatchEvent(new Event('click'))
      expect(item.attributes.get('aria-pressed')).toBe('true')
      expect(button('4').hidden).toBe(false)
      expect(button('5').hidden).toBe(false)
      engine.input!.pressKey('KeyR')
      engine.input!.releaseKey('KeyR')
      flush(engine)
      expect(
        target.find((node) => node.dataset.componentId === 'narrative')!.textContent,
      ).toContain(
        languageCatalogSchema.parse(
          JSON.parse(await source.readText('languages/en/messages.json')),
        )['museum.rules.clue'],
      )
      target
        .find((node) => node.tagName === 'BUTTON' && node.textContent === 'Clear selection')!
        .dispatchEvent(new Event('click'))
      expect(button('4').hidden).toBe(true)
      expect(item.attributes.get('aria-pressed')).toBe('false')
      engine.input!.setContext('menu')
      expect(button('1').children[1]!.textContent).toBe('')
      engine.input!.setContext('gameplay')
      expect(button('1').children[1]!.textContent).toBe(badge)
      const oldButton = button('1')
      oldButton.focus()
      oldButton.dispatchEvent(new Event('click'))
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('old-harbour')
      expect(document.activeElement).toBe(surface)
      expect(button('1').children[1]!.textContent).toBe(badge)
      oldButton.dispatchEvent(new Event('click'))
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('old-harbour')
      engine.input!.pressKey(firstKey)
      engine.input!.releaseKey(firstKey)
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('standard')
      game.localization!.select('nl')
      const catalog = JSON.parse(await source.readText('languages/nl/messages.json'))
      expect(button('1').children[0]!.textContent).toBe(catalog['harbour.walk-to-harbour'])
      expect(button('1').children[1]!.textContent).toBe(badge)
      expect(target.find((node) => node.dataset.inspectItem === 'folded-letter')).toBeUndefined()
      const selectedItem = target.find((node) => node.dataset.itemId === 'folded-letter')!
      selectedItem.focus()
      selectedItem.dispatchEvent(new Event('click'))
      flush(engine)
      expect(document.activeElement).toBe(selectedItem)
      engine.input!.pressKey(firstKey)
      engine.input!.releaseKey(firstKey)
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('old-harbour')
      expect(document.activeElement).toBe(surface)
      engine.stop()
      expect(target.find((node) => node.className === 'ancadeba-game')).toBeUndefined()
    },
  )

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

      const component = (id: string) =>
        target.find((node) => node.dataset.componentId === id || node.dataset.slotAction === id)!

      const mapColumn = (id = 'museum-map') =>
        component(id)
          .find((node) => node.className === 'ancadeba-map-player')
          ?.style.getPropertyValue('--ge-map-player-column')

      const click = (id: string) => component(id).dispatchEvent(new Event('click'))

      const inspectItem = (item: string) => {
        const selected = component('items').find((node) => node.dataset.itemId === item)

        if (!selected) return
        selected.dispatchEvent(new Event('click'))

        return component('action-bar').find((node) => node.dataset.actionBarSlot === '4')
      }

      const inspectLetter = () => inspectItem('folded-letter')
      const inspectChart = () => inspectItem('harbour-chart')

      expect(component('nearby').textContent).toContain(catalog['nearby.letter.name'])
      expect(component('player-status').textContent).toContain('40 / 40')
      expect(component('items').textContent).toContain(catalog['usable.healing-potion.name'])
      expect(inspectLetter()).toBeUndefined()
      expect(component('clock').textContent).toContain('09:00')
      expect(mapColumn()).toBe('2')

      click('take-letter')
      click('take-letter')
      flush(engine)
      expect(component('take-letter').disabled).toBe(true)
      expect(
        component('nearby').find((node) => node.dataset.nearbyEntry === 'folded-letter')!.parent!
          .hidden,
      ).toBe(true)
      expect(component('items').textContent).toContain(
        language === 'nl' ? 'Gevouwen brief' : 'Folded letter',
      )
      expect(occurrences(component('event-log').textContent, 'pickup')).toBe(1)
      expect(engine.actions?.progression.worldTimeMs).toBe(0)

      click('walk-east')
      click('walk-east')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('gallery')
      expect(mapColumn()).toBe('6')
      expect(component('clock').textContent).toContain('09:01')
      expect(component('items').textContent).toContain(
        language === 'nl' ? 'Gevouwen brief' : 'Folded letter',
      )
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
      expect(component('items').textContent).not.toContain(message('clue'))
      expect(component('items').find((node) => Boolean(node.dataset.inspectItem))).toBeUndefined()
      expect(component('narrative').textContent).toContain(message('clue'))
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
      expect(component('items').textContent).toContain(
        language === 'nl' ? 'Havenkaart' : 'Harbour chart',
      )
      expect(component('items').textContent).not.toContain(message('chartDetails'))
      expect(occurrences(component('event-log').textContent, 'chartPickup')).toBe(1)

      expect(component('clock').textContent).toContain('09:01')

      click('walk-west')
      flush(engine)
      expect(engine.lifecycle?.activeScene?.data.id).toBe('standard')
      expect(mapColumn()).toBe('2')
      expect(component('clock').textContent).toContain('09:02')
      expect(component('take-letter').disabled).toBe(true)
      expect(component('items').textContent).not.toContain(message('clue'))
      expect(component('narrative').textContent).not.toContain(message('clue'))
      // Reinspection restores the result without repeating discovery effects.
      inspectLetter()!.dispatchEvent(new Event('click'))
      flush(engine)
      expect(component('narrative').textContent).toContain(message('clue'))
      expect(occurrences(component('event-log').textContent, 'read')).toBe(1)

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
      expect(component('items').textContent).not.toContain(message('chartDetails'))
      expect(component('narrative').textContent).toContain(message('chartDetails'))
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
      expect(component('items').textContent).not.toContain(message('chartDetails'))
      expect(component('narrative').textContent).not.toContain(message('chartDetails'))

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
      expect(component('items').textContent).toContain(catalog['usable.healing-potion.name'])
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

  it.each(['preview', 'standalone'])(
    'shares directional buttons, mapped input, and focused-map arrows in %s',
    async (host) => {
      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...squareMapSource,
            readText: async (path) => {
              const text = await readFile(
                new URL(`../sample-games/square-map/${path}`, import.meta.url),
                'utf8',
              )

              if (path !== 'scenes/coast.json') return text
              const scene = JSON.parse(text)
              scene.components.push({
                id: 'east-button',
                type: 'button',
                label: 'East',
                placement: { row: 2, column: 1 },
                action: { type: 'move-map', mapView: 'coast-map', direction: 'east' },
              })

              return JSON.stringify(scene)
            },
          },
          logger,
        ),
      ).load()

      const { target } = setup(game)
      const tasks: { callback: () => void; cancelled: boolean }[] = []

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          clock: { now: () => 0 },
          scheduler: {
            schedule(callback, delay) {
              if (!delay) return () => {}

              const task = { callback, cancelled: false }
              tasks.push(task)

              return () => {
                task.cancelled = true
              }
            },
          },
        },
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      const button = (slot: string) => target.find((node) => node.dataset.actionBarSlot === slot)!
      const player = () => target.find((node) => node.className === 'ancadeba-map-player')!
      const column = () => player().style.getPropertyValue('--ge-map-player-column')
      const east = target.find((node) => node.dataset.componentId === 'east-button')!
      expect(button('2').disabled).toBe(true)
      expect(button('8').disabled).toBe(false)
      expect(button('8').children[1]!.textContent).toBe('D / ArrowRight')
      east.dispatchEvent(new Event('click'))
      expect(button('8').disabled).toBe(true)
      expect(east.disabled).toBe(true)
      expect(column()).toBe('10')
      tasks[0]!.callback()
      expect(column()).toBe('11')
      expect(east.disabled).toBe(false)
      engine.input!.pressKey('KeyA')
      engine.input!.releaseKey('KeyA')
      flush(engine)
      tasks[1]!.callback()
      expect(column()).toBe('10')
      const view = target.find((node) => node.dataset.componentId === 'coast-map')!
      const key = new Event('keydown', { cancelable: true })
      Object.defineProperty(key, 'key', { value: 'ArrowRight' })
      view.dispatchEvent(key)
      expect(key.defaultPrevented).toBe(true)
      expect(tasks).toHaveLength(3)
      engine.lifecycle!.leaveScene()
      engine.lifecycle!.enterScene('coast')
      expect(tasks[2]!.cancelled).toBe(true)
      tasks[2]!.callback()
      expect(column()).toBe('10')
      engine.stop()
      east.dispatchEvent(new Event('click'))
      expect(tasks).toHaveLength(3)
    },
  )

  it.each(['preview', 'standalone'])(
    'disables blocked entrances, rechecks stale activations and follows live flags in the %s host',
    async (host) => {
      const entrance = {
        id: 'entrance',
        type: 'button',
        label: 'Entrance',
        placement: { row: 2, column: 1 },
        action: {
          type: 'enter-scene',
          scene: 'village',
          mapView: 'village-map',
          position: { x: 2, y: 3 },
        },
      }

      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...squareMapSource,
            readText: async (path) => {
              if (path === 'scenes/menu.json')
                return JSON.stringify({
                  'schema-version': '1.0.0',
                  id: 'menu',
                  title: 'Menu',
                  type: 'stand-alone',
                  screen: { type: 'grid', grid: { rows: 2, columns: 1 } },
                  components: [entrance],
                })
              const text = await squareMapSource.readText(path)

              if (path === 'rules/interactions.json') {
                const rules = gameRulesSchema.parse(JSON.parse(text))

                for (const open of [true, false])
                  rules.actions[open ? 'open-entrance' : 'close-entrance'] = [
                    {
                      when: [],
                      effects: [{ type: 'set-state', path: ['chestOpened'], value: open }],
                    },
                  ]

                return JSON.stringify(rules)
              }

              if (path === 'game.json') {
                const manifest = gameSchema.parse(JSON.parse(text))

                return JSON.stringify({
                  ...manifest,
                  scenes: [...manifest.scenes, 'menu'],
                  'initial-scene': 'menu',
                })
              }

              if (path === 'scenes/coast.json') {
                const scene = JSON.parse(text)
                scene.components.push(entrance)
                scene.components.find(
                  (component: { type: string }) => component.type === 'action-bar',
                ).slots['15'] = { label: 'Entrance', action: entrance.action }

                return JSON.stringify(scene)
              }

              return text
            },
          },
          logger,
        ),
      ).load()

      const { target } = setup(game)

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement(), undefined, undefined, undefined, () => 'menu')
          : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      const button = () => target.find((node) => node.dataset.componentId === 'entrance')!
      expect(button().disabled).toBe(true)
      expect(engine.lifecycle!.currentGame).toBeUndefined()
      engine.lifecycle!.startGame()
      const coast = engine.lifecycle!.enterScene('coast')
      const instance = engine.lifecycle!.currentGame!
      const state = instance.state

      if (!(state instanceof Map)) throw new Error('Expected authored state')

      const setOpen = (open: boolean) => {
        instance.actions!.request(open ? 'open-entrance' : 'close-entrance')
        flush(engine)
      }

      const slot = () => target.find((node) => node.dataset.actionBarSlot === '15')!
      expect(button().disabled).toBe(true)
      expect(slot().disabled).toBe(true)
      expect(slot().title).toContain('blocked')
      instance.actionBar!.activate(coast, 'movement-bar', '15')
      expect(engine.lifecycle!.activeScene).toBe(coast)
      setOpen(true)
      expect(button().disabled).toBe(false)
      expect(slot().disabled).toBe(false)
      // Simulate a collision change occurring before notification reaches either control.
      state.set('chestOpened', false)
      button().dispatchEvent(new Event('click'))
      instance.actionBar!.activate(coast, 'movement-bar', '15')
      expect(button().disabled).toBe(true)
      expect(engine.lifecycle!.activeScene).toBe(coast)
      setOpen(true)
      engine.lifecycle!.enterScene('menu')
      expect(button().disabled).toBe(false)
      setOpen(false)
      expect(button().disabled).toBe(true)
      setOpen(true)
      expect(button().disabled).toBe(false)
      button().dispatchEvent(new Event('click'))
      const village = engine.lifecycle!.activeScene!
      expect(village.data.id).toBe('village')
      expect(instance.mapMovement!.getPosition(village, 'village-map')).toEqual({ x: 2, y: 3 })
    },
  )

  it.each(['preview', 'standalone'])(
    'places scene-button entrances in the %s host',
    async (host) => {
      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...squareMapSource,
            readText: async (path) => {
              const text = await readFile(
                new URL(`../sample-games/square-map/${path}`, import.meta.url),
                'utf8',
              )

              if (path !== 'scenes/coast.json') return text
              const scene = JSON.parse(text)
              scene.components.push({
                id: 'entrance',
                type: 'button',
                label: 'Entrance',
                placement: { row: 2, column: 1 },
                action: {
                  type: 'enter-scene',
                  scene: 'coast',
                  mapView: 'coast-map',
                  position: { x: 12, y: 0 },
                },
              })

              return JSON.stringify(scene)
            },
          },
          logger,
        ),
      ).load()

      const { target } = setup(game)

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      target
        .find((element) => element.dataset.componentId === 'entrance')!
        .dispatchEvent(new Event('click'))
      const scene = engine.lifecycle!.activeScene!
      expect(engine.lifecycle!.currentGame!.mapMovement!.getPosition(scene, 'coast-map')).toEqual({
        x: 12,
        y: 0,
      })
      expect(target.find((element) => element.className === 'ancadeba-map-player')).toBeDefined()
    },
  )

  it.each(['preview', 'standalone'])(
    'renders adjacent map-object interactions in the %s host',
    async (host) => {
      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...squareMapSource,
            readText: async (path) => {
              if (path === 'rules/objects.json')
                return JSON.stringify({
                  state: [{ path: ['readSign'], value: false }],
                  actions: {
                    'read-sign': [
                      {
                        when: [],
                        effects: [{ type: 'set-state', path: ['readSign'], value: true }],
                      },
                    ],
                  },
                })

              const text = await readFile(
                new URL(`../sample-games/square-map/${path}`, import.meta.url),
                'utf8',
              )

              const value = JSON.parse(text)

              if (path === 'game.json') value.rules.push('objects')

              if (path === 'maps/coast.json')
                value.objects = [
                  ...(value.objects ?? []),
                  {
                    id: 'sign',
                    label: 'Signpost',
                    x: 10,
                    y: 4,
                    terrain: 'forest',
                    action: 'read-sign',
                  },
                ]

              if (path === 'scenes/coast.json')
                value.components.push({
                  id: 'read-sign',
                  type: 'button',
                  label: 'Read sign',
                  placement: { row: 2, column: 1 },
                  action: { type: 'interact-map', mapView: 'coast-map', object: 'sign' },
                })

              return JSON.stringify(value)
            },
          },
          logger,
        ),
      ).load()

      const { target } = setup(game)
      const tasks: (() => void)[] = []
      const messages = new MessageBus<EngineMessages>()
      const applied: string[] = []
      messages.subscribe('action.applied', ({ request }) => {
        applied.push(request.action)
      })

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => messages,
        {
          clock: timing.clock,
          scheduler: {
            schedule(callback, delay) {
              if (delay) tasks.push(callback)

              return () => {}
            },
          },
        },
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      const object = target.find((element) => element.dataset.mapObject === 'sign')!
      const button = target.find((element) => element.dataset.componentId === 'read-sign')!
      expect(object.attributes.get('aria-label')).toBe('Signpost')
      expect(object.style.getPropertyValue('grid-column')).toBe('11 / span 1')
      expect(object.style.getPropertyValue('grid-row')).toBe('5 / span 1')
      expect(object.disabled).toBe(false)
      expect(button.disabled).toBe(false)
      object.dispatchEvent(new Event('click'))
      flush(engine)
      button.dispatchEvent(new Event('click'))
      flush(engine)
      expect(applied).toEqual(['read-sign', 'read-sign'])
      expect(
        engine.lifecycle!.currentGame!.bindings!.read({ source: 'game.state', path: ['readSign'] }),
      ).toEqual({ status: 'resolved', value: true })
      const movement = engine.lifecycle!.currentGame!.mapMovement!
      movement.move(engine.lifecycle!.activeScene!, 'coast-map', 'west')
      expect(object.disabled).toBe(true)
      expect(button.disabled).toBe(true)
      object.dispatchEvent(new Event('click'))
      flush(engine)
      tasks.shift()!()
      flush(engine)
      expect(object.disabled).toBe(true)
      expect(applied).toHaveLength(2)
      engine.lifecycle!.enterScene('village')
      object.dispatchEvent(new Event('click'))
      button.dispatchEvent(new Event('click'))
      flush(engine)
      expect(applied).toHaveLength(2)
    },
  )

  it.each(['preview', 'standalone'])(
    'shows signpost and chest feedback from the real map sample in the %s host',
    async (host) => {
      const game = await new GameLoader(
        new JsonResourceLoader(
          {
            ...squareMapSource,
            readText: (path) =>
              readFile(new URL(`../sample-games/square-map/${path}`, import.meta.url), 'utf8'),
          },
          logger,
        ),
      ).load()

      const { target } = setup(game)
      const tasks: (() => void)[] = []

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          clock: timing.clock,
          scheduler: {
            schedule(callback, delay) {
              if (delay) tasks.push(callback)

              return () => {}
            },
          },
        },
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      const interact = () => target.find((element) => element.dataset.actionBarSlot === '12')!

      const feedback = () =>
        target.find((element) => element.dataset.componentId === 'interaction-result')!.textContent

      const press = (code: string) => {
        engine.input!.pressKey(code)
        engine.input!.releaseKey(code)
        flush(engine)
      }

      const walk = (code: string) => {
        press(code)
        tasks.shift()!()
        flush(engine)
      }

      expect(interact().disabled).toBe(false)
      expect(interact().children[1]!.textContent).toBe('E')
      expect(
        target.find((element) => element.dataset.mapObject === 'coast-signpost')!.disabled,
      ).toBe(false)
      press('KeyE')
      expect(feedback()).toContain('Signpost: Pine Village')
      expect(feedback()).toContain('Coins: 0')

      for (const code of ['KeyA', 'KeyW', 'KeyW']) walk(code)
      expect(interact().disabled).toBe(true)
      expect(
        target.find((element) => element.dataset.mapObject === 'village-chest')!.disabled,
      ).toBe(true)
      walk('KeyD')
      expect(interact().disabled).toBe(false)
      expect(
        target
          .find((element) => element.dataset.mapObject === 'village-chest')!
          .attributes.get('aria-label'),
      ).toBe('Chest')
      press('KeyE')
      expect(feedback()).toContain('find 25 coins')
      expect(
        target
          .find((element) => element.dataset.mapObject === 'village-chest')!
          .attributes.get('aria-label'),
      ).toBe('Open chest')
      expect(feedback()).toContain('Coins: 25')
      target
        .find((element) => element.dataset.mapObject === 'village-chest')!
        .dispatchEvent(new Event('click'))
      flush(engine)
      expect(feedback()).toContain('chest is empty')
      expect(feedback()).toContain('Coins: 25')
    },
  )

  it.each(['preview', 'standalone'])(
    'hides the collected berry basket, disables stale buttons and restores map focus in the %s host',
    async (host) => {
      const game = await new GameLoader(new JsonResourceLoader(squareMapSource, logger)).load()
      const { target, document } = setup(game)
      const applied: string[] = []
      const messages = new MessageBus<EngineMessages>()
      messages.subscribe('action.applied', ({ request }) => applied.push(request.action))

      const engine = new Engine(
        { load: async () => game },
        host === 'preview'
          ? new EditorPreviewHost(target.asElement())
          : new DomEngineHost(target.asElement()),
        logger,
        () => messages,
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      const lifecycle = engine.lifecycle!
      lifecycle.enterScene('village', { mapView: 'village-map', position: { x: 4, y: 4 } })
      const basket = target.find((element) => element.dataset.mapObject === 'village-berries')!
      const backpack = () => target.find((element) => element.dataset.componentId === 'backpack')!
      expect(backpack().textContent).not.toContain('Wild berry')
      const mapView = target.find((element) => element.dataset.componentId === 'village-map')!
      let hidden = basket.hidden
      // A real browser blurs a focused element when it becomes hidden.
      Object.defineProperty(basket, 'hidden', {
        get: () => hidden,
        set: (value: boolean) => {
          hidden = value

          if (value && document.activeElement === basket) document.activeElement = null
        },
      })
      expect(basket.hidden).toBe(false)
      expect(basket.disabled).toBe(false)
      basket.focus()
      engine.input!.pressKey('KeyE')
      engine.input!.releaseKey('KeyE')
      flush(engine)
      expect(basket.hidden).toBe(true)
      expect(basket.disabled).toBe(true)
      expect(backpack().textContent.match(/Wild berry/g)).toHaveLength(3)
      expect(document.activeElement).toBe(mapView)
      expect(target.find((element) => element.dataset.actionBarSlot === '12')!.disabled).toBe(true)
      basket.dispatchEvent(new Event('click'))
      flush(engine)
      expect(applied).toEqual(['collect-berries'])
      lifecycle.enterScene('coast')
      lifecycle.enterScene('village')
      expect(
        target.find((element) => element.dataset.mapObject === 'village-berries')!.hidden,
      ).toBe(true)
      expect(backpack().textContent.match(/Wild berry/g)).toHaveLength(3)
      lifecycle.startGame()
      lifecycle.enterScene('village')
      expect(
        target.find((element) => element.dataset.mapObject === 'village-berries')!.hidden,
      ).toBe(false)
      expect(backpack().textContent).not.toContain('Wild berry')
    },
  )

  it('repaints the chest sprite after looting, including a graphics lease that resolves after the state change', async () => {
    const game = await new GameLoader(new JsonResourceLoader(squareMapSource, logger)).load()
    const { target } = setup(game)
    const leases: ((value: { url: string; release: () => void }) => void)[] = []
    const releases = vi.fn()

    const engine = new Engine(
      { load: async () => game },
      {
        mount: (_game, session) =>
          mountGameView(target.asElement(), game, session, {
            graphics: { acquire: () => new Promise((resolve) => leases.push(resolve)) },
          }),
      },
      logger,
      () => new MessageBus<EngineMessages>(),
      timing,
    )

    onTestFinished(() => engine.stop())
    await engine.start()
    const lifecycle = engine.lifecycle!
    lifecycle.enterScene('village', { mapView: 'village-map', position: { x: 2, y: 4 } })
    const chest = target.find((element) => element.dataset.mapObject === 'village-chest')!
    expect(chest.attributes.get('aria-label')).toBe('Chest')
    leases[0]!({ url: 'blob:closed-sheet', release: releases })
    await Promise.resolve()
    expect(chest.style.backgroundPosition).toBe('0% 0%')
    engine.input!.pressKey('KeyE')
    engine.input!.releaseKey('KeyE')
    flush(engine)
    expect(chest.attributes.get('aria-label')).toBe('Open chest')
    expect(chest.style.backgroundPosition).toBe('100% 0%')
    expect(chest.textContent).toBe('')
    lifecycle.currentGame!.mapMovement!.place(lifecycle.activeScene!, 'village-map', { x: 4, y: 4 })
    engine.input!.pressKey('KeyE')
    engine.input!.releaseKey('KeyE')
    flush(engine)
    expect(target.find((element) => element.dataset.mapObject === 'village-berries')!.hidden).toBe(
      true,
    )
    lifecycle.enterScene('coast')
    lifecycle.enterScene('village')
    const revisited = target.find((element) => element.dataset.mapObject === 'village-chest')!
    expect(revisited.attributes.get('aria-label')).toBe('Open chest')
    leases.at(-1)!({ url: 'blob:late-sheet', release: releases })
    await Promise.resolve()
    expect(revisited.style.backgroundImage).toContain('blob:late-sheet')
    expect(revisited.style.backgroundPosition).toBe('100% 0%')
    expect(target.find((element) => element.dataset.mapObject === 'village-berries')!.hidden).toBe(
      true,
    )
    expect(chest.style.backgroundImage).toContain('blob:closed-sheet')
    engine.stop()
    expect(releases).toHaveBeenCalledTimes(2)
  })

  it('follows the Coast Road player at terrain speed and stops at forests and map edges', async ({
    onTestFinished,
  }) => {
    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          ...squareMapSource,
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
    expect(narrative.style.getPropertyValue('--ge-component-row-span')).toBe('6')
    expect(narrative.textContent).toContain('\n\n')
    const firstNode = standard
    lifecycle.enterScene('inventory')
    expect(firstNode.parent).toBeUndefined()
    expect(target.children).toHaveLength(1)
    expect(target.children[0]?.dataset.sceneId).toBe('inventory')
    const inventory = target.find((element) => element.dataset.componentId === 'items')!
    expect(inventory.className.split(' ')).toContain('ancadeba-scene-item')
    expect(
      inventory.find((element) => element.className === 'ancadeba-inventory-items')?.textContent,
    ).toContain('Healing potion')

    playthrough.inventory?.move('folded-letter', { type: 'carried', owner: 'player' })
    playthrough.inventory?.move('harbour-chart', { type: 'carried', owner: 'player' })
    const itemList = inventory.find((element) => element.className === 'ancadeba-inventory-items')!
    expect(itemList.tagName).toBe('UL')
    expect(itemList.children.map((item) => item.textContent)).toEqual([
      'Folded letter',
      'Healing potion',
      'Antidote',
      'Flame scroll',
      'Healing rune',
      'Healing potion',
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
    const content = await textBindingLoader.load()
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
    const content = await textBindingLoader.load()
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
    const { target } = setup(await textBindingLoader.load())

    const engine = new Engine(
      textBindingLoader,
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
    const content = await textBindingLoader.load()
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
    const content = await textBindingLoader.load()
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
    const { rules: _rules, ...game } = await textBindingLoader.load()
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
    const { target } = setup(await textBindingLoader.load())

    const engine = new Engine(
      textBindingLoader,
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
  it.each([false, true])(
    'uses dialogue replies and quest journals in preview=%s',
    async (preview) => {
      const document = new TestDocument(),
        target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(source, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)

      const lifecycle = engine.lifecycle!,
        game = lifecycle.currentGame!

      const scene = lifecycle.activeScene!
      game.nearby!.select(scene, 'nearby', 'curator')
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!

      const mainText = () =>
        target.find((node) => node.dataset.componentId === 'narrative')!.textContent

      slot('11').dispatchEvent(new Event('click'))
      flush(engine)
      expect(mainText()).toContain('Could you survey the old harbour')
      expect(mainText()).toContain('curator')
      expect(slot('12').textContent).toContain('I will survey the harbour.')
      slot('12').focus()
      engine.input!.pressKey('KeyX')
      engine.input!.releaseKey('KeyX')
      flush(engine)
      expect(game.quests!.snapshot('harbour-survey')?.status).toBe('active')
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      const journal = target.find((node) => node.dataset.quest === 'harbour-survey')!
      journal.dispatchEvent(new Event('click'))
      expect(mainText()).toContain('Visit the old harbour')
      lifecycle.enterScene('old-harbour')
      flush(engine)
      lifecycle.enterScene('standard')
      flush(engine)
      expect(game.quests!.snapshot('harbour-survey')?.status).toBe('ready')
      game.nearby!.select(lifecycle.activeScene!, 'nearby', 'curator')
      slot('11').dispatchEvent(new Event('click'))
      flush(engine)
      expect(slot('12').hidden).toBe(true)
      expect(slot('13').textContent).toContain('I have returned')
      slot('13').dispatchEvent(new Event('click'))
      flush(engine)
      expect(game.quests!.snapshot('harbour-survey')?.status).toBe('completed')
      expect(mainText()).toContain('Here is your payment')
      game.data.localization!.select('nl')
      expect(mainText()).toContain('Hier zijn je betaling')
      expect(
        game.bindings!.read({ source: 'game.state', path: ['player', 'experience'] }),
      ).toMatchObject({ value: 5 })
      engine.stop()
      expect(target.children).toHaveLength(0)
    },
  )

  it.each([false, true])(
    'uses localized consumables through focused native buttons and keys in preview=%s',
    async (preview) => {
      const resources = {
        ...source,
        readText: async (path: string) => {
          const text = await source.readText(path)

          if (path !== 'rules/rules.json') return text
          const definition = JSON.parse(text)

          for (const field of definition.state)
            if (JSON.stringify(field.path) === JSON.stringify(['player', 'health']))
              field.value = 25

          return JSON.stringify(definition)
        },
      }

      const document = new TestDocument(),
        target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)
      engine.lifecycle!.enterScene('inventory')

      const game = engine.lifecycle!.currentGame!,
        scene = engine.lifecycle!.activeScene!

      game.inventorySelection!.select(scene, 'items', 'healing-potion-one')
      const slot = () => target.find((node) => node.dataset.actionBarSlot === '6')!
      expect(slot().disabled).toBe(false)
      slot().focus()
      engine.input!.pressKey('KeyA')
      engine.input!.releaseKey('KeyA')
      flush(engine)
      expect(game.combatStats!.snapshot('player')!.health).toBe(37)
      expect(game.inventorySelection!.get(scene, 'items')).toBeUndefined()
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      const details = () => target.find((node) => node.dataset.componentId === 'details')!
      expect(details().textContent).toContain('Used Healing potion: restored 12 health.')
      game.data.localization!.select('nl')
      expect(details().textContent).toContain('Genezingsdrank gebruikt: 12 gezondheid hersteld.')
      game.inventorySelection!.select(scene, 'items', 'healing-potion-two')
      slot().dispatchEvent(new Event('click'))
      flush(engine)
      expect(game.combatStats!.snapshot('player')!.health).toBe(40)
      expect(details().textContent).toContain('3 gezondheid hersteld.')
      engine.stop()
      await engine.start()
      startSampleGame(target)
      expect(
        engine.lifecycle!.currentGame!.inventory!.snapshot.some(
          (item) => item.id === 'healing-potion-one',
        ),
      ).toBe(true)
    },
  )
  it.each([false, true])(
    'renders ability statuses, cooldowns and expiry focus recovery in preview=%s',
    async (preview) => {
      const resources = {
        ...source,
        readText: async (path: string) => {
          const text = await source.readText(path)

          if (path === 'combat-libraries/common.json') {
            const library = JSON.parse(text)
            library.statuses.poison.duration = 2

            return JSON.stringify(library)
          }

          if (path === 'combat/advanced-training.json') {
            const combat = JSON.parse(text)

            for (const enemy of combat.enemies) enemy.rotation = ['guard']

            return JSON.stringify(combat)
          }

          if (path === 'languages/en/messages.json') {
            const catalog = JSON.parse(text)
            catalog['abilities.status.poison.name'] = '<Poison>'

            return JSON.stringify(catalog)
          }

          return text
        },
      }

      const document = new TestDocument(),
        target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)
      engine.lifecycle!.enterScene('advanced-training')

      const game = engine.lifecycle!.currentGame!,
        scene = engine.lifecycle!.activeScene!

      game.combat!.selectTarget(scene, 'combat', 'advanced-sentinel')
      const slot = (id: string) => target.find((node) => node.dataset.actionBarSlot === id)!
      slot('2').dispatchEvent(new Event('click'))
      flush(engine)
      expect(slot('2').disabled).toBe(true)
      expect(slot('2').title).toContain('Already queued')
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(slot('2').title).toContain('Cooldown: 1')
      expect(slot('2').children[1]!.textContent).toBe('W')
      const effect = target.find((node) => node.dataset.statusEffect === 'poison')!
      expect(effect.textContent).toContain('<Poison>')
      expect(effect.textContent).toContain('3 damage')
      const button = effect.find((node) => node.tagName === 'BUTTON')!
      button.focus()
      button.dispatchEvent(new Event('focus'))
      expect(effect.find((node) => node.attributes.get('role') === 'tooltip')!.hidden).toBe(false)
      engine.input!.pressKey('KeyB')
      engine.input!.releaseKey('KeyB')
      flush(engine)
      expect(target.find((node) => node.dataset.statusEffect === 'poison')).toBeUndefined()
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      expect(slot('2').disabled).toBe(false)
      engine.game!.localization!.select('nl')
      expect(slot('2').textContent).toContain('Gifslag')
      slot('2').dispatchEvent(new Event('click'))
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(target.find((node) => node.dataset.statusEffect === 'poison')!.textContent).toContain(
        'Vergif',
      )
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('advanced-training')
      expect(target.find((node) => node.dataset.statusEffect === 'poison')).toBeUndefined()
    },
  )
  it.each([false, true])(
    'renders localized victory rewards and selectable loot in preview=%s',
    async (preview) => {
      const resources = {
        ...source,
        readText: async (path: string) => {
          const text = await source.readText(path)

          if (path === 'combat-libraries/common.json') {
            const combat = JSON.parse(text)
            combat.moves.attack.damage = { min: 30, max: 30 }

            return JSON.stringify(combat)
          }

          if (path === 'languages/en/messages.json') {
            const catalog = JSON.parse(text)
            catalog['rewards.token'] = '<b>Training token</b>'

            return JSON.stringify(catalog)
          }

          return text
        },
      }

      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resources, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)
      engine.lifecycle!.enterScene('training')
      const scene = engine.lifecycle!.activeScene!
      const game = engine.lifecycle!.currentGame!
      const component = (id: string) => target.find((node) => node.dataset.componentId === id)!

      const slot = (id: string) =>
        component('commands').find((node) => node.dataset.actionBarSlot === id)!

      expect(slot('12').disabled).toBe(true)
      expect(slot('12').textContent).toContain('Requires level 2')

      for (const id of ['sentinel', 'keeper']) {
        game.combat!.selectTarget(scene, 'combat', id)
        engine.input!.pressKey('KeyQ')
        engine.input!.releaseKey('KeyQ')
        flush(engine)
      }

      engine.input!.pressKey('KeyB')
      engine.input!.releaseKey('KeyB')
      flush(engine)
      expect(component('narrative').textContent).toContain('Victory rewards received.')
      expect(component('narrative').textContent).toContain('Gold: +8')
      expect(game.leveling!.snapshot('player')).toMatchObject({ level: 2, xp: 5 })
      expect(component('progression').textContent).toContain('Level 2')
      expect(component('progression').textContent).toContain('Maximum health: +6')
      expect(component('narrative').textContent).toContain('Unlocked: Power strike')
      expect(
        game.bindings!.read({ source: 'game.state', path: ['player', 'maximumHealth'] }),
      ).toMatchObject({ value: 46 })
      expect(game.bindings!.read({ source: 'game.state', path: ['player', 'gold'] })).toMatchObject(
        { value: 20 },
      )
      expect(slot('9').disabled).toBe(true)
      const prize = game.combatRewards!.snapshot(scene, 'combat')!.items[0]!
      const lootItem = () => component('loot').find((node) => node.dataset.itemId === prize)!
      expect(lootItem().textContent).toContain('<b>Training token</b>')
      lootItem().dispatchEvent(new Event('click'))
      expect(component('loot-details').textContent).toContain('A token awarded')
      expect(component('narrative').textContent).toContain('A token awarded')
      engine.game!.localization!.select('nl')
      expect(component('narrative').textContent).toContain('Overwinningsbeloningen ontvangen.')
      expect(component('loot-details').textContent).toContain('Trainingsmunt')
      expect(component('progression').textContent).toContain('Niveau 2')
      expect(component('progression').textContent).toContain('Vrijgespeeld: Krachtslag')
      expect(slot('9').disabled).toBe(false)
      lootItem().focus()
      engine.input!.pressKey('KeyF')
      engine.input!.releaseKey('KeyF')
      flush(engine)
      expect(game.inventorySelection!.get(scene, 'loot')).toBeUndefined()
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))

      if (!slot('10').disabled) {
        slot('10').dispatchEvent(new Event('click'))
        flush(engine)
      }

      expect(game.combatRewards!.snapshot(scene, 'combat')!.remaining).toEqual([])
      expect(game.actions!.progression.turn).toBe(1)
      expect(component('loot').textContent).not.toContain('Trainingsmunt')
      engine.lifecycle!.enterScene('advanced-training')
      expect(slot('12').textContent).not.toContain('Vereist')
      const advanced = engine.lifecycle!.activeScene!
      game.combat!.selectTarget(advanced, 'combat', 'advanced-sentinel')
      expect(slot('12').disabled).toBe(false)
      engine.input!.pressKey('KeyX')
      engine.input!.releaseKey('KeyX')
      flush(engine)
      expect(game.combat!.snapshot(advanced, 'combat')!.plan[0]!.move).toBe('power-strike')
      engine.lifecycle!.enterScene('training')
      slot('14').dispatchEvent(new Event('click'))
      flush(engine)
      engine.lifecycle!.enterScene('training')
      expect(
        game.combatRewards!.snapshot(engine.lifecycle!.activeScene!, 'combat')!.remaining,
      ).toEqual([])
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('training')
      expect(
        engine.lifecycle!.currentGame!.combatRewards!.snapshot(
          engine.lifecycle!.activeScene!,
          'combat',
        ),
      ).toBeUndefined()
      expect(engine.lifecycle!.currentGame!.leveling!.snapshot('player')).toMatchObject({
        level: 1,
        xp: 0,
      })
      expect(slot('10').disabled).toBe(true)
    },
  )
  it.each([false, true])(
    'plans and resolves localized combat with focus recovery in preview=%s',
    async (preview) => {
      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        loader,
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)
      engine.lifecycle!.enterScene('training')
      const game = engine.lifecycle!.currentGame!
      const component = (id: string) => target.find((node) => node.dataset.componentId === id)!

      const slot = (id: string) =>
        component('commands').find((node) => node.dataset.actionBarSlot === id)!

      const enemy = () =>
        component('combat').find((node) => node.dataset.combatTarget === 'sentinel')!

      expect(slot('1').disabled).toBe(true)
      expect(component('combat').textContent).toContain('3–6')
      expect(component('combat').textContent).toContain('Practice keeper')
      enemy().dispatchEvent(new Event('click'))
      expect(slot('1').disabled).toBe(false)
      slot('1').focus()

      for (const code of ['KeyQ', 'KeyW', 'KeyB']) {
        engine.input!.pressKey(code)
        engine.input!.releaseKey(code)
      }

      flush(engine)
      const scene = engine.lifecycle!.activeScene!
      expect(game.combat!.snapshot(scene, 'combat')).toMatchObject({ round: 2, remainingAp: 3 })
      expect(game.actions!.progression).toEqual({ turn: 1, worldTimeMs: 60000 })
      expect(game.bindings!.read({ source: 'game.state', path: ['clock'] })).toMatchObject({
        value: '09:01',
      })
      expect(component('narrative').textContent).toContain('Wayfarer attacks Practice sentinel')
      const saved = game.combat!.snapshot(scene, 'combat')!
      engine.game!.localization!.select('nl')
      expect(component('combat').textContent).toContain('Ronde 2')
      expect(component('narrative').textContent).toContain('Reiziger valt Oefenwachter aan')
      expect(game.combat!.snapshot(scene, 'combat')!.health).toEqual(saved.health)
      const oldButton = enemy()
      slot('8').dispatchEvent(new Event('click'))
      oldButton.focus()
      slot('15').dispatchEvent(new Event('click'))
      flush(engine)
      expect(component('combat').textContent).toContain('Gevlucht')
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      slot('14').focus()
      slot('14').dispatchEvent(new Event('click'))
      flush(engine)
      expect(engine.lifecycle!.activeScene!.data.id).toBe('standard')
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      engine.lifecycle!.enterScene('training')
      expect(component('combat').textContent).toContain('Gevlucht')
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('training')
      expect(game.disposed).toBe(true)
      expect(component('combat').textContent).toContain('Ronde 1')
      oldButton.dispatchEvent(new Event('click'))
      expect(
        engine.lifecycle!.currentGame!.combat!.snapshot(engine.lifecycle!.activeScene!, 'combat')!
          .target,
      ).toBeUndefined()
      engine.stop()
      expect(target.children).toHaveLength(0)
    },
  )
  it.each([false, true])(
    'trades with synchronized quotes, details and localized feedback in preview=%s',
    async (preview) => {
      const document = new TestDocument()
      const target = document.createElement('main')

      const engine = new Engine(
        loader,
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      startSampleGame(target)
      engine.lifecycle!.enterScene('shop')
      const component = (id: string) => target.find((node) => node.dataset.componentId === id)!

      const item = (panel: string, id: string) =>
        component(panel).find((node) => node.dataset.itemId === id)!

      const slot = (id: string) =>
        component('commands').find((node) => node.dataset.actionBarSlot === id)!

      expect(component('shop').textContent).toContain('12 Gold')
      expect(component('merchant-items').textContent).toContain('5 Gold')
      expect(slot('1').disabled).toBe(true)
      const stock = item('merchant-items', 'postcard-one')
      stock.focus()
      stock.dispatchEvent(new Event('click'))
      expect(component('narrative').textContent).toContain('A small postcard')
      expect(slot('1').disabled).toBe(false)
      engine.input!.pressKey('KeyQ')
      engine.input!.releaseKey('KeyQ')
      flush(engine)
      expect(component('shop').textContent).toContain('7 Gold')
      expect(component('narrative').textContent).toContain('Bought Museum postcard for 5 Gold.')
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      expect(slot('1').disabled).toBe(true)
      item('player-items', 'postcard-one').dispatchEvent(new Event('click'))
      expect(slot('2').disabled).toBe(false)
      engine.game!.localization!.select('nl')
      expect(component('shop').textContent).toContain('7 Goud')
      expect(component('narrative').textContent).toContain('Museumkaart gekocht voor 5 Goud.')
      slot('2').dispatchEvent(new Event('click'))
      expect(component('shop').textContent).toContain('10 Goud')
      expect(component('narrative').textContent).toContain('Museumkaart verkocht voor 3 Goud.')
      expect(item('merchant-items', 'postcard-one')).toBeDefined()
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('shop')
      expect(component('shop').textContent).toContain('12 Goud')
      engine.stop()
      expect(target.children).toHaveLength(0)
    },
  )
  it.each([false, true])(
    'synchronizes details, equipment, paper dolls, and keyboard commands in preview=%s',
    async (preview) => {
      const document = new TestDocument()
      const target = document.createElement('main')

      const resource: IResourceSource = {
        readText: async (path) => {
          const text = await readFile(
            new URL(`../sample-games/graphics/${path}`, import.meta.url),
            'utf8',
          )

          if (path === 'inventory/wardrobe.json') {
            const inventory = JSON.parse(text)
            inventory.itemTypes.cloak.description = '<em>Warm cloak</em>'
            inventory.itemTypes.cloak.properties.push({
              id: 'missing',
              label: 'Missing',
              value: { source: 'game.state', path: ['missing'] },
            })

            return JSON.stringify(inventory)
          }

          if (path !== 'game.json') return text

          return JSON.stringify({ ...JSON.parse(text), 'initial-scene': 'wardrobe' })
        },
        readBytes: async (path) =>
          new Uint8Array(
            await readFile(new URL(`../sample-games/graphics/${path}`, import.meta.url)),
          ),
      }

      const engine = new Engine(
        new GameLoader(new JsonResourceLoader(resource, logger)),
        preview ? new EditorPreviewHost(target.asElement()) : new DomEngineHost(target.asElement()),
        logger,
        () => new MessageBus<EngineMessages>(),
        timing,
      )

      onTestFinished(() => engine.stop())
      await engine.start()
      const component = (id: string) => target.find((node) => node.dataset.componentId === id)!
      const details = () => component('item-details')
      const equipment = () => component('equipment')

      const item = (id: string) =>
        component('wardrobe-items').find((node) => node.dataset.itemId === id)!

      const slot = (id: string) =>
        component('commands').find((node) => node.dataset.actionBarSlot === id)!

      expect(details().textContent).toContain('Select an item')
      item('moss-cloak').focus()
      item('moss-cloak').dispatchEvent(new Event('click'))
      expect(details().textContent).toContain('Traveling cloak')
      expect(details().textContent).toContain('Value45')
      expect(details().textContent).toContain('<em>Warm cloak</em>')
      expect(details().dataset.bindingStatus).toBe('unresolved')
      expect(details().textContent).toContain('Inside Backpack (Wayfarer)')
      expect(details().textContent).toContain('40 → 48 (+8)')
      expect(slot('1').disabled).toBe(false)
      expect(
        equipment()
          .find((node) => node.dataset.equipmentSlot === 'outerwear')!
          .attributes.get('aria-pressed'),
      ).toBe('true')
      engine.input!.pressKey('KeyQ')
      engine.input!.releaseKey('KeyQ')
      flush(engine)
      expect(equipment().find((node) => node.dataset.equipmentItem === 'moss-cloak')).toBeDefined()
      expect(details().textContent).toContain('Wayfarer / Outerwear')
      expect(engine.lifecycle!.currentGame!.combatStats!.snapshot('wayfarer')!.total).toMatchObject(
        { attack: 2, defense: 1, guard: 2, maximumHealth: 48 },
      )
      expect(slot('2').disabled).toBe(false)
      item('amber-cloak').dispatchEvent(new Event('click'))
      expect(details().textContent).toContain('48 → 52 (+4)')
      slot('1').dispatchEvent(new Event('click'))
      expect(
        engine.lifecycle!.currentGame!.inventory!.snapshot.find((item) => item.id === 'moss-cloak')!
          .placement.type,
      ).toBe('carried')
      const worn = equipment().find((node) => node.dataset.equipmentItem === 'amber-cloak')!
      worn.focus()
      worn.dispatchEvent(new Event('click'))
      expect(worn.attributes.get('aria-pressed')).toBe('true')
      engine.input!.pressKey('KeyW')
      engine.input!.releaseKey('KeyW')
      flush(engine)
      expect(
        equipment().find((node) => node.dataset.equipmentItem === 'amber-cloak'),
      ).toBeUndefined()
      expect(document.activeElement).toBe(target.find((node) => node.className === 'ancadeba-game'))
      engine.lifecycle!.startGame()
      engine.lifecycle!.enterScene('wardrobe')
      expect(details().textContent).toContain('Select an item')
      engine.stop()
      expect(target.children).toHaveLength(0)
    },
  )
  it('switches the three scenes and empty selection through the lifecycle, and removes its listener', async () => {
    const game = await textBindingLoader.load()
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
    const game = await textBindingLoader.load()
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
