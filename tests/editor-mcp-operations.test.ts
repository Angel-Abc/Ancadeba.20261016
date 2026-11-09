import { describe, expect, it } from 'vite-plus/test'
import { capabilities } from '@ancadeba/editor-core'
import { EditorApiClient } from '../apps/editor-mcp/src/editorApiClient.js'
import { maxUploadBytes } from '../apps/editor-mcp/src/operationSupport.js'

const config = { editorServerUrl: 'http://127.0.0.1:3100', game: 'My Games/demo', timeoutMs: 200 }
const available = { ...capabilities, features: { history: true, assetImport: true } }

const view = {
  revision: 'saved',
  game: null,
  scenes: [],
  diagnostics: [],
  history: { canUndo: false, canRedo: true, redoLabel: 'Imported image art' },
  changedFiles: ['assets/images/art.svg'],
  summary: 'Imported image art',
}

const bytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="10"><!-- Café --></svg>',
)

const upload = {
  expectedRevision: 'old',
  id: 'art',
  format: 'svg' as const,
  dataBase64: bytes.toString('base64'),
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

const requestUrl = (url: Parameters<typeof fetch>[0]) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

describe('MCP history and asset upload HTTP operations', () => {
  it('posts undo and redo to shared history with the configured game and inspected revision', async () => {
    const posts: unknown[] = []

    const client = new EditorApiClient(config, async function (this: unknown, url, init) {
      expect(this).toBeUndefined()
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' })

      if (requestUrl(url).endsWith('capabilities')) return json(available)
      expect(requestUrl(url)).toBe(config.editorServerUrl + '/api/editor/history')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })

      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request')
      posts.push(JSON.parse(init.body))

      return json(view)
    })

    for (const direction of ['undo', 'redo'] as const)
      expect(await client.restore('old', direction)).toMatchObject({
        revision: 'saved',
        history: view.history,
      })
    expect(posts).toEqual(
      ['undo', 'redo'].map((direction) => ({
        path: config.game,
        expectedRevision: 'old',
        direction,
      })),
    )
  })

  it('uploads exact decoded bytes and fixed project metadata using real multipart encoding', async () => {
    let posts = 0

    const client = new EditorApiClient(config, async function (this: unknown, url, init) {
      expect(this).toBeUndefined()

      if (requestUrl(url).endsWith('capabilities')) return json(available)
      posts++
      expect(requestUrl(url)).toBe(config.editorServerUrl + '/api/editor/assets/import')
      expect(init?.method).toBe('POST')

      const form = await new Response(
        init?.body,
        init?.headers ? { headers: init.headers } : {},
      ).formData()

      const metadata = form.get('metadata')

      if (typeof metadata !== 'string') throw new Error('Expected JSON metadata')
      expect(JSON.parse(metadata)).toEqual({
        path: config.game,
        expectedRevision: 'old',
        id: 'art',
        format: 'svg',
      })
      const file = form.get('file')
      expect(file).toBeInstanceOf(Blob)

      if (!(file instanceof Blob)) throw new Error('Expected uploaded image')
      expect(file.type).toBe('image/svg+xml')
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes)

      return json(view)
    })

    expect(await client.uploadAsset(upload)).toMatchObject({
      revision: 'saved',
      changedFiles: view.changedFiles,
    })
    expect(posts).toBe(1)
  })

  it('rejects malformed base64, scope overrides, unsafe IDs and invalid revisions before HTTP', async () => {
    let calls = 0

    const client = new EditorApiClient(config, async () => {
      calls++

      return json(available)
    })

    for (const dataBase64 of [
      '',
      'abc',
      'a===',
      '!!!!',
      'Zh==',
      'Zg',
      'Zg==\n',
      'data:image/svg+xml;base64,Zg==',
    ])
      await expect(client.uploadAsset({ ...upload, dataBase64 })).rejects.toMatchObject({
        code: 'invalid_request',
        outcome: 'not_applied',
      })

    for (const invalid of [
      { ...upload, path: 'other' },
      { ...upload, url: 'http://other' },
      { ...upload, id: '../art' },
      { ...upload, expectedRevision: '' },
    ])
      await expect(client.uploadAsset(invalid)).rejects.toMatchObject({
        code: 'invalid_request',
        outcome: 'not_applied',
      })
    await expect(client.restore('', 'undo')).rejects.toMatchObject({
      code: 'invalid_request',
      outcome: 'not_applied',
    })
    expect(calls).toBe(0)
  })

  it('enforces the complete multipart size limit including metadata before contacting the server', async () => {
    let calls = 0

    const client = new EditorApiClient(config, async () => {
      calls++

      return json(available)
    })

    await expect(
      client.uploadAsset({
        ...upload,
        dataBase64: Buffer.alloc(maxUploadBytes).toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'request_too_large', status: 413, outcome: 'not_applied' })
    expect(calls).toBe(0)
  })

  it('requires advertised operation support and rechecks it on every call', async () => {
    let remote: typeof available | typeof capabilities = available
    let posts = 0

    const client = new EditorApiClient(config, async (url) => {
      if (requestUrl(url).endsWith('capabilities')) return json(remote)
      posts++

      return json(view)
    })

    await client.restore('old', 'undo')
    await client.uploadAsset(upload)

    for (const unavailable of [
      capabilities,
      { ...available, features: { history: false, assetImport: false } },
    ]) {
      remote = unavailable
      await expect(client.restore('old', 'redo')).rejects.toMatchObject({
        code: 'unsupported_history',
        outcome: 'not_applied',
      })
      await expect(client.uploadAsset(upload)).rejects.toMatchObject({
        code: 'unsupported_import',
        outcome: 'not_applied',
      })
    }

    expect(posts).toBe(2)

    const partial = new EditorApiClient(config, async () =>
      json({ ...capabilities, features: { history: true } }),
    )

    expect((await partial.capabilities()).features).toEqual({ history: true, assetImport: false })

    await expect(partial.uploadAsset(upload)).rejects.toMatchObject({
      code: 'unsupported_import',
      outcome: 'not_applied',
    })
  })

  it('distinguishes definite operation rejections from uncertain storage failures', async () => {
    for (const [code, status, declared, outcome] of [
      ['history_empty', 409, 'not_applied', 'not_applied'],
      ['invalid_asset', 422, 'not_applied', 'not_applied'],
      ['unsupported_history', 503, 'not_applied', 'not_applied'],
      ['unsupported_import', 503, 'not_applied', 'not_applied'],
      ['history_restore_failed', 500, 'unknown', 'unknown'],
      ['history_restore_failed', 500, 'not_applied', 'unknown'],
      ['history_restore_uncertain', 409, 'unknown', 'unknown'],
      ['history_empty', 409, undefined, 'unknown'],
      ['asset_publication_failed', 500, 'unknown', 'unknown'],
    ] as const) {
      const client = new EditorApiClient(config, async (url) =>
        requestUrl(url).endsWith('capabilities')
          ? json(available)
          : json(
              { error: 'Operation failed', code, ...(declared ? { outcome: declared } : {}) },
              status,
            ),
      )

      await expect(
        code.includes('asset') || code.includes('import')
          ? client.uploadAsset(upload)
          : client.restore('old', 'undo'),
      ).rejects.toMatchObject({ code, status, outcome })
    }
  })

  it('does not retry timed-out history restores or multipart uploads after dispatch', async () => {
    for (const operation of ['history', 'upload']) {
      let posts = 0

      const client = new EditorApiClient({ ...config, timeoutMs: 20 }, async (url, init) => {
        if (requestUrl(url).endsWith('capabilities')) return json(available)
        posts++

        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal

          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })

      await expect(
        operation === 'history' ? client.restore('old', 'undo') : client.uploadAsset(upload),
      ).rejects.toMatchObject({ code: 'timeout', outcome: 'unknown' })
      expect(posts).toBe(1)
    }
  })

  it('cancels both operations before dispatch and treats malformed post-save responses as uncertain', async () => {
    let calls = 0

    const client = new EditorApiClient(config, async (url) => {
      calls++

      return requestUrl(url).endsWith('capabilities')
        ? json(available)
        : json({ revision: 'missing-fields' })
    })

    await expect(client.restore('old', 'undo', AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
      outcome: 'not_applied',
    })
    await expect(client.uploadAsset(upload, AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
      outcome: 'not_applied',
    })
    expect(calls).toBe(0)
    await expect(client.restore('old', 'undo')).rejects.toMatchObject({
      code: 'invalid_response',
      outcome: 'unknown',
    })
    await expect(client.uploadAsset(upload)).rejects.toMatchObject({
      code: 'invalid_response',
      outcome: 'unknown',
    })
  })
})
