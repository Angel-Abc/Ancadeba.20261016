import { describe, expect, it } from 'vite-plus/test'
import { capabilities } from '@ancadeba/editor-core'
import { EditorApiClient } from '../apps/editor-mcp/src/editorApiClient.js'

const config = { editorServerUrl: 'http://127.0.0.1:3100', game: 'My Games/bound', timeoutMs: 200 }

const available = {
  ...capabilities,
  features: { projectDiscovery: true, projectCreation: true, projectDuplication: true },
}

const view = { revision: 'created', game: null, scenes: [], diagnostics: [] }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

const requestUrl = (url: Parameters<typeof fetch>[0]) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url

const input = { path: 'new-game', title: 'New game', description: '' }

describe('MCP project discovery and creation HTTP operations', () => {
  it('duplicates the captured active project and leaves subsequent reads scoped to the source', async () => {
    const calls: { url: string; body?: unknown }[] = []

    const client = new EditorApiClient(config, async (url, init) => {
      if (requestUrl(url).endsWith('capabilities')) return json(available)
      calls.push({
        url: requestUrl(url),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      })

      return json(view, init?.method === 'POST' ? 201 : 200)
    })

    expect(
      await client.duplicateProject({
        expectedRevision: 'one',
        destination: 'copy',
        title: ' Copy ',
      }),
    ).toEqual(view)
    await client.inspectGame()
    expect(calls).toEqual([
      {
        url: config.editorServerUrl + '/api/editor/projects/duplicate',
        body: { path: config.game, expectedRevision: 'one', destination: 'copy', title: 'Copy' },
      },
      { url: config.editorServerUrl + '/api/editor/project?path=My+Games%2Fbound' },
    ])
  })

  it('rejects duplication scope overrides and unsupported servers before sending a write', async () => {
    let posts = 0

    const client = new EditorApiClient(config, async (_url, init) => {
      if (init?.method === 'POST') posts++

      return json(capabilities)
    })

    const input = { expectedRevision: 'one', destination: 'copy', title: 'Copy' }

    for (const extra of [
      { path: 'other' },
      { editorServerUrl: 'http://other' },
      { destination: '../escape' },
      { expectedRevision: '' },
    ])
      await expect(client.duplicateProject({ ...input, ...extra })).rejects.toMatchObject({
        code: 'invalid_request',
        outcome: 'not_applied',
      })
    await expect(client.duplicateProject(input)).rejects.toMatchObject({
      code: 'unsupported_duplication',
      outcome: 'not_applied',
    })
    expect(posts).toBe(0)
  })

  it('lists workspace projects without inspecting or requiring the bound game', async () => {
    const calls: string[] = []

    const projects = [
      { path: '', title: 'Root' },
      { path: 'nested/game', title: '' },
    ]

    const client = new EditorApiClient(config, async function (this: unknown, url, init) {
      expect(this).toBeUndefined()
      calls.push(requestUrl(url))
      expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' })

      return requestUrl(url).endsWith('capabilities') ? json(available) : json({ projects })
    })

    expect(await client.listProjects()).toEqual({ projects })
    expect(calls).toEqual([
      config.editorServerUrl + '/api/editor/capabilities',
      config.editorServerUrl + '/api/editor/projects',
    ])
  })

  it('creates only the supplied new folder and preserves subsequent configured-game requests', async () => {
    const calls: { url: string; body?: unknown }[] = []

    const client = new EditorApiClient(config, async function (this: unknown, url, init) {
      expect(this).toBeUndefined()

      if (requestUrl(url).endsWith('capabilities')) return json(available)
      let body: unknown

      if (init?.method === 'POST') {
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' })

        if (typeof init.body !== 'string') throw new Error('Expected JSON body')
        body = JSON.parse(init.body)
      }

      calls.push({ url: requestUrl(url), ...(body ? { body } : {}) })

      return json(view, init?.method === 'POST' ? 201 : 200)
    })

    expect(await client.createProject({ ...input, title: '  New game  ' })).toEqual(view)
    await client.inspectGame()
    expect(calls).toEqual([
      { url: config.editorServerUrl + '/api/editor/projects', body: input },
      { url: config.editorServerUrl + '/api/editor/project?path=My+Games%2Fbound' },
    ])
  })

  it('rejects invalid folders, titles and scope overrides locally before HTTP', async () => {
    let calls = 0

    const client = new EditorApiClient(config, async () => {
      calls++

      return json(available)
    })

    for (const path of [
      '',
      '../outside',
      '/absolute',
      'C:\\outside',
      'parent/child',
      'a'.repeat(65),
    ])
      await expect(client.createProject({ ...input, path })).rejects.toMatchObject({
        code: 'invalid_request',
        outcome: 'not_applied',
      })

    for (const value of [
      { ...input, title: ' ' },
      { ...input, title: 'x'.repeat(201) },
      { ...input, expectedRevision: 'other' },
      { ...input, editorServerUrl: 'http://other' },
    ])
      await expect(client.createProject(value)).rejects.toMatchObject({
        code: 'invalid_request',
        outcome: 'not_applied',
      })
    expect(calls).toBe(0)
  })

  it('checks discovery and creation support independently on every call', async () => {
    let flags: unknown = available.features
    let requests = 0

    const client = new EditorApiClient(config, async (url) => {
      if (requestUrl(url).endsWith('capabilities'))
        return json({ ...capabilities, features: flags })
      requests++

      return requestUrl(url).endsWith('projects') ? json({ ...view, projects: [] }) : json(view)
    })

    await client.listProjects()
    await client.createProject(input)

    for (const unavailable of [
      undefined,
      {},
      { projectDiscovery: false, projectCreation: false },
    ]) {
      flags = unavailable
      await expect(client.listProjects()).rejects.toMatchObject({
        code: 'unsupported_discovery',
        outcome: 'not_applied',
      })
      await expect(client.createProject(input)).rejects.toMatchObject({
        code: 'unsupported_creation',
        outcome: 'not_applied',
      })
    }

    expect(requests).toBe(2)
  })

  it('keeps uncertain creation responses distinct from declared existing-folder rejections', async () => {
    for (const [status, code, declared, outcome] of [
      [409, 'project_exists', 'not_applied', 'not_applied'],
      [503, 'unsupported_creation', 'not_applied', 'not_applied'],
      [500, 'project_creation_uncertain', 'unknown', 'unknown'],
      [500, 'project_cleanup_failed', 'not_applied', 'unknown'],
      [404, 'not_found', undefined, 'unknown'],
    ] as const) {
      let posts = 0

      const client = new EditorApiClient(config, async (url) => {
        if (requestUrl(url).endsWith('capabilities')) return json(available)
        posts++

        return json(
          { error: 'Creation failed', code, ...(declared ? { outcome: declared } : {}) },
          status,
        )
      })

      await expect(client.createProject(input)).rejects.toMatchObject({ status, code, outcome })
      expect(posts).toBe(1)
    }
  })

  it('validates discovery and creation responses while preserving write uncertainty', async () => {
    const client = new EditorApiClient(config, async (url) =>
      requestUrl(url).endsWith('capabilities') ? json(available) : json({ unexpected: true }),
    )

    await expect(client.listProjects()).rejects.toMatchObject({
      code: 'invalid_response',
      outcome: 'not_applied',
    })
    await expect(client.createProject(input)).rejects.toMatchObject({
      code: 'invalid_response',
      outcome: 'unknown',
    })
  })

  it('supports cancellation before dispatch and never retries a timed-out creation', async () => {
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

    await expect(client.listProjects(AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
      outcome: 'not_applied',
    })
    await expect(client.createProject(input, AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
      outcome: 'not_applied',
    })
    expect(posts).toBe(0)
    await expect(client.createProject(input)).rejects.toMatchObject({
      code: 'timeout',
      outcome: 'unknown',
    })
    expect(posts).toBe(1)
  })
})
