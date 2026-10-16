import { createServer, type Server } from 'node:http'
import type { HealthResponse } from '@ancadeba/schemas'

export function createEditorServer(): Server {
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')

    if (request.method === 'GET' && request.url === '/health') {
      const health: HealthResponse = { status: 'ok' }
      response.writeHead(200)
      response.end(JSON.stringify(health))
      return
    }

    response.writeHead(404)
    response.end(JSON.stringify({ error: 'Not found' }))
  })
}
