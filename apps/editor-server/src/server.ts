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
import { capabilities, EditorError, maxProjectArchiveBytes } from '@ancadeba/editor-core'
import { EditorCoordinator } from './editorCoordinator.js'
import type { EditorProjectService } from './editorProjectService.js'
import type { GameExportService } from './gameExports.js'
import { listWorkspaceProjects } from './workspaceProjects.js'

export const maxWriteBytes = 10 * 1024 * 1024

const managementPath = (path: string) =>
  path.split('/').some((part) => part.toLowerCase().startsWith('.ancadeba-'))

function protectManagementPath(body: unknown) {
  if (
    body &&
    typeof body === 'object' &&
    'path' in body &&
    typeof body.path === 'string' &&
    managementPath(body.path)
  )
    throw new WorkspaceError(403, 'Project management metadata is private')
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

const writeLimit = { bytes: maxWriteBytes, message: 'File exceeds the 10 MiB write limit' }

const projectArchiveLimit = {
  bytes: maxProjectArchiveBytes,
  message: 'Project ZIP exceeds the 128 MiB upload limit',
}

function readBody(request: IncomingMessage, limit = writeLimit): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (Number(request.headers['content-length']) > limit.bytes) {
      request.resume()
      reject(new WorkspaceError(413, limit.message))

      return
    }

    const chunks: Buffer[] = []
    let size = 0

    const onData = (chunk: Buffer) => {
      size += chunk.length

      if (size > limit.bytes) {
        chunks.length = 0
        request.off('data', onData)
        reject(new WorkspaceError(413, limit.message))
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
  projects?: EditorProjectService,
): Server {
  parseEditorServerConfig(config)
  const coordinator = projects?.coordinator ?? new EditorCoordinator()

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) {
        response.destroy()

        return
      }

      if (error instanceof EditorError) {
        json(response, error.status, {
          error: error.message,
          code: error.code,
          diagnostics: error.diagnostics,
          outcome: error.outcome,
        })

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

    if (managementPath(path))
      throw new WorkspaceError(403, 'Project management metadata is private')

    if (url.pathname.startsWith('/api/editor/')) {
      response.setHeader('Cache-Control', 'no-store')

      if (request.method === 'GET' && url.pathname === '/api/editor/capabilities') {
        json(response, 200, {
          ...capabilities,
          features: {
            ...(projects?.features ?? {
              history: false,
              assetImport: false,
              projectCreation: false,
              projectDuplication: false,
              projectImport: false,
              projectExport: false,
              projectRenaming: false,
              projectDeletion: false,
              projectRestoration: false,
            }),
            projectDiscovery: true,
            gameExport: exports !== undefined,
          },
        })

        return
      }

      if (request.method === 'GET' && url.pathname === '/api/editor/projects') {
        json(response, 200, { projects: await listWorkspaceProjects(workspace) })

        return
      }

      if (!projects) throw new WorkspaceError(503, 'Project editing is not available')

      if (request.method === 'POST' && url.pathname === '/api/editor/projects/import') {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/zip')
          throw new WorkspaceError(415, 'Project imports require application/zip')
        const archive = await readBody(request, projectArchiveLimit)
        json(
          response,
          201,
          await projects.importProject(
            { destination: url.searchParams.get('destination') ?? '' },
            archive,
          ),
        )

        return
      }

      if (request.method === 'POST' && url.pathname === '/api/editor/projects/export') {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
          throw new WorkspaceError(415, 'Project export requires application/json')
        let body: unknown

        try {
          body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'))
        } catch (error) {
          if (error instanceof WorkspaceError) throw error
          throw new EditorError(400, 'invalid_json', 'Invalid JSON request')
        }

        protectManagementPath(body)
        const archive = await projects.exportProject(body)
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${archive.fileName}"`,
          'Content-Length': archive.bytes.length,
        })
        response.end(archive.bytes)

        return
      }

      if (request.method === 'GET' && url.pathname === '/api/editor/projects/trash') {
        json(response, 200, { projects: await projects.listDeleted() })

        return
      }

      if (
        request.method === 'POST' &&
        (url.pathname === '/api/editor/projects' ||
          url.pathname === '/api/editor/projects/duplicate' ||
          url.pathname === '/api/editor/projects/rename' ||
          url.pathname === '/api/editor/projects/delete' ||
          url.pathname === '/api/editor/projects/restore')
      ) {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
          throw new WorkspaceError(415, 'Project management requires application/json')
        const bytes = await readBody(request)
        let body: unknown

        try {
          body = JSON.parse(Buffer.from(bytes).toString('utf8'))
        } catch {
          throw new EditorError(400, 'invalid_json', 'Invalid JSON request')
        }

        protectManagementPath(body)

        if (url.pathname.endsWith('/rename')) {
          json(response, 200, await projects.rename(body))

          return
        }

        if (url.pathname.endsWith('/delete')) {
          json(response, 200, await projects.delete(body))

          return
        }

        if (url.pathname.endsWith('/restore')) {
          json(response, 200, await projects.restoreProject(body))

          return
        }

        json(
          response,
          201,
          await (url.pathname.endsWith('/duplicate')
            ? projects.duplicate(body)
            : projects.create(body)),
        )

        return
      }

      if (request.method === 'GET' && url.pathname === '/api/editor/project') {
        json(response, 200, await projects.inspect(path))

        return
      }

      if (request.method === 'GET' && url.pathname === '/api/editor/scene') {
        json(response, 200, await projects.scene(path, url.searchParams.get('id') ?? ''))

        return
      }

      if (
        request.method === 'POST' &&
        (url.pathname === '/api/editor/commands' ||
          url.pathname === '/api/editor/history' ||
          url.pathname === '/api/editor/repair' ||
          url.pathname === '/api/editor/repair/check' ||
          url.pathname === '/api/editor/components/copy')
      ) {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
          throw new WorkspaceError(415, 'Editing requests must use application/json')
        }

        const bytes = await readBody(request)
        let body: unknown

        try {
          body = JSON.parse(Buffer.from(bytes).toString('utf8'))
        } catch {
          throw new EditorError(400, 'invalid_json', 'Invalid JSON request')
        }

        protectManagementPath(body)

        if (url.pathname === '/api/editor/components/copy') {
          json(response, 200, await projects.copyComponent(body))

          return
        }

        if (url.pathname === '/api/editor/repair' || url.pathname === '/api/editor/repair/check') {
          json(
            response,
            200,
            url.pathname.endsWith('/check')
              ? await projects.checkRepair(body)
              : await projects.repair(body),
          )

          return
        }

        if (url.pathname === '/api/editor/history') {
          json(response, 200, await projects.restore(body))

          return
        }

        const result = await projects.apply(body)
        json(response, 200, {
          ...result.view,
          changedFiles: result.changedFiles,
          summary: result.summary,
        })

        return
      }

      if (request.method === 'POST' && url.pathname === '/api/editor/assets/import') {
        const contentType = request.headers['content-type'] ?? ''

        if (!contentType.startsWith('multipart/form-data;'))
          throw new WorkspaceError(415, 'Asset imports must use multipart/form-data')
        const bytes = await readBody(request)
        let form: FormData

        try {
          form = await new Response(new Uint8Array(bytes), {
            headers: { 'Content-Type': contentType },
          }).formData()
        } catch {
          throw new EditorError(400, 'invalid_request', 'Malformed multipart import')
        }

        const metadata = form.get('metadata')
        const file = form.get('file')

        if (typeof metadata !== 'string' || !(file instanceof Blob))
          throw new EditorError(400, 'invalid_request', 'Import requires metadata and file fields')
        let value: unknown

        try {
          value = JSON.parse(metadata)
        } catch {
          throw new EditorError(400, 'invalid_json', 'Invalid import metadata JSON')
        }

        protectManagementPath(value)
        const result = await projects.importAsset(value, new Uint8Array(await file.arrayBuffer()))
        json(response, 200, {
          ...result.view,
          changedFiles: result.changedFiles,
          summary: result.summary,
        })

        return
      }
    }

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

      if (parsed.path.split('/').some((part) => part.toLowerCase().startsWith('.ancadeba-')))
        throw new WorkspaceError(403, 'Project trash cannot be exported')
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
      if (path.split('/').some((part) => part.toLowerCase().startsWith('.ancadeba-')))
        throw new WorkspaceError(403, 'Project management metadata is private')
      json(response, 200, await workspace.list(path))

      return
    }

    if (request.method === 'GET' && url.pathname === '/api/files') {
      if (path.split('/').some((part) => part.toLowerCase().startsWith('.ancadeba-')))
        throw new WorkspaceError(403, 'Project management metadata is private')
      const contents = await coordinator.run(() => workspace.read(path))
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(contents)

      return
    }

    if (request.method === 'PUT' && url.pathname === '/api/files') {
      if (path.split('/').some((part) => part.toLowerCase().startsWith('.ancadeba-')))
        throw new WorkspaceError(
          403,
          'Project management metadata cannot be edited through the file API',
        )
      const contents = await readBody(request)
      const created = await coordinator.run(() => workspace.write(path, contents))
      response.writeHead(created ? 201 : 204)
      response.end()

      return
    }

    json(response, 404, { error: 'Not found' })
  }
}
