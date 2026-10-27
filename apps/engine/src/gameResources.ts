import type { IResourceSource } from '@ancadeba/utilities'

export interface GameResourceService extends IResourceSource {
  fetchResource(relativePath: string): Promise<Response>
}

export class HttpGameResources implements GameResourceService {
  private readonly base: URL

  constructor(
    gameUrl: string,
    applicationUrl: string,
    private readonly fetcher: typeof fetch,
  ) {
    const base = new URL(gameUrl, applicationUrl)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new Error('gameUrl must resolve to an HTTP(S) directory URL without credentials')
    }
    if (base.search || base.hash) {
      throw new Error('gameUrl must not contain a query or fragment')
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    this.base = base
  }

  async readText(path: string): Promise<string> {
    const response = await this.fetchUrl(this.resourceUrl(path), path, { cache: 'no-cache' })
    return response.text()
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const response = await this.fetchUrl(this.resourceUrl(path), path)
    return new Uint8Array(await response.arrayBuffer())
  }

  private resourceUrl(path: string): URL {
    const parts = path.split('/')
    if (
      /[\\:]/.test(path) ||
      path.split('').some((character) => character.charCodeAt(0) < 32) ||
      parts.some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('Game resource paths must stay within the game directory')
    }
    return new URL(parts.map((part) => encodeURIComponent(part)).join('/'), this.base)
  }

  async fetchResource(relativePath: string, options?: RequestInit): Promise<Response> {
    let decoded: string
    try {
      decoded = decodeURIComponent(relativePath)
    } catch {
      throw new Error('Invalid game resource path')
    }
    if (
      !decoded ||
      /^[a-z][\w+.-]*:/i.test(decoded) ||
      decoded.startsWith('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0') ||
      decoded.split(/[/?#]/).includes('..')
    ) {
      throw new Error('Game resource paths must stay within the game directory')
    }
    const url = new URL(relativePath, this.base)
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
      throw new Error('Game resource paths must stay within the game directory')
    }
    return this.fetchUrl(url, relativePath, options)
  }

  private async fetchUrl(url: URL, path: string, options?: RequestInit): Promise<Response> {
    const fetcher = this.fetcher
    let response: Response
    try {
      response = options ? await fetcher(url.href, options) : await fetcher(url.href)
    } catch (error) {
      throw new Error(`Could not fetch game resource: ${path}`, { cause: error })
    }
    if (!response.ok) {
      throw new Error(`Could not fetch game resource ${path}: HTTP ${response.status}`)
    }
    return response
  }
}
