import { format } from 'node:util'
import { ConsoleLogger, type IConsole, loggerFactories, Container } from '@ancadeba/utilities'
import { describe, expect, it, vi } from 'vite-plus/test'

function createConsole() {
  return {
    debug: vi.fn<IConsole['debug']>((message) => message),
    info: vi.fn<IConsole['info']>((message) => message),
    warn: vi.fn<IConsole['warn']>((message) => message),
    error: vi.fn<IConsole['error']>((message) => message),
    log: vi.fn<IConsole['log']>((message) => message),
  } satisfies IConsole
}

describe('ConsoleLogger', () => {
  it.each([
    ['debug', '\x1B[37m'],
    ['info', '\x1B[30m'],
    ['warn', '\x1B[1m\x1B[33m'],
    ['error', '\x1B[1m\x1B[31m'],
  ] as const)('routes %s messages to the injected console', (level, color) => {
    const console = createConsole()
    const logger = new ConsoleLogger(console)
    const details = { id: 1 }

    expect(logger[level]('Loader', 'Object {0}', details)).toBe('[Loader] Object %o')
    expect(console[level]).toHaveBeenCalledExactlyOnceWith(
      `${color}[Loader] Object %o\x1B[0m`,
      details,
    )
    for (const otherLevel of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      if (otherLevel !== level) expect(console[otherLevel]).not.toHaveBeenCalled()
    }
  })

  it('forwards an error without requiring a placeholder', () => {
    const console = createConsole()
    const error = new Error('Missing scene')

    new ConsoleLogger(console).error('Loader', 'Failed to load', error)

    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '\x1B[1m\x1B[31m[Loader] Failed to load\x1B[0m',
      error,
    )
  })

  it('escapes category specifiers when forwarding diagnostic arguments', () => {
    const console = createConsole()
    const logger = new ConsoleLogger(console)

    logger.info('100% %s', 'Loaded {0}', 'scene', 'details')

    expect(console.info).toHaveBeenCalledExactlyOnceWith(
      '\x1B[30m[100%% %%s] Loaded scene\x1B[0m',
      'details',
    )
    const call = console.info.mock.calls[0]!
    expect(format(...call)).toBe('\x1B[30m[100% %s] Loaded scene\x1B[0m details')
  })

  it('omits the category prefix when the category is empty', () => {
    const console = createConsole()

    expect(new ConsoleLogger(console).info('', 'Ready')).toBe('Ready')
    expect(console.info).toHaveBeenCalledExactlyOnceWith('\x1B[30mReady\x1B[0m')
  })

  it('resolves the logger factory using the injected console', () => {
    const console = createConsole()
    const container = new Container({
      console: () => console,
      ...loggerFactories,
    })

    container.resolve('logger').info('Engine', 'Ready')

    expect(console.info).toHaveBeenCalledExactlyOnceWith('\x1B[30m[Engine] Ready\x1B[0m')
  })
})
