import { parseArgs } from 'node:util'

export interface AdapterConfig {
  editorServerUrl: string
  game: string
  timeoutMs: number
}

export const usage =
  'Usage: node apps/editor-mcp/dist/main.js --editor-server-url http://127.0.0.1:3100 --game basic [--timeout-ms 10000]\nUse --game "" for the workspace root. Start the editor server separately.'

export function parseAdapterConfig(args: string[]): AdapterConfig {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      'editor-server-url': { type: 'string' },
      game: { type: 'string' },
      'timeout-ms': { type: 'string', default: '10000' },
    },
  })
  if (values['editor-server-url'] === undefined || values.game === undefined) {
    throw new Error('Both --editor-server-url and --game are required')
  }
  const url = new URL(values['editor-server-url'])
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Editor server URL must be a loopback HTTP origin without credentials, path, query, or fragment',
    )
  }
  const game = values.game
  if (
    game !== '' &&
    game
      .split('/')
      .some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          /[<>:"\\|?*]/.test(segment) ||
          segment.split('').some((character) => character.charCodeAt(0) < 32) ||
          /[. ]$/.test(segment) ||
          /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
            segment,
          ),
      )
  ) {
    throw new Error(
      'Game must be a workspace-relative folder using / separators, or empty for the root',
    )
  }
  const timeoutMs = Number(values['timeout-ms'])
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('Timeout must be an integer between 1 and 60000 milliseconds')
  }
  return { editorServerUrl: url.origin, game, timeoutMs }
}
