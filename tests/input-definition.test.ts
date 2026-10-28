import { describe, expect, it, vi } from 'vite-plus/test'
import { gameSchema, inputSchema } from '@ancadeba/schemas'
import {
  assembleGameData,
  Engine,
  GameLoader,
  type EngineMessages,
  type IEngineHost,
} from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus, type ILogger } from '@ancadeba/utilities'

const definition = {
  'schema-version': '1.0.0',
  'virtual-keys': ['north', 'confirm'],
  keyboard: { KeyW: 'north', ArrowUp: 'north', Enter: 'confirm' },
  contexts: {
    gameplay: { north: 'moveNorth' },
    menu: { north: 'selectPrevious', confirm: 'accept' },
  },
  'initial-context': 'gameplay',
}
const game = {
  'schema-version': '1.0.0',
  id: 'demo',
  title: 'Demo',
  description: '',
  version: '1',
  scenes: [],
  input: 'input.json',
}
const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
const runtime = { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } }

describe('input definitions', () => {
  it('accepts game-specific controls and contexts', () => {
    expect(inputSchema.parse(definition)).toEqual(definition)
  })

  it.each([
    { ...definition, 'schema-version': '2.0.0' },
    { ...definition, 'virtual-keys': [] },
    { ...definition, 'virtual-keys': ['north', 'north'] },
    { ...definition, 'virtual-keys': ['invalid key'] },
    { ...definition, keyboard: { KeyW: 'missing' } },
    { ...definition, contexts: {} },
    { ...definition, contexts: { gameplay: {} } },
    { ...definition, contexts: { gameplay: { missing: 'move' } } },
    { ...definition, contexts: { gameplay: { north: '' } } },
    { ...definition, 'initial-context': 'missing' },
    { ...definition, 'initial-context': 'toString' },
  ])('rejects invalid input configuration %#', (invalid) => {
    expect(inputSchema.safeParse(invalid).success).toBe(false)
  })

  it.each([
    '../input.json',
    'nested/input.json',
    'input\\file.json',
    '/input.json',
    'input.txt',
    '.json',
    'https://example.com/input.json',
  ])('rejects unsafe input reference %s', (input) => {
    expect(gameSchema.safeParse({ ...game, input }).success).toBe(false)
  })

  it('loads through the resource pipeline and copies configuration without schema versions', async () => {
    const readText = vi.fn(async (path: string) =>
      JSON.stringify(path === 'game.json' ? game : definition),
    )
    const loader = new GameLoader(
      new JsonResourceLoader({ readText, readBytes: async () => new Uint8Array() }, logger),
    )
    const data = await loader.load()
    expect(readText.mock.calls).toEqual([['game.json'], ['input.json']])
    expect(data.input).toEqual({
      virtualKeys: ['north', 'confirm'],
      keyboard: definition.keyboard,
      contexts: definition.contexts,
      initialContext: 'gameplay',
    })
    const source = inputSchema.parse(definition)
    const assembled = assembleGameData(gameSchema.parse(game), new Map(), source)
    source.keyboard.KeyW = 'confirm'
    source.contexts.gameplay!.north = 'changed'
    source['virtual-keys'].push('extra')
    expect(assembled.input?.keyboard.KeyW).toBe('north')
    expect(assembled.input?.contexts.gameplay?.north).toBe('moveNorth')
    expect(assembled.input?.virtualKeys).toEqual(['north', 'confirm'])
    expect(assembled.input).not.toHaveProperty('schema-version')
  })

  it('supports games without input and rejects inconsistent assembly inputs', async () => {
    const { input: _input, ...legacy } = game
    const readText = vi.fn(async () => JSON.stringify(legacy))
    const data = await new GameLoader(
      new JsonResourceLoader({ readText, readBytes: async () => new Uint8Array() }, logger),
    ).load()
    expect(data).not.toHaveProperty('input')
    expect(readText).toHaveBeenCalledExactlyOnceWith('game.json')
    expect(() => assembleGameData(gameSchema.parse(game), new Map())).toThrow('Input definition')
    expect(() =>
      assembleGameData(gameSchema.parse(legacy), new Map(), inputSchema.parse(definition)),
    ).toThrow('Input definition')
  })

  it.each(['missing', 'malformed', 'invalid'])('rejects %s input before mounting', async (kind) => {
    const readText = async (path: string) => {
      if (path === 'game.json') return JSON.stringify(game)
      if (kind === 'missing') throw new Error('Missing input.json')
      return kind === 'malformed' ? '{broken' : JSON.stringify({ ...definition, contexts: {} })
    }
    const mount = vi.fn<IEngineHost['mount']>(() => () => {})
    const engine = new Engine(
      new GameLoader(
        new JsonResourceLoader({ readText, readBytes: async () => new Uint8Array() }, logger),
      ),
      { mount },
      logger,
      () => new MessageBus<EngineMessages>(),
      runtime,
    )
    await expect(engine.start()).rejects.toThrow()
    expect(engine.input).toBeUndefined()
    expect(mount).not.toHaveBeenCalled()
  })
})
