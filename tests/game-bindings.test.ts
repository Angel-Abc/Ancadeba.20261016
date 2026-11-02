import { describe, expect, it, vi } from 'vite-plus/test'
import { gameBindingSchema, gameSchema, sceneSchema, textComponentSchema } from '@ancadeba/schemas'
import {
  assembleGameData,
  GameBindings,
  observeText,
  resolveText,
  type EngineMessages,
  type GameBinding,
  type TextTemplate,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'

const health: GameBinding = { source: 'game.state', path: ['player', 'health'], fallback: '—' }
const turn: GameBinding = { source: 'game.progression', path: ['turn'] }
const template: TextTemplate = {
  text: 'Health: {{health}} / {{ health }} — Turn {{turn}}',
  bindings: { health, turn },
}
const component = { id: 'story', type: 'text', placement: { row: 1, column: 1 }, ...template }
const scene = {
  'schema-version': '1.0.0',
  id: 'standard',
  title: 'Standard',
  description: '',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
  components: [component],
}

function setup(state: unknown = { player: { health: 10 } }) {
  const messages = new MessageBus<EngineMessages>()
  const progression = { turn: 0, worldTimeMs: 0 }
  const source = new GameBindings({ state: () => state, progression: () => progression }, messages)
  const invalidate = () => {
    messages.publish('world-time.advanced', { previous: progression, progression })
    messages.flush()
  }
  return { source, messages, progression, invalidate }
}

describe('binding definitions', () => {
  it('validates named placeholders and keeps static braces literal without bindings', () => {
    expect(textComponentSchema.parse(component).bindings?.health?.path).toEqual([
      'player',
      'health',
    ])
    const { bindings: _bindings, ...staticComponent } = component
    expect(textComponentSchema.parse(staticComponent).text).toBe(template.text)
    expect(textComponentSchema.safeParse({ ...component, bindings: {} }).success).toBe(false)
    expect(textComponentSchema.safeParse({ ...component, text: '{{player.health}}' }).success).toBe(
      false,
    )
    expect(sceneSchema.safeParse({ ...scene, type: 'stand-alone' }).success).toBe(false)
  })

  it.each([
    { ...health, source: 'engine.state' },
    { ...health, path: [] },
    { ...health, path: [''] },
    { ...health, path: [-1] },
    { ...health, path: [0.5] },
    { ...health, path: [Number.MAX_SAFE_INTEGER + 1] },
    { ...health, fallback: false },
  ])('rejects invalid binding configuration %#', (binding) => {
    expect(gameBindingSchema.safeParse(binding).success).toBe(false)
  })

  it('copies the binding dictionary, definitions, and paths into runtime data', () => {
    const definition = sceneSchema.parse(scene)
    const content = assembleGameData(
      gameSchema.parse({
        'schema-version': '1.0.0',
        id: 'demo',
        title: 'Demo',
        description: '',
        version: '1',
        scenes: ['standard'],
      }),
      new Map([['standard', definition]]),
    )
    const bindings = definition.components[0]!.bindings!
    bindings.health!.path[0] = 'other'
    bindings.health!.fallback = 'changed'
    delete bindings.turn
    expect(content.scenes.get('standard')!.components[0]!.bindings).toEqual({ health, turn })
  })
})

describe('game binding reads', () => {
  it('traverses own object properties, numeric array indices, and string Map keys', () => {
    const { source } = setup({ items: [new Map([['potion', { count: 2 }]])] })
    expect(source.read({ source: 'game.state', path: ['items', 0, 'potion', 'count'] })).toEqual({
      status: 'resolved',
      value: 2,
    })
    expect(source.read(turn)).toEqual({ status: 'resolved', value: 0 })
  })

  it.each([0, false, '', 'text', 1.5])('preserves primitive value %s', (value) => {
    expect(setup({ value }).source.read({ source: 'game.state', path: ['value'] })).toEqual({
      status: 'resolved',
      value,
    })
  })

  it.each(
    [null, undefined, {}, [], new Map(), () => 1, NaN, Infinity, 1n, Symbol('x')].map((value) => ({
      value,
    })),
  )('reports unsupported leaf value %#', ({ value }) => {
    expect(setup({ value }).source.read({ source: 'game.state', path: ['value'] })).toMatchObject({
      status: 'unresolved',
      diagnostic: { reason: 'unsupported-value' },
    })
  })

  it('never invokes getters or reads inherited properties', () => {
    const getter = vi.fn(() => 99)
    const state = Object.create({ inherited: 8 }) as Record<string, unknown>
    Object.defineProperty(state, 'secret', { get: getter })
    const { source } = setup(state)
    expect(source.read({ source: 'game.state', path: ['secret'] })).toMatchObject({
      diagnostic: { reason: 'unreadable-path' },
    })
    for (const key of ['inherited', '__proto__', 'constructor', 'missing'])
      expect(source.read({ source: 'game.state', path: [key] })).toMatchObject({
        diagnostic: { reason: 'missing-path' },
      })
    expect(getter).not.toHaveBeenCalled()
  })

  it('reports invalid traversal, sparse indices, and unavailable state', () => {
    const items = [1]
    items[2] = 3
    const { source } = setup({ items, map: new Map([['x', 1]]), value: 2 })
    for (const path of [
      ['items', 1],
      ['items', '0'],
      ['map', 'missing'],
      ['value', 'x'],
    ])
      expect(source.read({ source: 'game.state', path })).toMatchObject({
        diagnostic: { reason: 'missing-path' },
      })
    const unavailable = new GameBindings(
      { state: () => undefined, progression: () => ({ turn: 0, worldTimeMs: 0 }) },
      new MessageBus<EngineMessages>(),
    )
    expect(unavailable.read(health)).toMatchObject({ diagnostic: { reason: 'source-unavailable' } })
  })
})

describe('plain text binding resolution', () => {
  it('resolves unavailable sources consistently before a game runtime is attached', () => {
    const result = resolveText(template, undefined)
    expect(result.text).toBe('Health: — / — — Turn ')
    expect(result.diagnostics.map(({ alias, reason }) => ({ alias, reason }))).toEqual([
      { alias: 'health', reason: 'source-unavailable' },
      { alias: 'turn', reason: 'source-unavailable' },
    ])
    expect(resolveText(template, undefined, { mode: 'editor' }).text).toBe(
      'Health: [unresolved: health] / [unresolved: health] — Turn [unresolved: turn]',
    )
  })

  it('resolves repeated aliases once and leaves static text untouched', () => {
    const { source } = setup()
    const read = vi.spyOn(source, 'read')
    expect(resolveText(template, source)).toEqual({
      text: 'Health: 10 / 10 — Turn 0',
      diagnostics: [],
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(resolveText({ text: '{{literal}}' }, source).text).toBe('{{literal}}')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('uses standalone fallbacks and editor markers with the same structured diagnostics', () => {
    const { source } = setup({})
    const standalone = resolveText(template, source)
    expect(standalone.text).toBe('Health: — / — — Turn 0')
    expect(standalone.diagnostics).toEqual([
      { alias: 'health', source: 'game.state', path: ['player', 'health'], reason: 'missing-path' },
    ])
    const editor = resolveText(template, source, { mode: 'editor' })
    expect(editor.text).toBe('Health: [unresolved: health] / [unresolved: health] — Turn 0')
    expect(editor.diagnostics).toEqual(standalone.diagnostics)
    expect(
      resolveText({ text: '{{x}}', bindings: { x: { ...health, fallback: undefined } } }, source)
        .text,
    ).toBe('')
  })

  it('does not interpret markup or recursively substitute values or fallback text', () => {
    const { source } = setup({ player: { health: '<b>{{turn}}</b>' } })
    expect(resolveText(template, source).text).toBe(
      'Health: <b>{{turn}}</b> / <b>{{turn}}</b> — Turn 0',
    )
    expect(
      resolveText(
        {
          text: '{{health}}',
          bindings: { health: { ...health, path: ['absent'], fallback: '{{turn}}' } },
        },
        source,
      ).text,
    ).toBe('{{turn}}')
    expect(
      resolveText({ text: '{{undeclared}}', bindings: {} }, source, { mode: 'editor' }),
    ).toEqual({
      text: '[unresolved: undeclared]',
      diagnostics: [{ alias: 'undeclared', reason: 'undeclared-binding' }],
    })
  })

  it('emits immediately and only on changed text or diagnostics, with independent subscriptions', () => {
    const state: { player?: { health: unknown } } = { player: { health: 10 } }
    const { source, invalidate } = setup(state)
    const listener = vi.fn()
    const unsubscribe = observeText(template, source, listener)
    expect(listener).toHaveBeenCalledTimes(1)
    invalidate()
    expect(listener).toHaveBeenCalledTimes(1)
    state.player!.health = 9
    invalidate()
    expect(listener).toHaveBeenLastCalledWith({ text: 'Health: 9 / 9 — Turn 0', diagnostics: [] })
    state.player!.health = '—'
    invalidate()
    delete state.player
    invalidate()
    expect(listener).toHaveBeenCalledTimes(4) // Same text as before, different diagnostics.
    const second = vi.fn()
    const release = source.subscribeChanges(second)
    unsubscribe()
    unsubscribe()
    invalidate()
    expect(listener).toHaveBeenCalledTimes(4)
    expect(second).toHaveBeenCalledOnce()
    release()
  })

  it('cleans up an observer whose initial callback throws', () => {
    const { source, invalidate } = setup()
    const listener = vi.fn(() => {
      throw new Error('initial')
    })
    expect(() => observeText(template, source, listener)).toThrow('initial')
    expect(invalidate).not.toThrow()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('attempts other observers after a callback fails and stops delivery on disposal', () => {
    const { source, invalidate } = setup()
    const failing = () => {
      throw new Error('observer')
    }
    const unsubscribe = source.subscribeChanges(failing)
    const other = vi.fn()
    source.subscribeChanges(other)
    expect(invalidate).toThrow(AggregateError)
    expect(other).toHaveBeenCalledOnce()
    unsubscribe()
    source.subscribeChanges(() => source.dispose())
    const afterDisposal = vi.fn()
    source.subscribeChanges(afterDisposal)
    invalidate()
    expect(afterDisposal).not.toHaveBeenCalled()
    source.dispose()
    expect(source.read(health)).toMatchObject({ diagnostic: { reason: 'source-unavailable' } })
    expect(() => source.subscribeChanges(other)).toThrow('disposed')
    expect(invalidate).not.toThrow()
  })
})
