import { describe, expect, it } from 'vite-plus/test'
import type { CommandRequest, ProjectView } from '@ancadeba/editor-core'
import {
  EditorClientError,
  HttpEditorClient,
  type IEditorClient,
} from '../apps/editor-ui/src/editorClient.js'
import {
  ProjectEditorController,
  type ProjectEditorState,
} from '../apps/editor-ui/src/projectController.js'

const view = (revision: string): ProjectView => ({
  revision,
  game: {
    'schema-version': '1.0.0',
    id: 'test',
    title: 'Game',
    description: '',
    version: '1',
    scenes: [],
  },
  scenes: [],
  diagnostics: [],
})
describe('project editor controller', () => {
  it('preserves draft values and the original revision across refresh and conflict until explicit reload', async () => {
    let latest = view('one')
    const requests: CommandRequest[] = []
    const client: IEditorClient = {
      inspect: async () => latest,
      apply: async (request) => {
        requests.push(request)
        if (request.expectedRevision !== latest.revision)
          throw new EditorClientError('revision_conflict', 'Reload before retrying')
        return latest
      },
    }
    const updates: { state: ProjectEditorState; replaceFields: boolean }[] = []
    const controller = new ProjectEditorController(client, (state, replaceFields) =>
      updates.push({ state, replaceFields }),
    )
    await controller.load('basic')
    latest = view('two')
    await controller.refresh(true)
    expect(updates.at(-1)).toMatchObject({
      state: { changedElsewhere: true, view: { revision: 'one' } },
      replaceFields: false,
    })
    const operation = {
      type: 'game.updateMetadata' as const,
      title: 'My draft',
      description: '',
      version: '1',
    }
    await controller.save(operation)
    expect(updates.at(-1)).toMatchObject({ state: { conflict: true }, replaceFields: false })
    await controller.load('basic', true)
    expect(updates.at(-1)).toMatchObject({
      state: { view: { revision: 'two' }, conflict: false, preserveDrafts: true },
      replaceFields: true,
    })
    await controller.save(operation)
    expect(requests.map((request) => request.expectedRevision)).toEqual(['one', 'two'])
    expect(updates.at(-1)?.replaceFields).toBe(true)
  })

  it('checks for drafts when a background refresh completes, including typing during the read', async () => {
    let complete: (value: ProjectView) => void = () => {}
    let dirty = false
    const client: IEditorClient = {
      inspect: async () => view('one'),
      apply: async () => view('saved'),
    }
    const updates: { state: ProjectEditorState; replaceFields: boolean }[] = []
    const controller = new ProjectEditorController(client, (state, replaceFields) =>
      updates.push({ state, replaceFields }),
    )
    await controller.load('basic')
    client.inspect = () =>
      new Promise((resolve) => {
        complete = resolve
      })
    const pending = controller.refresh(() => dirty)
    dirty = true
    complete(view('two'))
    await pending
    expect(updates.at(-1)).toMatchObject({
      state: { view: { revision: 'one' }, changedElsewhere: true, busy: false },
      replaceFields: false,
    })
    dirty = false
    const clean = controller.refresh(() => dirty)
    complete(view('two'))
    await clean
    expect(updates.at(-1)).toMatchObject({
      state: { view: { revision: 'two' } },
      replaceFields: true,
    })
  })

  it('allows saves during background refresh and discards the stale refresh result', async () => {
    let complete: (value: ProjectView) => void = () => {}
    const requests: CommandRequest[] = []
    const client: IEditorClient = {
      inspect: async () => view('one'),
      apply: async (request) => {
        requests.push(request)
        return view('saved')
      },
    }
    const updates: ProjectEditorState[] = []
    const controller = new ProjectEditorController(client, (state) => updates.push(state))
    await controller.load('basic')
    client.inspect = () =>
      new Promise((resolve) => {
        complete = resolve
      })
    const refreshing = controller.refresh(() => false)
    await controller.save({
      type: 'game.updateMetadata',
      title: 'Draft',
      description: '',
      version: '1',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.expectedRevision).toBe('one')
    complete(view('outdated'))
    await refreshing
    expect(updates.at(-1)?.view?.revision).toBe('saved')
  })

  it('ignores failed refreshes superseded by a project load and never preserves drafts across projects', async () => {
    let fail: (error: Error) => void = () => {}
    const client: IEditorClient = {
      inspect: async () => view('one'),
      apply: async () => view('saved'),
    }
    const updates: ProjectEditorState[] = []
    const controller = new ProjectEditorController(client, (state) => updates.push(state))
    await controller.load('basic')
    client.inspect = () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
    const refreshing = controller.refresh(() => false)
    client.inspect = async () => view('other')
    await controller.load('other', true)
    fail(new Error('Old request failed'))
    await refreshing
    expect(updates.at(-1)).toMatchObject({
      path: 'other',
      view: { revision: 'other' },
      error: '',
      preserveDrafts: false,
    })
  })

  it('refreshes clean fields and ignores late callbacks after disposal', async () => {
    let latest = view('one')
    let finish: ((value: ProjectView) => void) | undefined
    const updates: boolean[] = []
    const client: IEditorClient = {
      inspect: async () => latest,
      apply: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    }
    const controller = new ProjectEditorController(client, (_state, replace) =>
      updates.push(replace),
    )
    await controller.load('')
    latest = view('two')
    await controller.refresh(false)
    expect(updates.at(-1)).toBe(true)
    const pending = controller.save({
      type: 'game.updateMetadata',
      title: 'New',
      description: '',
      version: '1',
    })
    const count = updates.length
    controller.dispose()
    finish?.(latest)
    await pending
    expect(updates).toHaveLength(count)
  })

  it('uses the same HTTP contract and returns structured diagnostics', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const fetcher: typeof fetch = async function (this: unknown, url, init) {
      expect(this).toBeUndefined()
      requests.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        init,
      })
      return new Response(
        JSON.stringify({
          error: 'Invalid project',
          code: 'invalid_project',
          diagnostics: [
            { code: 'invalid_document', file: 'game.json', path: ['title'], message: 'Required' },
          ],
        }),
        { status: 422 },
      )
    }
    const client = new HttpEditorClient(fetcher)
    await expect(
      client.apply({
        path: 'basic',
        expectedRevision: 'one',
        command: { type: 'game.updateMetadata', title: 'X', description: '', version: '1' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_project',
      diagnostics: [{ file: 'game.json', path: ['title'] }],
    })
    expect(requests[0]?.url).toBe('/api/editor/commands')
    expect(requests[0]?.init?.cache).toBe('no-store')
  })

  it.each([
    {},
    { ...view('one'), revision: 123 },
    { ...view('one'), diagnostics: [{ code: 'invalid_document' }] },
  ])('rejects malformed successful project responses: %#', async (body) => {
    const client = new HttpEditorClient(async () => new Response(JSON.stringify(body)))
    await expect(client.inspect('basic')).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'Editor response was malformed',
    })
  })

  it('normalizes malformed error responses without trusting their diagnostics', async () => {
    const client = new HttpEditorClient(
      async () =>
        new Response(JSON.stringify({ error: ['unexpected'], diagnostics: 'invalid' }), {
          status: 500,
        }),
    )
    await expect(client.inspect('basic')).rejects.toMatchObject({
      code: 'request_failed',
      message: 'Editor request failed',
      diagnostics: [],
    })
  })
})
