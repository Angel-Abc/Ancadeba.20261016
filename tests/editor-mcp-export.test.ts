import { describe, expect, it, vi } from 'vite-plus/test'
import { capabilities } from '@ancadeba/editor-core'
import { zipSync, strToU8, unzipSync } from 'fflate'
import { EditorApiClient } from '../apps/editor-mcp/src/editorApiClient.js'
import { readExportArchive } from '../apps/editor-mcp/src/exportArchive.js'
import { maxExportBytes, mcpOperations } from '../apps/editor-mcp/src/operationSupport.js'

const config = { editorServerUrl: 'http://127.0.0.1:3100', game: 'nested/My game', timeoutMs: 200 }
const available = { ...capabilities, features: { gameExport: true } }
const zip = zipSync({ 'index.html': strToU8('<h1>Playable</h1>') })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

const archive = (bytes = zip, headers?: Record<string, string>) =>
  new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'application/zip', ...headers },
  })

const requestUrl = (url: Parameters<typeof fetch>[0]) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

describe('MCP game export HTTP adapter', () => {
  it('exports the bound project through the fixed endpoint and preserves exact ZIP bytes', async () => {
    const posts: unknown[] = []

    const client = new EditorApiClient(config, async (url, init) => {
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' })

      if (requestUrl(url).endsWith('capabilities')) return json(available)
      expect(requestUrl(url)).toBe(config.editorServerUrl + '/api/exports')
      expect(init?.method).toBe('POST')

      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request')
      posts.push(JSON.parse(init.body))

      return archive(zip, {
        'content-disposition': 'attachment; filename="My-game.zip"',
        'content-length': String(zip.length),
      })
    })

    const result = await client.exportGame({})
    expect(result).toEqual({
      fileName: 'My-game.zip',
      mimeType: 'application/zip',
      size: zip.length,
      dataBase64: Buffer.from(zip).toString('base64'),
    })
    expect(unzipSync(Buffer.from(result.dataBase64, 'base64'))['index.html']).toEqual(
      strToU8('<h1>Playable</h1>'),
    )
    expect(posts).toEqual([{ path: config.game }])
    await client.forProject('').exportGame({})
    expect(posts[1]).toEqual({ path: '' })
  })

  it('advertises limits and gates export independently of authoring capabilities', async () => {
    expect(mcpOperations().gameExport).toMatchObject({ supported: false })
    expect(mcpOperations().gameExport.requestSchema.required ?? []).not.toContain('timeoutMs')
    expect(
      mcpOperations({ history: false, assetImport: false, gameExport: true }).gameExport,
    ).toMatchObject({
      tool: 'ancadeba_export_game',
      supported: true,
      maxArchiveBytes: maxExportBytes,
      defaultTimeoutMs: 120000,
    })

    for (const features of [undefined, {}, { gameExport: false }]) {
      const fetcher = vi.fn(async () => json({ ...capabilities, features }))
      await expect(new EditorApiClient(config, fetcher).exportGame({})).rejects.toMatchObject({
        code: 'unsupported_export',
        outcome: 'not_applied',
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 300001 },
    { timeoutMs: 1.5 },
    { path: 'other' },
    { url: 'http://other' },
    { outputPath: 'game.zip' },
    { expectedRevision: 'old' },
  ])('rejects invalid or out-of-scope input %j before HTTP', async (input) => {
    const fetcher = vi.fn()
    await expect(new EditorApiClient(config, fetcher).exportGame(input)).rejects.toMatchObject({
      code: 'invalid_request',
      outcome: 'not_applied',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([409, 422, 503])(
    'reports HTTP %i export failures without claiming saved edits or retrying',
    async (status) => {
      const fetcher = vi.fn(async (url) =>
        requestUrl(url).endsWith('capabilities')
          ? json(available)
          : json({ error: 'Export failed' }, status),
      )

      await expect(new EditorApiClient(config, fetcher).exportGame({})).rejects.toMatchObject({
        message: 'Export failed',
        outcome: 'not_applied',
        status,
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it('uses a separate build deadline and supports timeout, cancellation and shutdown', async () => {
    for (const reason of ['timeout', 'cancelled', 'shutdown']) {
      const request = new AbortController()
      const shutdown = new AbortController()

      const fetcher = vi.fn(async (url, init) => {
        if (requestUrl(url).endsWith('capabilities')) return json(available)

        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })

          if (reason === 'cancelled') request.abort()

          if (reason === 'shutdown') shutdown.abort()
        })
      })

      const client = new EditorApiClient(config, fetcher, shutdown.signal)
      await expect(client.exportGame({ timeoutMs: 5 }, request.signal)).rejects.toMatchObject({
        code: reason === 'shutdown' ? 'cancelled' : reason,
        outcome: 'not_applied',
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
    }

    const fetcher = vi.fn(async (url, init) => {
      if (requestUrl(url).endsWith('capabilities')) return json(available)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20)

        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(init.signal?.reason)
          },
          { once: true },
        )
      })

      return archive()
    })

    expect(
      await new EditorApiClient({ ...config, timeoutMs: 5 }, fetcher).exportGame({
        timeoutMs: 100,
      }),
    ).toMatchObject({ size: zip.length })
  })

  it('rejects an already cancelled request before sending', async () => {
    const request = new AbortController()
    request.abort()
    const fetcher = vi.fn()
    await expect(
      new EditorApiClient(config, fetcher).exportGame({}, request.signal),
    ).rejects.toMatchObject({ code: 'cancelled', outcome: 'not_applied' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('bounded ZIP response decoding', () => {
  it('sanitizes filenames without allowing server-supplied paths', async () => {
    expect(
      await readExportArchive(
        archive(zip, { 'content-disposition': 'attachment; filename="../outside.zip"' }),
      ),
    ).toMatchObject({ fileName: 'game.zip' })
  })

  it.each([
    () => new Response('not zip'),
    () => archive(new Uint8Array()),
    () => archive(strToU8('<html>Error</html>')),
    () => archive(zip, { 'content-length': 'invalid' }),
    () => archive(zip, { 'content-length': String(zip.length + 1) }),
    () => archive(zip, { 'content-length': '0' }),
  ])('rejects wrong content, empty and truncated responses', async (response) => {
    await expect(readExportArchive(response())).rejects.toMatchObject({
      code: 'invalid_response',
      outcome: 'not_applied',
    })
  })

  it('rejects oversized declared and streamed archives and cancels the body', async () => {
    await expect(
      readExportArchive(archive(zip, { 'content-length': String(maxExportBytes + 1) })),
    ).rejects.toMatchObject({ code: 'export_too_large' })
    const cancel = vi.fn()

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxExportBytes))
        controller.enqueue(new Uint8Array(1))
      },
      cancel,
    })

    await expect(
      readExportArchive(new Response(stream, { headers: { 'content-type': 'application/zip' } })),
    ).rejects.toMatchObject({ code: 'export_too_large' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('accepts the exact archive limit within a default MCP client message budget', async () => {
    const bytes = new Uint8Array(maxExportBytes)
    bytes.set(zip)
    const result = await readExportArchive(archive(bytes))
    expect(result.size).toBe(maxExportBytes)
    expect(
      JSON.stringify({ type: 'resource', resource: { blob: result.dataBase64 } }).length,
    ).toBeLessThan(10 * 1024 * 1024)
  })
})
