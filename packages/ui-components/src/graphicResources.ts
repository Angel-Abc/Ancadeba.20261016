import {
  prepareGraphicSvg,
  validateImageSource,
  type GraphicPiece,
  type ImageSourceInfo,
} from '@ancadeba/game-runtime'
import type { IResourceSource } from '@ancadeba/utilities'

export interface GraphicLease {
  readonly url: string
  release(): void
}

export interface IGraphicResources {
  acquire(piece: GraphicPiece): Promise<GraphicLease>
}

export interface GraphicPlatform {
  createUrl(bytes: Uint8Array, mime: string): string
  revokeUrl(url: string): void
  decode(url: string): Promise<void>
  digest(bytes: Uint8Array): Promise<string>
  decodeText(bytes: Uint8Array): string
  encodeText(text: string): Uint8Array
}

interface Source {
  bytes: Uint8Array
  info: ImageSourceInfo
  hash: string
}

interface Variant {
  promise: Promise<string>
  references: number
  used: number
  url?: string
}

export function createGraphicPlatform(document: Document): GraphicPlatform {
  const window = document.defaultView

  if (!window) throw new Error('Graphics require a browser window')

  return {
    createUrl: (bytes, mime) =>
      window.URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime })),
    revokeUrl: (url) => window.URL.revokeObjectURL(url),
    decode: async (url) => {
      const image = document.createElement('img')
      image.src = url
      await image.decode()
    },
    digest: async (bytes) =>
      Array.from(
        new Uint8Array(await window.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    decodeText: (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    encodeText: (text) => new TextEncoder().encode(text),
  }
}

/** One service per mounted game/preview. Active leases survive idle-cache eviction. */
export class BrowserGraphicResources implements IGraphicResources {
  private readonly sources = new Map<string, Promise<Source>>()
  private readonly variants = new Map<string, Variant>()
  private disposed = false
  private clock = 0
  constructor(
    private readonly source: IResourceSource,
    private readonly platform: GraphicPlatform,
    private readonly unusedLimit = 64,
  ) {}

  async acquire(piece: GraphicPiece): Promise<GraphicLease> {
    if (this.disposed) throw new Error('Graphics are disposed')
    const sourceKey = JSON.stringify(piece.image)
    let loading = this.sources.get(sourceKey)

    if (!loading) {
      loading = this.load(piece)
      this.sources.set(sourceKey, loading)
      void loading.catch(() => {
        if (this.sources.get(sourceKey) === loading) this.sources.delete(sourceKey)
      })
    }

    const source = await loading

    if (this.disposed) throw new Error('Graphics are disposed')
    const key = `${source.hash}:${JSON.stringify(Object.entries(piece.colors).sort(([a], [b]) => a.localeCompare(b)))}`
    let variant = this.variants.get(key)

    if (!variant) {
      const bytes = source.info.svg
        ? this.platform.encodeText(prepareGraphicSvg(source.info.svg, piece.colors))
        : source.bytes

      const url = this.platform.createUrl(
        bytes,
        `image/${piece.image.format === 'svg' ? 'svg+xml' : piece.image.format}`,
      )

      const created: Variant = { references: 0, used: ++this.clock, promise: Promise.resolve(url) }
      created.promise = this.platform
        .decode(url)
        .then(() => {
          if (this.disposed) {
            this.platform.revokeUrl(url)
            throw new Error('Graphics are disposed')
          }

          created.url = url

          return url
        })
        .catch((error: unknown) => {
          this.platform.revokeUrl(url)
          this.variants.delete(key)
          throw error
        })
      variant = created
      this.variants.set(key, created)
    }

    variant.references++
    let url: string

    try {
      url = await variant.promise
    } catch (error) {
      variant.references--
      throw error
    }

    if (this.disposed) throw new Error('Graphics are disposed')
    variant.used = ++this.clock
    this.trim()
    let released = false

    return {
      url,
      release: () => {
        if (released) return
        released = true
        variant.references--
        variant.used = ++this.clock
        this.trim()
      },
    }
  }

  private async load(piece: GraphicPiece): Promise<Source> {
    const bytes = await this.source.readBytes(piece.image.source)

    if (bytes.length > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MiB limit')

    const info = validateImageSource(
      piece.image,
      bytes,
      piece.image.format === 'svg' ? this.platform.decodeText(bytes) : '',
    )

    return { bytes, info, hash: await this.platform.digest(bytes) }
  }

  private trim(): void {
    const unused = [...this.variants.entries()]
      .filter(([, entry]) => entry.references === 0 && entry.url)
      .sort(([, a], [, b]) => a.used - b.used)

    for (const [key, entry] of unused.slice(0, Math.max(0, unused.length - this.unusedLimit))) {
      this.platform.revokeUrl(entry.url!)
      this.variants.delete(key)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const entry of this.variants.values()) if (entry.url) this.platform.revokeUrl(entry.url)
    this.variants.clear()
    this.sources.clear()
  }
}
