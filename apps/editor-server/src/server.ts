import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  parseEditorServerConfig,
  type EditorServerConfig,
  type HealthResponse,
} from '@ancadeba/schemas'
import { WorkspaceError, workspaceError, type WorkspaceService } from './workspace.js'

export const maxWriteBytes = 10 * 1024 * 1024

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (Number(request.headers['content-length']) > maxWriteBytes) {
      request.resume()
      reject(new WorkspaceError(413, 'File exceeds the 10 MiB write limit'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > maxWriteBytes) {
        chunks.length = 0
        request.off('data', onData)
        reject(new WorkspaceError(413, 'File exceeds the 10 MiB write limit'))
        request.resume()
        return
      }
      chunks.push(chunk)
    }
    request.on('data', onData)
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
  })
}

export function createEditorServer(
  config: EditorServerConfig,
  workspace: WorkspaceService,
): Server {
  parseEditorServerConfig(config)
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const failure = workspaceError(error)
      json(response, failure.status, { error: failure.message })
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'GET' && request.url === '/health') {
      const health: HealthResponse = { status: 'ok' }
      json(response, 200, health)
      return
    }
    const path = url.searchParams.get('path') ?? ''
    if (request.method === 'GET' && url.pathname === '/api/workspace') {
      json(response, 200, await workspace.list(path))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/files') {
      const contents = await workspace.read(path)
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(contents)
      return
    }
    if (request.method === 'PUT' && url.pathname === '/api/files') {
      const contents = await readBody(request)
      const created = await workspace.write(path, contents)
      response.writeHead(created ? 201 : 204)
      response.end()
      return
    }
    json(response, 404, { error: 'Not found' })
  }
}
