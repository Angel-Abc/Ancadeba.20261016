import type { IResourceSource } from '@ancadeba/utilities'

function validatePath(path: string, allowRoot = false): void {
  if (allowRoot && path === '') return
  if (
    path.startsWith('/') ||
    /[\\:]/.test(path) ||
    path.split('').some((character) => character.charCodeAt(0) < 32) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Use a game-relative path with / separators and no parent directories')
  }
}

export function normalizeGameFolder(folder: string): string {
  const trimmed = folder.trim()
  if (trimmed.startsWith('/')) validatePath(trimmed)
  const path = trimmed.replace(/\/+$/, '')
  validatePath(path, true)
  return path
}

export class EditorWorkspaceResources implements IResourceSource {
  private readonly folder: string

  constructor(
    folder: string,
    private readonly fetcher: typeof fetch,
    private readonly endpoint = '/api/files',
  ) {
    this.folder = normalizeGameFolder(folder)
  }

  async readText(path: string): Promise<string> {
    return (await this.read(path)).text()
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const response = await this.read(path)
    return new Uint8Array(await response.arrayBuffer())
  }

  private async read(path: string): Promise<Response> {
    validatePath(path)
    const workspacePath = this.folder ? `${this.folder}/${path}` : path
    const query = new URLSearchParams({ path: workspacePath })
    const fetcher = this.fetcher
    let response: Response
    try {
      response = await fetcher(`${this.endpoint}?${query}`, { cache: 'no-store' })
    } catch (error) {
      throw new Error(`Could not read workspace resource ${workspacePath}`, { cause: error })
    }
    if (!response.ok) {
      throw new Error(`Could not read workspace resource ${workspacePath}: HTTP ${response.status}`)
    }
    return response
  }
}
