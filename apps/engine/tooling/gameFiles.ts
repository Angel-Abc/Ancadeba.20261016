import { lstat, realpath } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sirv from 'sirv'
import type { Plugin } from 'vite-plus'

const sampleGamesDirectory = fileURLToPath(new URL('../../../sample-games/', import.meta.url))
const excludedNames = new Set(['.git', '.hg', '.svn', 'node_modules', '.ds_store', 'thumbs.db'])

class GameFileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function checkFile(directory: string, url: string): Promise<void> {
  let path: string
  try {
    // Match the static server's decoding without normalizing away traversal segments.
    path = decodeURI(url.split('?')[0] ?? '').replace(/^\//, '')
  } catch {
    throw new GameFileError(400, 'Invalid game resource path')
  }
  if (!path || path.endsWith('/')) throw new GameFileError(404, 'Game resource not found')
  const parts = path.split('/')
  if (
    parts.some((part) => {
      const name = part.toLowerCase()
      return (
        !part ||
        name === '.' ||
        name === '..' ||
        /[. ]$/.test(part) ||
        excludedNames.has(name) ||
        name === '.env' ||
        name.startsWith('.env.')
      )
    }) ||
    /[\\:]/.test(path) ||
    path.split('').some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new GameFileError(403, 'Game resource path is not accessible')
  }

  const rootInfo = await lstat(directory)
  if (rootInfo.isSymbolicLink()) throw new GameFileError(403, 'Links are not accessible')
  if (!rootInfo.isDirectory()) throw new GameFileError(404, 'Game resource not found')
  const root = await realpath(directory)
  let target = root
  for (const [index, part] of parts.entries()) {
    target = resolve(target, part)
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new GameFileError(403, 'Links are not accessible')
    target = await realpath(target)
    if (!within(root, target)) throw new GameFileError(403, 'Game resource path is not accessible')
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new GameFileError(404, 'Game resource not found')
    }
  }
}

function failure(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) {
    response.destroy()
    return
  }
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  const status =
    error instanceof GameFileError
      ? error.status
      : code === 'ENOENT' || code === 'ENOTDIR'
        ? 404
        : code === 'EACCES' || code === 'EPERM'
          ? 403
          : 500
  const message =
    error instanceof GameFileError
      ? error.message
      : status === 404
        ? 'Game resource not found'
        : 'Game resource unavailable'
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ error: message }))
}

export function gameFilesPlugin(directory = sampleGamesDirectory): Plugin {
  const root = resolve(directory)
  const serve = sirv(root, { dev: true, etag: false, extensions: [], single: false })
  return {
    name: 'engine-local-game-files',
    apply: 'serve',
    configureServer(server) {
      const mounts = new Set(['/sample-games/', `${server.config.base}sample-games/`])
      for (const mount of mounts) {
        server.middlewares.use(mount, (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.setHeader('Allow', 'GET, HEAD')
            failure(response, new GameFileError(405, 'Method not allowed'))
            return
          }
          void checkFile(root, request.url ?? '')
            .then(() => {
              serve(request, response, () =>
                failure(response, new GameFileError(404, 'Game resource not found')),
              )
            })
            .catch((error: unknown) => failure(response, error))
        })
      }
    },
  }
}
