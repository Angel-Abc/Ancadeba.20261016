import { describe, expect, it } from 'vite-plus/test'
import { capabilities } from '@ancadeba/editor-core'
import { EditorApiClient } from '../apps/editor-mcp/src/editorApiClient.js'
import { toolResult } from '../apps/editor-mcp/src/toolResults.js'

const config = { editorServerUrl: 'http://127.0.0.1:3100', game: 'My Games/basic', timeoutMs: 100 }
const metadata = {
  type: 'game.updateMetadata' as const,
  title: 'New',
  description: '',
  version: '1',
}
const view = {
  revision: 'new',
  game: {
    'schema-version': '1.0.0',
    id: 'test',
    title: 'New',
    description: '',
    version: '1',
    scenes: [],
  },
  scenes: [],
  diagnostics: [],
  changedFiles: ['game.json'],
  summary: 'Updated game metadata',
}
function requestUrl(value: Parameters<typeof fetch>[0]): string {
  return typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status })
}
const cancelledFetch = (async (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) reject(signal.reason)
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })) as typeof fetch

describe('MCP editor HTTP client', () => {
  it('uses only the configured project, validates responses, and never binds native fetch to a client receiver', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const fetcher = async function (this: unknown, url, init) {
      expect(this).toBeUndefined()
      requests.push({ url: requestUrl(url), ...(init ? { init } : {}) })
      return json(requestUrl(url).endsWith('capabilities') ? capabilities : view)
    } as typeof fetch
    const client = new EditorApiClient(config, fetcher)
    await client.inspectGame()
    await client.apply('old', metadata)
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:3100/api/editor/project?path=My+Games%2Fbasic',
      'http://127.0.0.1:3100/api/editor/capabilities',
      'http://127.0.0.1:3100/api/editor/commands',
    ])
    expect(JSON.parse(requests[2]?.init?.body as string)).toEqual({
      path: config.game,
      expectedRevision: 'old',
      command: metadata,
    })
    for (const request of requests)
      expect(request.init).toMatchObject({ cache: 'no-store', redirect: 'error' })
  })
  it('blocks incompatible or unsupported writes before sending the command', async () => {
    for (const remote of [
      { ...capabilities, version: 2 },
      { ...capabilities, commands: [] },
    ]) {
      let calls = 0
      const client = new EditorApiClient(config, (async () => {
        calls++
        return json(remote)
      }) as typeof fetch)
      await expect(client.apply('old', metadata)).rejects.toMatchObject({
        code: remote.version === 2 ? 'incompatible_api' : 'unsupported_command',
        outcome: 'not_applied',
      })
      expect(calls).toBe(1)
    }
  })
  it('preserves conflict diagnostics and normalizes legacy workspace errors', async () => {
    const diagnostics = [
      { code: 'invalid_document', file: 'game.json', path: ['title'], message: 'Required' },
    ]
    const client = new EditorApiClient(config, (async (url) =>
      requestUrl(url).endsWith('capabilities')
        ? json(capabilities)
        : json({ error: 'Changed', code: 'revision_conflict', diagnostics }, 409)) as typeof fetch)
    await expect(client.apply('old', metadata)).rejects.toMatchObject({
      code: 'revision_conflict',
      status: 409,
      diagnostics,
      outcome: 'not_applied',
    })
    const legacy = new EditorApiClient(config, (async () =>
      json({ error: 'Resource not found' }, 404)) as typeof fetch)
    await expect(legacy.inspectGame()).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      diagnostics: [],
    })
  })
  it('reports malformed success and error responses instead of treating them as saved changes', async () => {
    for (const response of [
      () => json({}),
      () => new Response('not json'),
      () => json({ notAnError: true }, 500),
    ]) {
      let posts = 0
      const client = new EditorApiClient(config, (async (url) => {
        if (requestUrl(url).endsWith('capabilities')) return json(capabilities)
        posts++
        return response()
      }) as typeof fetch)
      await expect(client.apply('old', metadata)).rejects.toMatchObject({
        code: 'invalid_response',
        outcome: 'unknown',
      })
      expect(posts).toBe(1)
    }
  })
  it('does not retry disconnected or timed-out writes and tells the model to inspect first', async () => {
    for (const disconnect of [true, false]) {
      let posts = 0
      const client = new EditorApiClient({ ...config, timeoutMs: 15 }, (async (url, init) => {
        if (requestUrl(url).endsWith('capabilities')) return json(capabilities)
        posts++
        if (disconnect) throw new Error('Socket closed after saving')
        return cancelledFetch(url, init)
      }) as typeof fetch)
      const result = await toolResult(() => client.apply('old', metadata))
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: disconnect ? 'server_unavailable' : 'timeout',
          outcome: 'unknown',
          recovery: expect.stringContaining('Do not retry automatically'),
        },
      })
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(result.structuredContent) },
      ])
      expect(posts).toBe(1)
    }
  })
  it('reports cancellation before dispatch as not applied and aborts requests on shutdown', async () => {
    let requests = 0
    const client = new EditorApiClient(config, (async () => {
      requests++
      return json(view)
    }) as typeof fetch)
    await expect(client.inspectGame(AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
      outcome: 'not_applied',
    })
    expect(requests).toBe(0)
    const shutdown = new AbortController()
    const active = new EditorApiClient(config, cancelledFetch, shutdown.signal)
    const pending = active.inspectGame()
    shutdown.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', outcome: 'not_applied' })
  })
  it('classifies a failed capability check as not applied, without posting a mutation', async () => {
    let calls = 0
    const client = new EditorApiClient(config, (async () => {
      calls++
      throw new Error('Offline')
    }) as typeof fetch)
    await expect(client.apply('old', metadata)).rejects.toMatchObject({
      code: 'server_unavailable',
      outcome: 'not_applied',
    })
    expect(calls).toBe(1)
  })
  it('reports cancellation after dispatch as an uncertain write without retrying', async () => {
    const cancelled = new AbortController()
    let markSent: () => void = () => {}
    const sent = new Promise<void>((resolve) => {
      markSent = resolve
    })
    let posts = 0
    const client = new EditorApiClient(config, (async (url, init) => {
      if (requestUrl(url).endsWith('capabilities')) return json(capabilities)
      posts++
      markSent()
      return cancelledFetch(url, init)
    }) as typeof fetch)
    const pending = client.apply('old', metadata, cancelled.signal)
    await sent
    cancelled.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', outcome: 'unknown' })
    expect(posts).toBe(1)
  })
  it('keeps the timeout active while consuming the response body', async () => {
    const client = new EditorApiClient(
      { ...config, timeoutMs: 15 },
      (async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              })
            },
          }),
        )) as typeof fetch,
    )
    await expect(client.inspectGame()).rejects.toMatchObject({
      code: 'timeout',
      outcome: 'not_applied',
    })
  })
  it('treats server-side storage failures as uncertain writes and preserves their diagnostics', async () => {
    const client = new EditorApiClient(config, (async (url) =>
      requestUrl(url).endsWith('capabilities')
        ? json(capabilities)
        : json(
            { error: 'Reload before retrying', code: 'scene_cleanup_failed', diagnostics: [] },
            500,
          )) as typeof fetch)
    await expect(client.apply('old', metadata)).rejects.toMatchObject({
      code: 'scene_cleanup_failed',
      status: 500,
      outcome: 'unknown',
    })
  })

  it.each([403, 404, 409, 422])(
    'reports a legacy workspace HTTP %i write error as uncertain',
    async (status) => {
      let posts = 0
      const client = new EditorApiClient(config, (async (url) => {
        if (requestUrl(url).endsWith('capabilities')) return json(capabilities)
        posts++
        return json({ error: 'Workspace reread failed' }, status)
      }) as typeof fetch)
      const result = await toolResult(() => client.apply('old', metadata))
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          status,
          outcome: 'unknown',
          recovery: expect.stringContaining('Do not retry automatically'),
        },
      })
      expect(posts).toBe(1)
    },
  )

  it.each([
    ['invalid_request', 400],
    ['invalid_project', 422],
    ['revision_conflict', 409],
    ['scene_exists', 409],
    ['scene_not_found', 404],
    [undefined, 413],
    [undefined, 415],
  ] as const)(
    'recognizes a definite rejection %s with HTTP %i before persistence',
    async (code, status) => {
      const client = new EditorApiClient(config, (async (url) =>
        requestUrl(url).endsWith('capabilities')
          ? json(capabilities)
          : json({ error: 'Rejected', ...(code ? { code } : {}) }, status)) as typeof fetch)
      await expect(client.apply('old', metadata)).rejects.toMatchObject({
        status,
        outcome: 'not_applied',
      })
    },
  )

  it('does not trust rejection codes returned with inconsistent status codes', async () => {
    const client = new EditorApiClient(config, (async (url) =>
      requestUrl(url).endsWith('capabilities')
        ? json(capabilities)
        : json({ error: 'Unexpected failure', code: 'revision_conflict' }, 500)) as typeof fetch)
    await expect(client.apply('old', metadata)).rejects.toMatchObject({ outcome: 'unknown' })
  })

  it('reports local invalid revisions and commands as not applied without any HTTP requests', async () => {
    let calls = 0
    const client = new EditorApiClient(config, (async () => {
      calls++
      throw new Error('Should not send')
    }) as typeof fetch)
    for (const request of [
      () => client.apply('', metadata),
      () =>
        client.apply('old', { type: 'scene.updateLayout', sceneId: 'shop', rows: 0, columns: 1 }),
    ]) {
      const result = await toolResult(request)
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_request',
          outcome: 'not_applied',
          diagnostics: [expect.objectContaining({ code: 'invalid_request' })],
        },
      })
    }
    expect(calls).toBe(0)
  })
})
