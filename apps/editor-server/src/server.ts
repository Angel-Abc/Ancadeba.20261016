import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import {
  parseEditorExportRequest,
  type EditorExportRequest,
  parseEditorServerConfig,
  type EditorServerConfig,
  type HealthResponse,
} from '@ancadeba/schemas'
import { WorkspaceError, workspaceError, type WorkspaceService } from './workspace.js'
import type { GameExportService } from './gameExports.js'

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
  exports?: GameExportService,
): Server {
  parseEditorServerConfig(config)
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) {
        response.destroy()
        return
      }
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
    if (request.method === 'POST' && url.pathname === '/api/exports') {
      if (!exports) throw new WorkspaceError(503, 'Game exports are not available')
      if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        throw new WorkspaceError(415, 'Export requests must use application/json')
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'))
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        throw new WorkspaceError(400, 'Invalid export request')
      }
      let parsed: EditorExportRequest
      try {
        parsed = parseEditorExportRequest(body)
      } catch {
        throw new WorkspaceError(400, 'Export requires a workspace-relative game folder')
      }
      const archive = await exports.create(parsed.path)
      try {
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${archive.fileName}"`,
          'Content-Length': archive.size,
          'Cache-Control': 'no-store',
        })
        await pipeline(createReadStream(archive.filePath), response)
      } finally {
        await archive.dispose()
      }
      return
    }
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
