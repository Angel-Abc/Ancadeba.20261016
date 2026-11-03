/// <reference lib="dom" />
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vite-plus/test'
import { imageAssetSchema } from '@ancadeba/schemas'
import { BrowserGraphicResources, type GraphicPlatform } from '@ancadeba/ui-components'
import type { GraphicPiece } from '@ancadeba/game-runtime'

const text =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 30"><rect width="20" height="30" fill="var(--fabric, #123456)"/></svg>'

const bytes = new TextEncoder().encode(text)

const image = imageAssetSchema.parse({
  format: 'svg',
  source: 'art.svg',
  bounds: { x: 0, y: 0, width: 20, height: 30 },
  colors: { fabric: '#123456' },
})

const piece = (color = '#123456'): GraphicPiece => ({
  imageId: 'art',
  image,
  colors: { fabric: color },
  transform: '',
  layer: 'body',
})

function platform() {
  const created: { url: string; text: string }[] = []
  const revoked: string[] = []
  const decode = vi.fn(async () => {})

  const adapter: GraphicPlatform = {
    createUrl: (bytes) => {
      const url = `blob:${created.length}`
      created.push({ url, text: new TextDecoder().decode(bytes) })

      return url
    },
    revokeUrl: (url) => {
      revoked.push(url)
    },
    decode,
    digest: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
    decodeText: (bytes) => new TextDecoder().decode(bytes),
    encodeText: (text) => new TextEncoder().encode(text),
  }

  return { adapter, created, revoked, decode }
}

describe('browser graphics resources', () => {
  it('deduplicates source reads and variant decoding, and keeps palettes isolated', async () => {
    const host = platform()
    const source = { readText: async () => text, readBytes: vi.fn(async () => bytes) }
    const resources = new BrowserGraphicResources(source, host.adapter)

    const [first, second, third] = await Promise.all([
      resources.acquire(piece()),
      resources.acquire(piece()),
      resources.acquire(piece('#abcdef')),
    ])

    expect(first.url).toBe(second.url)
    expect(third.url).not.toBe(first.url)
    expect(source.readBytes).toHaveBeenCalledTimes(1)
    expect(host.decode).toHaveBeenCalledTimes(2)
    expect(host.created[1]?.text).toContain('#abcdef')
    first.release()
    second.release()
    third.release()
    resources.dispose()
    expect(host.revoked.sort()).toEqual(['blob:0', 'blob:1'])
  })

  it('evicts only unused variants and releases URLs on disposal', async () => {
    const host = platform()

    const resources = new BrowserGraphicResources(
      { readText: async () => text, readBytes: async () => bytes },
      host.adapter,
      1,
    )

    const active = await resources.acquire(piece())
    const second = await resources.acquire(piece('#aabbcc'))
    second.release()
    const third = await resources.acquire(piece('#ddeeff'))
    third.release()
    expect(host.revoked).toEqual([second.url])
    expect(host.revoked).not.toContain(active.url)
    active.release()
    active.release()
    resources.dispose()
    resources.dispose()
    expect(new Set(host.revoked)).toEqual(new Set([active.url, second.url, third.url]))
  })

  it('revokes failed decodes and can retry a failed source without poisoning the cache', async () => {
    const host = platform()
    const readBytes = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(bytes)

    const resources = new BrowserGraphicResources(
      { readText: async () => text, readBytes },
      host.adapter,
    )

    await expect(resources.acquire(piece())).rejects.toThrow('offline')
    host.adapter.decode = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad image'))
      .mockResolvedValue(undefined)
    await expect(resources.acquire(piece())).rejects.toThrow('bad image')
    expect(host.revoked).toEqual(['blob:0'])
    const lease = await resources.acquire(piece())
    expect(readBytes).toHaveBeenCalledTimes(2)
    lease.release()
    resources.dispose()
  })

  it('does not leak URLs when disposed while decoding', async () => {
    const host = platform()
    let finish: (() => void) | undefined
    host.adapter.decode = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })

    const resources = new BrowserGraphicResources(
      { readText: async () => text, readBytes: async () => bytes },
      host.adapter,
    )

    const pending = resources.acquire(piece())
    const rejected = expect(pending).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    resources.dispose()
    finish!()
    await rejected
    expect(host.revoked).toContain('blob:0')
  })
})
