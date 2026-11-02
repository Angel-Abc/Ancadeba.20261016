import { describe, expect, it } from 'vite-plus/test'
import { parseAdapterConfig } from '../apps/editor-mcp/src/config.js'

describe('MCP adapter configuration', () => {
  it('requires explicit server and game binding, including an explicit empty root', () => {
    expect(
      parseAdapterConfig(['--editor-server-url', 'http://127.0.0.1:3100/', '--game', 'basic']),
    ).toEqual({ editorServerUrl: 'http://127.0.0.1:3100', game: 'basic', timeoutMs: 10000 })
    expect(
      parseAdapterConfig([
        '--editor-server-url',
        'http://[::1]:3100',
        '--game',
        '',
        '--timeout-ms',
        '200',
      ]),
    ).toMatchObject({ game: '', timeoutMs: 200 })
    expect(() => parseAdapterConfig([])).toThrow('required')
    expect(() => parseAdapterConfig(['--editor-server-url', 'http://localhost:3100'])).toThrow(
      'required',
    )
  })
  it.each([
    'https://localhost:3100',
    'http://example.com',
    'http://user:secret@localhost:3100',
    'http://localhost:3100/other',
    'http://localhost:3100/?path=other',
    'http://localhost:3100/#other',
  ])('rejects an unsupported server origin %s', (url) => {
    expect(() => parseAdapterConfig(['--editor-server-url', url, '--game', 'basic'])).toThrow(
      'loopback',
    )
  })
  it.each([
    '../other',
    '/basic',
    'C:/Games',
    'basic\\other',
    'basic//other',
    'basic/..',
    'basic/.',
    'basic/',
    'NUL',
    'COM1',
    'basic.',
    'basic ',
    'bad\u0000folder',
  ])('rejects an unsafe game folder %s', (game) => {
    expect(() =>
      parseAdapterConfig(['--editor-server-url', 'http://localhost:3100', '--game', game]),
    ).toThrow('workspace-relative')
  })
  it.each(['0', '-1', '1.5', '60001', 'NaN'])('rejects an invalid timeout %s', (timeout) => {
    expect(() =>
      parseAdapterConfig([
        '--editor-server-url',
        'http://localhost:3100',
        '--game',
        'basic',
        '--timeout-ms=' + timeout,
      ]),
    ).toThrow('Timeout')
  })
  it('rejects unknown flags and accepts nested folders containing spaces', () => {
    expect(() => parseAdapterConfig(['--unexpected'])).toThrow()
    expect(
      parseAdapterConfig([
        '--editor-server-url',
        'http://localhost:3100',
        '--game',
        'My Games/basic',
      ]).game,
    ).toBe('My Games/basic')
  })
})
