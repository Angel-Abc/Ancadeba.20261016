import { describe, expect, it, vi } from 'vite-plus/test'
import {
  Engine,
  InputController,
  type EngineMessages,
  type GameData,
  type IEngineHost,
  type IGameInput,
  type InputData,
} from '@ancadeba/game-runtime'
import { MessageBus, type ILogger } from '@ancadeba/utilities'

function inputData(): InputData {
  return {
    virtualKeys: ['north', 'alternate', 'confirm'],
    keyboard: { KeyW: 'north', ArrowUp: 'north', KeyK: 'alternate', Enter: 'confirm' },
    contexts: {
      gameplay: { north: 'moveNorth', alternate: 'moveNorth' },
      menu: { north: 'selectPrevious', confirm: 'accept' },
    },
    initialContext: 'gameplay',
  }
}

function controller() {
  const messages = new MessageBus<EngineMessages>()
  const handler = vi.fn<(message: EngineMessages['input.virtual']) => void>()
  messages.subscribe('input.virtual', handler)
  return { input: new InputController(inputData(), messages), messages, handler }
}

describe('game input controller', () => {
  it('aggregates physical keys and virtual keys into one press and final release', () => {
    const { input, messages, handler } = controller()
    expect(input.pressKey('KeyW')).toBe(true)
    input.pressKey('KeyW')
    input.pressKey('ArrowUp')
    input.pressKey('KeyK')
    input.releaseKey('KeyW')
    input.releaseKey('ArrowUp')
    expect(handler).not.toHaveBeenCalled()
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed'])
    input.releaseKey('KeyK')
    input.releaseKey('KeyK')
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { context: 'gameplay', input: 'moveNorth', phase: 'pressed' },
      { context: 'gameplay', input: 'moveNorth', phase: 'released' },
    ])
  })

  it('captures original context and suppresses held keys across context changes', () => {
    const { input, messages, handler } = controller()
    input.pressKey('KeyW')
    input.pressKey('ArrowUp')
    input.setContext('menu')
    input.pressKey('KeyW')
    input.releaseKey('KeyW')
    input.releaseKey('ArrowUp')
    input.pressKey('KeyW')
    input.releaseKey('KeyW')
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { context: 'gameplay', input: 'moveNorth', phase: 'pressed' },
      { context: 'gameplay', input: 'moveNorth', phase: 'cancelled' },
      { context: 'menu', input: 'selectPrevious', phase: 'pressed' },
      { context: 'menu', input: 'selectPrevious', phase: 'released' },
    ])
  })

  it('tracks a bound key even when its current context has no mapping', () => {
    const { input, messages, handler } = controller()
    expect(input.pressKey('Enter')).toBe(false)
    input.setContext('menu')
    expect(input.pressKey('Enter')).toBe(false)
    input.releaseKey('Enter')
    expect(input.pressKey('Enter')).toBe(true)
    messages.flush()
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      context: 'menu',
      input: 'accept',
      phase: 'pressed',
    })
  })

  it('keeps the current context on invalid or redundant switches', () => {
    const { input, messages, handler } = controller()
    input.pressKey('KeyW')
    input.setContext('gameplay')
    expect(() => input.setContext('missing')).toThrow('Unknown input context')
    expect(input.context).toBe('gameplay')
    input.releaseKey('KeyW')
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual(['pressed', 'released'])
  })

  it('ignores unknown keys and uses own mappings for prototype-like names', () => {
    const { input, messages, handler } = controller()
    expect(input.pressKey('toString')).toBe(false)
    expect(input.releaseKey('toString')).toBe(false)
    expect(input.isKeyMapped('KeyK')).toBe(true)
    expect(input.isKeyMapped('Enter')).toBe(false)
    messages.flush()
    expect(handler).not.toHaveBeenCalled()
  })

  it('resets with cancellation and accepts a fresh press afterward', () => {
    const { input, messages, handler } = controller()
    input.pressKey('KeyW')
    input.reset()
    input.reset()
    input.releaseKey('KeyW')
    input.pressKey('KeyW')
    messages.flush()
    expect(handler.mock.calls.map(([event]) => event.phase)).toEqual([
      'pressed',
      'cancelled',
      'pressed',
    ])
  })

  it('disposes silently and makes retained references inert', () => {
    const { input, messages, handler } = controller()
    input.pressKey('KeyW')
    messages.flush()
    handler.mockClear()
    input.dispose()
    input.dispose()
    input.reset()
    input.setContext('missing')
    expect(input.pressKey('KeyW')).toBe(false)
    expect(input.releaseKey('KeyW')).toBe(false)
    expect(input.isKeyMapped('KeyW')).toBe(false)
    messages.flush()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('engine session input', () => {
  const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
  const game: GameData = {
    id: 'demo',
    title: 'Demo',
    description: '',
    version: '1',
    scenes: new Map(),
    input: inputData(),
  }

  it('exposes input only while running and creates isolated state and buses on restart', async () => {
    const mount = vi.fn<IEngineHost['mount']>(() => () => {})
    const engine = new Engine(
      { load: async () => game },
      { mount },
      logger,
      () => new MessageBus<EngineMessages>(),
    )
    expect(engine.input).toBeUndefined()
    const starting = engine.start()
    expect(engine.input).toBeUndefined()
    await starting
    const input = engine.input!
    const oldBus = engine.messages!
    const handler = vi.fn()
    oldBus.subscribe('input.virtual', handler)
    expect(mount).toHaveBeenCalledExactlyOnceWith(game, { input })
    input.pressKey('KeyW')
    engine.flushMessages()
    expect(handler).toHaveBeenCalledTimes(1)
    engine.stop()
    expect(engine.input).toBeUndefined()
    input.releaseKey('KeyW')
    oldBus.flush()
    expect(handler).toHaveBeenCalledTimes(1)
    await engine.start()
    expect(engine.input).not.toBe(input)
    expect(engine.messages).not.toBe(oldBus)
    const next = vi.fn()
    engine.messages!.subscribe('input.virtual', next)
    input.pressKey('KeyW')
    engine.input!.pressKey('KeyW')
    engine.flushMessages()
    expect(next).toHaveBeenCalledExactlyOnceWith({
      context: 'gameplay',
      input: 'moveNorth',
      phase: 'pressed',
    })
    engine.stop()
  })

  it('disposes input if mounting throws or stops the session', async () => {
    for (const stopDuringMount of [false, true]) {
      let captured: IGameInput | undefined
      const engine = new Engine(
        { load: async () => game },
        {
          mount: (_game, session) => {
            captured = session.input
            if (stopDuringMount) {
              engine.stop()
              return () => {}
            }
            throw new Error('Mount failed')
          },
        },
        logger,
        () => new MessageBus<EngineMessages>(),
      )
      if (stopDuringMount) await engine.start()
      else await expect(engine.start()).rejects.toThrow('Mount failed')
      expect(engine.input).toBeUndefined()
      expect(captured!.pressKey('KeyW')).toBe(false)
    }
  })
})
