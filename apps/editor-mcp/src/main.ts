import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { parseAdapterConfig, usage } from './config.js'
import { EditorApiClient } from './editorApiClient.js'
import { createMcpServer } from './mcpServer.js'

try {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.error(usage)
  } else {
    const config = parseAdapterConfig(process.argv.slice(2))
    const shutdown = new AbortController()
    const api = new EditorApiClient(config, fetch, shutdown.signal)
    const handle = serveStdio(() => createMcpServer(api, config.game), {
      onerror: (error) => console.error('MCP transport error:', error.message),
    })
    const close = () => {
      shutdown.abort()
      void handle.close().catch(() => {
        process.exitCode = 1
      })
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
    process.stdin.once('end', () => shutdown.abort())
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not start MCP adapter')
  console.error(usage)
  process.exitCode = 1
}
