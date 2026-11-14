import { describe, expect, it, vi } from 'vite-plus/test'
import {
  commandRequestSchema,
  createProjectRequestSchema,
  duplicateProjectRequestSchema,
  historyRequestSchema,
  renameProjectRequestSchema,
  deleteProjectRequestSchema,
  restoreProjectRequestSchema,
  type DeletedProject,
  type CommandRequest,
  type CreateProjectRequest,
  type DuplicateProjectRequest,
  type ProjectChoice,
  type ProjectView,
  type HistoryRequest,
} from '@ancadeba/editor-core'
import { bindProjectPanel } from '../apps/editor-ui/src/projectPanel.js'
import { editorLocalization } from '../apps/editor-ui/src/localization.js'
import type { EditorDraftStorage } from '../apps/editor-ui/src/editorDraftStore.js'

// A small DOM surface for testing form reconciliation without a browser runtime.
class Control extends EventTarget {
  value = ''
  textContent = ''
  disabled = false
  hidden = false
  required = false
  placeholder = ''
  label = ''
  attributes = new Map<string, string>()
  children: Control[] = []

  constructor(readonly id: string) {
    super()
  }

  replaceChildren(...children: Control[]) {
    this.children = children
    this.value = children[0]?.value ?? ''
  }

  append(child: Control) {
    this.children.push(child)
  }

  reset() {}

  focus() {}

  requestSubmit() {
    this.fire('submit')
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  fire(event: string) {
    this.dispatchEvent(new Event(event))
  }
}

function project(revision: string): ProjectView {
  const scenes = ['shop', 'other'].map((id) => ({
    'schema-version': '1.0.0' as const,
    id,
    title: id,
    description: '',
    type: 'stand-alone' as const,
    screen: { type: 'grid' as const, grid: { rows: 12, columns: 16 } },
    components: [],
  }))

  return {
    revision,
    game: {
      'schema-version': '1.0.0',
      id: 'test',
      title: 'Game',
      description: '',
      version: '1',
      scenes: ['shop', 'other'],
    },
    scenes,
    diagnostics: [],
  }
}

function panel(
  choices: ProjectChoice[] = [
    { path: '', title: 'Root game' },
    { path: 'basic', title: 'Basic game' },
  ],
  recoveryStorage?: EditorDraftStorage,
) {
  const controls = new Map<string, Control>()

  const control = (id: string) => {
    let result = controls.get(id)

    if (!result) {
      result = new Control(id)
      result.hidden = [
        'project-create-controls',
        'project-recover-controls',
        'project-duplicate-controls',
        'project-rename-controls',
        'project-trash-controls',
      ].includes(id)
      controls.set(id, result)
    }

    return result
  }

  let latest: ProjectView | undefined = project('one')
  const requests: CommandRequest[] = []
  const creations: CreateProjectRequest[] = []
  const duplications: DuplicateProjectRequest[] = []
  const historyRequests: HistoryRequest[] = []
  const managementRequests: unknown[] = []
  let deleted: DeletedProject[] = []
  let managementResponse: (() => Promise<Response>) | undefined
  const inspections: string[] = []
  let createResponse: (() => Promise<Response>) | undefined
  let duplicateResponse: (() => Promise<Response>) | undefined
  let applyResponse: (() => Promise<Response>) | undefined
  const onProjectChange = vi.fn<(path: string) => void>()
  const confirmDiscardDrafts = vi.fn(() => false)
  const confirmDelete = vi.fn(() => false)
  const onProjectClose = vi.fn()
  let localization = editorLocalization()
  let languageChanged = () => {}

  const root = {
    querySelector: (selector: string) =>
      ['#assets-panel', '#project-tree'].includes(selector) ? null : control(selector.slice(1)),
    querySelectorAll: () =>
      [...controls.values()].filter((node) => node.attributes.has('data-editor-draft')),
    ownerDocument: { createElement: () => new Control('option'), defaultView: new EventTarget() },
  }

  const fetcher: typeof fetch = async (url, init) => {
    if (url === '/api/editor/projects/trash') return Response.json({ projects: deleted })

    if (
      [
        '/api/editor/projects/rename',
        '/api/editor/projects/delete',
        '/api/editor/projects/restore',
      ].some((path) => path === url)
    ) {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON management request')
      const body = JSON.parse(init.body)

      const request =
        url === '/api/editor/projects/rename'
          ? renameProjectRequestSchema.parse(body)
          : url === '/api/editor/projects/delete'
            ? deleteProjectRequestSchema.parse(body)
            : restoreProjectRequestSchema.parse(body)

      managementRequests.push(request)

      if (managementResponse) return managementResponse()

      if (url === '/api/editor/projects/delete') {
        deleted = [
          {
            trashId: 'f108487a-40de-45f2-98ac-33f906c4e234',
            path: body.path,
            title: latest?.game?.title ?? '',
            revision: latest!.revision,
            deletedAt: '2026-11-14T00:00:00.000Z',
          },
        ]
        latest = undefined

        return Response.json(deleted[0])
      }

      latest ??= project('restored')

      if (body.title) latest.game!.title = body.title
      const path = body.destination ?? body.folderName ?? body.path

      if (url === '/api/editor/projects/restore') deleted = []

      return Response.json({
        ...latest,
        path,
        previousPath: body.path ?? 'basic',
        storageKey: 'basic',
      })
    }

    if (typeof url === 'string' && url.startsWith('/api/editor/project?')) inspections.push(url)

    if (url === '/api/editor/projects/duplicate') {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON duplication request')
      const request = duplicateProjectRequestSchema.parse(JSON.parse(init.body))
      duplications.push(request)

      if (duplicateResponse) return duplicateResponse()
      latest = project('duplicated')
      latest.game!.id = request.destination
      latest.game!.title = request.title
      choices.push({ path: request.destination, title: request.title })

      return Response.json(latest, { status: 201 })
    }

    if (url === '/api/editor/history') {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON history request')
      historyRequests.push(historyRequestSchema.parse(JSON.parse(init.body)))

      return Response.json(latest)
    }

    if (url === '/api/editor/projects') {
      if (init?.method !== 'POST') return Response.json({ projects: choices })

      if (typeof init.body !== 'string') throw new Error('Expected JSON')
      const request = createProjectRequestSchema.parse(JSON.parse(init.body))
      creations.push(request)

      if (createResponse) return createResponse()
      latest = project('created')
      latest.game!.title = request.title
      latest.game!.id = request.path
      choices.push({ path: request.path, title: request.title })

      return Response.json(latest, { status: 201 })
    }

    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request body')
      requests.push(commandRequestSchema.parse(JSON.parse(init.body)))

      if (applyResponse) return applyResponse()
    }

    if (!latest) throw new Error('Project could not be loaded')

    return new Response(JSON.stringify(latest))
  }

  const binding = bindProjectPanel(
    // @ts-expect-error -- Deliberately partial DOM fixture supplies only the query and control operations used by the panel.
    root,
    fetcher,
    (key, values) => localization.t(key, values),
    (listener) => {
      languageChanged = listener

      return () => {
        languageChanged = () => {}
      }
    },
    {
      onProjectChange,
      onProjectClose,
      confirmDiscardDrafts,
      confirmDelete,
      draftStorage: () => recoveryStorage,
    },
  )

  const submitProject = async (path?: string) => {
    await vi.waitFor(() => expect(control('editor-load').disabled).toBe(false))

    if (path !== undefined) control('editor-folder').value = path

    control('project-open-controls').requestSubmit()
  }

  return {
    control,
    requests,
    inspections,
    historyRequests,
    managementRequests,
    confirmDelete,
    onProjectClose,
    setManagementResponse: (response?: () => Promise<Response>) => {
      managementResponse = response
    },
    window: root.ownerDocument.defaultView,
    creations,
    duplications,
    onProjectChange,
    confirmDiscardDrafts,
    submitProject,
    dispose: () => binding.dispose(),
    hasDrafts: () => binding.hasDrafts(),
    setLanguage: (language: string) => {
      localization = editorLocalization([language])
      languageChanged()
    },
    setLatest: (view: ProjectView | undefined) => {
      latest = view
    },
    setCreateResponse: (response?: () => Promise<Response>) => {
      createResponse = response
    },
    setDuplicateResponse: (response?: () => Promise<Response>) => {
      duplicateResponse = response
    },
    setApplyResponse: (response?: () => Promise<Response>) => {
      applyResponse = response
    },
  }
}

describe('project panel form reconciliation', () => {
  it('renames the open project and updates its picker and preview namespace', async () => {
    const ui = panel()

    try {
      await ui.submitProject('basic')
      await vi.waitFor(() => expect(ui.control('project-rename-toggle').disabled).toBe(false))
      ui.control('project-rename-toggle').fire('click')
      ui.control('project-rename-title').value = 'Renamed'
      ui.control('project-rename-folder').value = 'renamed'
      ui.control('project-rename-controls').fire('submit')
      await vi.waitFor(() =>
        expect(ui.onProjectChange).toHaveBeenLastCalledWith('renamed', 'basic'),
      )
      expect(ui.managementRequests).toEqual([
        { path: 'basic', expectedRevision: 'one', title: 'Renamed', folderName: 'renamed' },
      ])
      expect(ui.control('editor-folder').children.map(({ value }) => value)).not.toContain('basic')
      expect(ui.control('editor-title').value).toBe('Renamed')
      expect(ui.control('project-rename-controls').hidden).toBe(true)
    } finally {
      ui.dispose()
    }
  })
  it('requires draft and delete confirmation, closes the deleted project, then restores it', async () => {
    const ui = panel()

    try {
      await ui.submitProject('basic')
      await vi.waitFor(() => expect(ui.control('project-delete').disabled).toBe(false))
      ui.control('project-delete').fire('click')
      expect(ui.managementRequests).toEqual([])
      ui.confirmDelete.mockReturnValue(true)
      ui.control('editor-title').value = 'Unsaved'
      ui.control('editor-metadata').fire('input')
      ui.control('project-delete').fire('click')
      expect(ui.managementRequests).toEqual([])
      ui.confirmDiscardDrafts.mockReturnValue(true)
      ui.control('project-delete').fire('click')
      await vi.waitFor(() => expect(ui.onProjectClose).toHaveBeenCalledOnce())
      expect(ui.hasDrafts()).toBe(false)
      expect(ui.control('editor-workspace').hidden).toBe(true)
      expect(ui.control('project-open-controls').hidden).toBe(false)
      expect(ui.control('editor-folder').children.map(({ value }) => value)).toContain('')
      await vi.waitFor(() => expect(ui.control('project-restore').disabled).toBe(false))
      ui.control('project-restore-folder').value = 'recovered'
      ui.control('project-restore').fire('click')
      await vi.waitFor(() =>
        expect(ui.onProjectChange).toHaveBeenLastCalledWith('recovered', 'basic'),
      )
      expect(ui.control('editor-workspace').hidden).toBe(false)
    } finally {
      ui.dispose()
    }
  })
  it('preserves rename drafts and the current project on failure', async () => {
    const ui = panel()

    try {
      await ui.submitProject('basic')
      await vi.waitFor(() => expect(ui.control('project-rename-toggle').disabled).toBe(false))
      ui.control('project-rename-toggle').fire('click')
      ui.control('project-rename-folder').value = 'occupied'
      ui.setManagementResponse(async () =>
        Response.json({ error: 'Folder occupied', diagnostics: [] }, { status: 409 }),
      )
      ui.control('project-rename-controls').fire('submit')
      await vi.waitFor(() =>
        expect(ui.control('project-management-feedback').textContent).toBe('Folder occupied'),
      )
      expect(ui.control('project-rename-folder').value).toBe('occupied')
      expect(ui.control('project-rename-controls').hidden).toBe(false)
      expect(ui.onProjectChange).toHaveBeenLastCalledWith('basic')
    } finally {
      ui.dispose()
    }
  })
  it('duplicates the open saved project with a new title and folder and opens the copy', async () => {
    const ui = panel()

    try {
      expect(ui.control('project-duplicate-toggle').disabled).toBe(true)
      await ui.submitProject('basic')
      await vi.waitFor(() => expect(ui.control('project-duplicate-toggle').disabled).toBe(false))
      ui.control('project-open-toggle').fire('click')
      ui.control('project-duplicate-toggle').fire('click')
      expect(ui.control('project-copy-title').value).toBe('Copy of Game')
      expect(ui.control('project-copy-folder').value).toBe('test-copy')
      ui.control('project-copy-title').value = '  New adventure  '
      ui.control('project-copy-folder').value = '../outside'
      ui.control('project-duplicate-controls').fire('submit')
      expect(ui.duplications).toEqual([])
      expect(ui.control('project-duplicate-error').hidden).toBe(false)
      ui.control('project-copy-folder').value = 'new-adventure'
      ui.setLanguage('nl')
      expect(ui.control('project-copy-title').value).toBe('  New adventure  ')
      expect(ui.control('project-duplicate-submit').textContent).toBe('Project dupliceren')
      ui.control('project-duplicate-controls').fire('submit')
      await vi.waitFor(() => expect(ui.onProjectChange).toHaveBeenLastCalledWith('new-adventure'))
      expect(ui.duplications).toEqual([
        {
          path: 'basic',
          destination: 'new-adventure',
          expectedRevision: 'one',
          title: 'New adventure',
        },
      ])
      expect(ui.control('project-duplicate-controls').hidden).toBe(true)
      expect(ui.control('editor-folder').value).toBe('new-adventure')
      expect(ui.control('editor-title').value).toBe('New adventure')
      expect(ui.control('editor-folder').children.map(({ value }) => value)).toContain('basic')
    } finally {
      ui.dispose()
    }
  })

  it('preserves the source and drafts when duplication is cancelled or fails, then permits retry', async () => {
    const ui = panel()

    try {
      await ui.submitProject('basic')
      await vi.waitFor(() => expect(ui.control('scene-title').value).toBe('shop'))
      ui.control('scene-title').value = 'Unsaved scene'
      ui.control('scene-metadata').fire('input')
      ui.control('project-open-toggle').fire('click')
      ui.control('project-duplicate-toggle').fire('click')
      ui.control('project-copy-folder').value = 'copy'
      ui.control('project-copy-title').value = 'Copy'
      ui.control('project-duplicate-cancel').fire('click')
      expect(ui.duplications).toEqual([])
      ui.control('project-duplicate-toggle').fire('click')
      ui.control('project-duplicate-controls').fire('submit')
      expect(ui.confirmDiscardDrafts).toHaveBeenCalledOnce()
      expect(ui.duplications).toEqual([])
      ui.confirmDiscardDrafts.mockReturnValue(true)
      ui.setDuplicateResponse(async () =>
        Response.json({ code: 'project_exists', error: 'Folder exists' }, { status: 409 }),
      )
      ui.control('project-duplicate-controls').fire('submit')
      await vi.waitFor(() =>
        expect(ui.control('project-duplicate-error').textContent).toBe('Folder exists'),
      )
      expect(ui.control('scene-title').value).toBe('Unsaved scene')
      expect(ui.control('project-copy-folder').value).toBe('copy')
      expect(ui.control('project-duplicate-controls').hidden).toBe(false)
      expect(ui.onProjectChange.mock.calls).toEqual([['basic']])
      ui.setDuplicateResponse()
      ui.control('project-duplicate-controls').fire('submit')
      await vi.waitFor(() => expect(ui.onProjectChange).toHaveBeenLastCalledWith('copy'))
    } finally {
      ui.dispose()
    }
  })

  it('sends one duplication request while pending and ignores late UI updates after disposal', async () => {
    const ui = panel()
    let finish!: (response: Response) => void

    try {
      await ui.submitProject('basic')
      await vi.waitFor(() => expect(ui.control('project-duplicate-toggle').disabled).toBe(false))
      ui.control('project-duplicate-toggle').fire('click')
      ui.setDuplicateResponse(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      ui.control('project-duplicate-controls').fire('submit')
      ui.control('project-duplicate-controls').fire('submit')
      expect(ui.duplications).toHaveLength(1)
      expect(ui.control('project-duplicate-fields').disabled).toBe(true)
      expect(ui.control('project-duplicate-submit').textContent).toBe('Duplicating…')
      ui.dispose()
      finish(Response.json(project('duplicated'), { status: 201 }))
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      expect(ui.onProjectChange.mock.calls).toEqual([['basic']])
    } finally {
      ui.dispose()
    }
  })

  it('opens an unlisted recovery folder or workspace root even when the project list is empty', async () => {
    const ui = panel([])

    try {
      await vi.waitFor(() => expect(ui.control('editor-load').disabled).toBe(true))
      expect(ui.control('project-recover-toggle').disabled).toBe(false)
      ui.control('project-recover-toggle').fire('click')
      expect(ui.control('project-recover-controls').hidden).toBe(false)
      ui.control('project-recover-folder').value = ' nested/Lost game/ '
      ui.setLatest({
        revision: 'missing',
        game: null,
        scenes: [],
        diagnostics: [
          { code: 'missing_file', file: 'game.json', path: [], message: 'Missing manifest' },
        ],
        repairFiles: { 'game.json': null },
      })
      ui.control('project-recover-controls').fire('submit')
      await vi.waitFor(() =>
        expect(ui.inspections).toEqual(['/api/editor/project?path=nested%2FLost+game']),
      )
      await vi.waitFor(() => expect(ui.control('project-recover-controls').hidden).toBe(true))
      expect(ui.control('editor-error').textContent).toContain('Missing manifest')
      expect(ui.control('editor-fields').disabled).toBe(true)
      ui.control('project-open-toggle').fire('click')
      ui.control('project-recover-toggle').fire('click')
      ui.control('project-recover-folder').value = ''
      ui.control('project-recover-controls').fire('submit')
      await vi.waitFor(() => expect(ui.inspections.at(-1)).toBe('/api/editor/project?path='))
    } finally {
      ui.dispose()
    }
  })

  it('labels recoverable folders and protects existing drafts before opening recovery', async () => {
    const ui = panel([{ path: 'lost', title: '', missingManifest: true }])

    try {
      await vi.waitFor(() =>
        expect(ui.control('editor-folder').children[0]?.textContent).toContain('missing game.json'),
      )
      await ui.submitProject('lost')
      await vi.waitFor(() => expect(ui.control('editor-title').value).toBe('Game'))
      ui.control('editor-title').value = 'Unsaved story'
      ui.control('editor-metadata').fire('input')
      ui.control('project-open-toggle').fire('click')
      ui.control('project-recover-toggle').fire('click')
      ui.control('project-recover-folder').value = 'other'
      ui.control('project-recover-controls').fire('submit')
      expect(ui.confirmDiscardDrafts).toHaveBeenCalledTimes(1)
      expect(ui.inspections).toHaveLength(1)
      expect(ui.control('editor-title').value).toBe('Unsaved story')
      ui.control('project-recover-cancel').fire('click')
      expect(ui.control('project-recover-controls').hidden).toBe(true)
      ui.setLanguage('nl')
      expect(ui.control('editor-folder').children[0]?.textContent).toContain('game.json ontbreekt')
    } finally {
      ui.dispose()
    }
  })

  it('reports invalid recovery paths without making a request', async () => {
    const ui = panel([])

    try {
      await vi.waitFor(() => expect(ui.control('project-create-submit').disabled).toBe(false))
      ui.control('project-recover-toggle').fire('click')
      ui.control('project-recover-folder').value = '../outside'
      ui.control('project-recover-controls').fire('submit')
      expect(ui.inspections).toEqual([])
      expect(ui.control('project-open-feedback').textContent).toContain('no parent directories')
      expect(ui.control('project-recover-controls').hidden).toBe(false)
    } finally {
      ui.dispose()
    }
  })

  it('recovers metadata after reopening, warns while dirty, and clears the recovery copy after saving', async () => {
    const values = new Map<string, string>()

    const storage: EditorDraftStorage = {
      get length() {
        return values.size
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    }

    const first = panel(undefined, storage)
    await first.submitProject()
    await vi.waitFor(() => expect(first.control('editor-title').value).toBe('Game'))
    expect(first.hasDrafts()).toBe(false)
    first.control('editor-title').value = 'Recovered title'
    first.control('editor-metadata').fire('input')
    expect(first.hasDrafts()).toBe(true)
    const close = new Event('beforeunload', { cancelable: true })
    first.window.dispatchEvent(close)
    expect(close.defaultPrevented).toBe(true)
    first.dispose()
    expect(values.size).toBe(1)

    const second = panel(undefined, storage)

    try {
      await second.submitProject()
      await vi.waitFor(() => expect(second.control('editor-title').value).toBe('Game'))
      await vi.waitFor(() => expect(second.control('draft-restore').hidden).toBe(false))
      second.control('draft-restore').fire('click')
      expect(second.hasDrafts()).toBe(true)
      expect(second.control('editor-title').value).toBe('Recovered title')
      expect(second.requests).toEqual([])
      second.setLatest({
        ...project('two'),
        game: { ...project('two').game!, title: 'Recovered title' },
      })
      second.control('editor-metadata').fire('submit')
      await vi.waitFor(() => expect(second.requests).toHaveLength(1))
      await vi.waitFor(() =>
        expect(second.control('editor-status').textContent).toContain('Recovered title'),
      )
      const clean = new Event('beforeunload', { cancelable: true })
      second.window.dispatchEvent(clean)
      expect(clean.defaultPrevented).toBe(false)
      expect(second.hasDrafts()).toBe(false)
      expect(values.size).toBe(0)
    } finally {
      second.dispose()
    }
  })

  function localized(revision: string) {
    const view = project(revision)
    view.game!.languages = { default: 'en', available: ['en', 'nl'] }
    view.translations = {
      'game.title': 'Translated game',
      'game.description': 'Game description',
      'scene.title': 'Translated scene',
      'scene.description': '',
    }
    view.translationKeys = Object.keys(view.translations)
    view.languageCatalogs = {
      en: view.translations,
      nl: { 'game.title': 'Vertaald spel', 'scene.title': 'Vertaalde scene' },
    }

    return view
  }

  it.each(['editor', 'scene'])(
    'rejects empty metadata title translations in the %s form',
    async (prefix) => {
      const ui = panel()
      const source = localized('one')
      source.languageCatalogs!.nl!['game.title'] = ''
      ui.setLatest(source)

      try {
        await ui.submitProject()
        await vi.waitFor(() => expect(ui.control('scene-title').value).toBe('shop'))

        for (const key of ['game.title', 'scene.description']) {
          ui.control(`${prefix}-title-key`).value = key
          ui.control(`${prefix}-title-key`).fire('input')
          ui.control(`${prefix}-metadata`).fire('submit')
          expect(ui.requests).toHaveLength(0)
          expect(ui.control('editor-error').textContent).toContain(
            'Title translations must not be empty',
          )
          expect(ui.control(`${prefix}-title-key`).value).toBe(key)
        }
      } finally {
        ui.dispose()
      }
    },
  )

  it('assigns and clears title and description keys for projects and scenes with previews and optional literal titles', async () => {
    const ui = panel()
    ui.setLatest(localized('one'))

    try {
      await ui.submitProject()
      await vi.waitFor(() => expect(ui.control('scene-title').value).toBe('shop'))
      expect(ui.control('editor-metadata-keys').children.map((option) => option.value)).toContain(
        'game.title',
      )
      ui.control('editor-title-key').value = 'game.title'
      ui.control('editor-title-key').fire('input')
      ui.control('editor-description-key').value = 'game.description'
      ui.control('editor-description-key').fire('input')
      ui.control('editor-title').value = ''
      expect(ui.control('editor-title').required).toBe(false)
      expect(ui.control('editor-title-key-preview').textContent).toBe('Translated game')
      const saved = localized('two')
      Object.assign(saved.game!, {
        title: '',
        titleKey: 'game.title',
        descriptionKey: 'game.description',
      })
      ui.setLatest(saved)
      ui.control('editor-metadata').fire('submit')
      await vi.waitFor(() =>
        expect(ui.control('project-title').textContent).toBe('Translated game'),
      )
      expect(ui.requests[0]?.command).toMatchObject({
        type: 'game.updateMetadata',
        title: '',
        titleKey: 'game.title',
        descriptionKey: 'game.description',
      })
      ui.control('scene-title-key').value = 'scene.title'
      ui.control('scene-title-key').fire('input')
      ui.control('scene-description-key').value = 'scene.description'
      ui.control('scene-description-key').fire('input')
      ui.control('scene-title').value = ''
      expect(ui.control('scene-title').required).toBe(false)
      expect(ui.control('scene-description-key-preview').textContent).toBe('(empty text)')
      const sceneSaved = structuredClone(saved)
      sceneSaved.revision = 'three'
      Object.assign(sceneSaved.scenes[0]!, {
        title: '',
        titleKey: 'scene.title',
        descriptionKey: 'scene.description',
      })
      ui.setLatest(sceneSaved)
      ui.control('scene-metadata').fire('submit')
      await vi.waitFor(() => expect(ui.requests).toHaveLength(2))
      await vi.waitFor(() => expect(ui.control('editor-reload').disabled).toBe(false))
      expect(ui.requests[1]?.command).toMatchObject({
        type: 'scene.updateMetadata',
        sceneId: 'shop',
        titleKey: 'scene.title',
        descriptionKey: 'scene.description',
      })
      expect(ui.control('editor-scenes').children[0]?.textContent).toBe('Translated scene (shop)')

      for (const prefix of ['editor', 'scene']) {
        ui.control(`${prefix}-title-key`).value = ''
        ui.control(`${prefix}-title-key`).fire('input')
        ui.control(`${prefix}-description-key`).value = ''
        ui.control(`${prefix}-description-key`).fire('input')
        ui.control(`${prefix}-title`).value = 'Literal fallback'
        expect(ui.control(`${prefix}-title`).required).toBe(true)
        ui.control(`${prefix}-metadata`).fire('submit')
        await vi.waitFor(() => expect(ui.control('editor-reload').disabled).toBe(false))
      }

      expect(ui.requests.slice(2).map(({ command }) => command)).toEqual([
        expect.objectContaining({
          type: 'game.updateMetadata',
          titleKey: null,
          descriptionKey: null,
        }),
        expect.objectContaining({
          type: 'scene.updateMetadata',
          titleKey: null,
          descriptionKey: null,
        }),
      ])
    } finally {
      ui.dispose()
    }
  })

  it('blocks unknown metadata keys and preserves key drafts through conflicts, unrelated saves and catalog refreshes', async () => {
    const ui = panel()
    ui.setLatest(localized('one'))

    try {
      await ui.submitProject()
      await vi.waitFor(() => expect(ui.control('editor-title').value).toBe('Game'))
      ui.control('editor-title-key').value = 'missing.title'
      ui.control('editor-title-key').fire('input')
      ui.control('editor-metadata').fire('submit')
      expect(ui.requests).toHaveLength(0)
      expect(ui.control('editor-title-key').attributes.get('aria-invalid')).toBe('true')
      expect(ui.control('editor-error').textContent).toContain('Unknown translation key')
      ui.control('editor-title-key').value = 'game.title'
      ui.control('editor-title-key').fire('input')
      ui.setApplyResponse(async () =>
        Response.json({ code: 'revision_conflict', error: 'Conflict' }, { status: 409 }),
      )
      ui.control('editor-metadata').fire('submit')
      await vi.waitFor(() => expect(ui.control('editor-error').textContent).toBe('Conflict'))
      expect(ui.control('editor-title-key').value).toBe('game.title')
      expect(ui.control('editor-title').required).toBe(false)
      ui.setApplyResponse()
      ui.setLatest(localized('two'))
      ui.control('scene-description').value = 'Unrelated scene draft'
      ui.control('scene-metadata').fire('input')
      ui.control('scene-metadata').fire('submit')
      await vi.waitFor(() => expect(ui.requests).toHaveLength(2))
      await vi.waitFor(() => expect(ui.control('editor-reload').disabled).toBe(false))
      expect(ui.control('editor-title-key').value).toBe('game.title')
      ui.control('editor-title-key').value = 'new.title'
      ui.control('editor-title-key').fire('input')
      const updated = localized('three')
      updated.translationKeys!.push('new.title')
      updated.translations!['new.title'] = 'Newly authored title'
      updated.languageCatalogs!.en!['new.title'] = 'Newly authored title'
      ui.setLatest(updated)
      ui.control('editor-reload').fire('click')
      await vi.waitFor(() =>
        expect(ui.control('editor-title-key-preview').textContent).toBe('Newly authored title'),
      )
      expect(ui.control('editor-title-key').value).toBe('new.title')
      expect(ui.control('editor-title-key').attributes.get('aria-invalid')).toBe('false')
      ui.setLanguage('nl')
      expect(ui.control('editor-title-key').value).toBe('new.title')
      ui.control('editor-metadata').fire('submit')
      await vi.waitFor(() => expect(ui.requests).toHaveLength(3))
      expect(ui.requests[2]?.command).toMatchObject({ titleKey: 'new.title' })
    } finally {
      ui.dispose()
    }
  })
  it('refreshes preview for saved revisions and clean external changes without restarting for unchanged reads or drafts', async () => {
    const { control, setLatest, submitProject, onProjectChange, window, dispose, setLanguage } =
      panel()

    try {
      await submitProject('basic')
      await vi.waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1))
      setLatest(project('saved'))
      control('editor-title').value = 'Changed'
      control('editor-metadata').fire('input')
      control('editor-metadata').fire('submit')
      await vi.waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(2))
      control('editor-reload').fire('click')
      await vi.waitFor(() => expect(control('editor-reload').disabled).toBe(false))
      setLanguage('nl')
      expect(onProjectChange).toHaveBeenCalledTimes(2)
      setLatest(project('external'))
      window.dispatchEvent(new Event('focus'))
      await vi.waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(3))
      control('scene-title').value = 'Draft'
      control('scene-metadata').fire('input')
      setLatest(project('newer'))
      window.dispatchEvent(new Event('focus'))
      await vi.waitFor(() => expect(control('editor-status').textContent).toContain('gewijzigd'))
      expect(onProjectChange).toHaveBeenCalledTimes(3)
    } finally {
      dispose()
    }
  })

  it('undoes and redoes saved changes, refreshes fields and preview, and keeps toolbar availability in sync', async () => {
    const { control, setLatest, submitProject, historyRequests, onProjectChange, dispose } = panel()

    const saved = {
      ...project('saved'),
      history: { canUndo: true, canRedo: false, undoLabel: 'Updated game metadata' },
    }

    saved.game!.title = 'Saved title'
    setLatest(saved)

    try {
      await submitProject('basic')
      await vi.waitFor(() => expect(control('editor-undo').disabled).toBe(false))
      expect(control('editor-redo').disabled).toBe(true)
      const original = { ...project('original'), history: { canUndo: false, canRedo: true } }
      setLatest(original)
      control('editor-undo').fire('click')
      await vi.waitFor(() => expect(control('editor-title').value).toBe('Game'))
      expect(historyRequests).toEqual([
        { path: 'basic', expectedRevision: 'saved', direction: 'undo' },
      ])
      expect(control('editor-undo').disabled).toBe(true)
      expect(control('editor-redo').disabled).toBe(false)
      expect(onProjectChange.mock.calls).toEqual([['basic'], ['basic']])
      setLatest(saved)
      control('editor-redo').fire('click')
      await vi.waitFor(() => expect(control('editor-title').value).toBe('Saved title'))
      expect(historyRequests[1]).toEqual({
        path: 'basic',
        expectedRevision: 'original',
        direction: 'redo',
      })
      expect(onProjectChange.mock.calls).toHaveLength(3)
    } finally {
      dispose()
    }
  })

  it('preserves unsaved form edits when undo is requested', async () => {
    const { control, setLatest, submitProject, historyRequests, dispose } = panel()
    setLatest({ ...project('saved'), history: { canUndo: true, canRedo: false } })

    try {
      await submitProject('basic')
      await vi.waitFor(() => expect(control('editor-undo').disabled).toBe(false))
      control('editor-title').value = 'Unsaved title'
      control('editor-metadata').fire('input')
      control('editor-undo').fire('click')
      expect(historyRequests).toEqual([])
      expect(control('editor-title').value).toBe('Unsaved title')
      expect(control('editor-error').textContent).toContain('Save or discard')
    } finally {
      dispose()
    }
  })

  it('supports history shortcuts outside text fields and removes them on disposal', async () => {
    const { control, setLatest, submitProject, historyRequests, window, dispose } = panel()
    setLatest({ ...project('saved'), history: { canUndo: true, canRedo: true } })

    const key = (value: string, shiftKey = false, editable = false) => {
      const event = new Event('keydown', { cancelable: true })
      Object.assign(event, { key: value, ctrlKey: true, metaKey: false, shiftKey, altKey: false })

      if (editable) Object.defineProperty(event, 'target', { value: { closest: () => ({}) } })
      window.dispatchEvent(event)

      return event
    }

    try {
      await submitProject('basic')
      await vi.waitFor(() => expect(control('editor-undo').disabled).toBe(false))
      expect(key('z', false, true).defaultPrevented).toBe(false)
      expect(historyRequests).toEqual([])
      expect(key('z').defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(historyRequests).toHaveLength(1))
      await vi.waitFor(() => expect(control('editor-redo').disabled).toBe(false))
      key('z', true)
      await vi.waitFor(() => expect(historyRequests).toHaveLength(2))
      await vi.waitFor(() => expect(control('editor-redo').disabled).toBe(false))
      key('y')
      await vi.waitFor(() => expect(historyRequests).toHaveLength(3))
      expect(historyRequests.map(({ direction }) => direction)).toEqual(['undo', 'redo', 'redo'])
    } finally {
      dispose()
    }

    key('z')
    expect(historyRequests).toHaveLength(3)
  })

  it('creates and opens a project from an empty workspace and preserves form values across language changes', async () => {
    const { control, creations, onProjectChange, setLanguage, dispose } = panel([])

    try {
      await vi.waitFor(() =>
        expect(control('project-open-feedback').textContent).toContain('No games found'),
      )
      expect(control('editor-load').disabled).toBe(true)
      control('project-new-toggle').fire('click')
      expect(control('project-create-controls').hidden).toBe(false)
      control('project-new-title').value = '  New adventure  '
      control('project-new-folder').value = '../outside'
      control('project-create-controls').fire('submit')
      expect(creations).toEqual([])
      expect(control('project-create-error').hidden).toBe(false)
      control('project-new-folder').value = 'new-adventure'
      control('project-new-description').value = 'A story'
      setLanguage('nl')
      expect(control('project-new-title').value).toBe('  New adventure  ')
      expect(control('project-create-submit').textContent).toBe('Project maken')
      control('project-create-controls').fire('submit')
      expect(control('project-create-fields').disabled).toBe(true)
      await vi.waitFor(() => expect(onProjectChange.mock.calls).toEqual([['new-adventure']]))
      expect(creations).toEqual([
        { path: 'new-adventure', title: 'New adventure', description: 'A story' },
      ])
      expect(control('project-create-controls').hidden).toBe(true)
      expect(control('editor-workspace').hidden).toBe(false)
      expect(control('editor-folder').value).toBe('new-adventure')
      expect(control('editor-folder').children.map(({ value }) => value)).toEqual(['new-adventure'])
      expect(control('editor-title').value).toBe('New adventure')
    } finally {
      dispose()
    }
  })

  it('preserves the open project and both sets of entries when creation is cancelled or fails, then permits retry', async () => {
    const {
      control,
      submitProject,
      creations,
      confirmDiscardDrafts,
      setCreateResponse,
      onProjectChange,
      dispose,
    } = panel()

    try {
      await submitProject()
      await vi.waitFor(() => expect(control('scene-title').value).toBe('shop'))
      control('scene-title').value = 'Unsaved scene'
      control('scene-metadata').fire('input')
      control('project-open-toggle').fire('click')
      await vi.waitFor(() => expect(control('project-create-submit').disabled).toBe(false))
      control('project-new-toggle').fire('click')
      control('project-new-title').value = 'New game'
      control('project-new-folder').value = 'new-game'
      control('project-new-description').value = ''
      control('project-create-controls').fire('submit')
      expect(confirmDiscardDrafts).toHaveBeenCalledOnce()
      expect(creations).toEqual([])
      confirmDiscardDrafts.mockReturnValue(true)
      setCreateResponse(async () =>
        Response.json({ error: 'Folder exists', code: 'project_exists' }, { status: 409 }),
      )
      control('project-create-controls').fire('submit')
      await vi.waitFor(() =>
        expect(control('project-create-error').textContent).toBe('Folder exists'),
      )
      expect(control('scene-title').value).toBe('Unsaved scene')
      expect(control('project-new-title').value).toBe('New game')
      expect(control('project-create-controls').hidden).toBe(false)
      expect(onProjectChange.mock.calls).toEqual([['']])
      setCreateResponse()
      control('project-create-controls').fire('submit')
      await vi.waitFor(() => expect(onProjectChange.mock.calls).toEqual([[''], ['new-game']]))
      expect(control('editor-scenes').disabled).toBe(false)
    } finally {
      dispose()
    }
  })

  it('makes no request on cancel and prevents duplicate creation while a request is pending', async () => {
    const { control, creations, setCreateResponse, onProjectChange, dispose } = panel([])
    let finish: (response: Response) => void = () => {}

    try {
      await vi.waitFor(() => expect(control('project-create-submit').disabled).toBe(false))
      control('project-new-toggle').fire('click')
      control('project-create-cancel').fire('click')
      expect(control('project-create-controls').hidden).toBe(true)
      expect(creations).toEqual([])
      control('project-new-toggle').fire('click')
      control('project-new-title').value = 'New game'
      control('project-new-folder').value = 'new-game'
      setCreateResponse(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      control('project-create-controls').fire('submit')
      control('project-create-controls').fire('submit')
      expect(creations).toHaveLength(1)
      expect(control('project-create-submit').disabled).toBe(true)
      finish(Response.json(project('created'), { status: 201 }))
      await vi.waitFor(() => expect(onProjectChange).toHaveBeenCalledWith('new-game'))
    } finally {
      dispose()
    }
  })

  it.each(['', 'basic'])(
    'keeps drafts when opening %j is cancelled and discards them only after confirmation',
    async (path) => {
      const { control, submitProject, setLatest, onProjectChange, confirmDiscardDrafts, dispose } =
        panel()

      try {
        await submitProject()
        await vi.waitFor(() => expect(control('scene-title').value).toBe('shop'))
        expect(confirmDiscardDrafts).not.toHaveBeenCalled()
        control('scene-title').value = 'Unsaved draft'
        control('scene-metadata').fire('input')
        control('project-open-toggle').fire('click')
        setLatest(project('two'))
        await submitProject(path)
        expect(confirmDiscardDrafts).toHaveBeenCalledOnce()
        expect(control('scene-title').value).toBe('Unsaved draft')
        expect(control('editor-scenes').disabled).toBe(true)
        expect(onProjectChange.mock.calls).toEqual([['']])
        expect(control('project-open-controls').hidden).toBe(false)

        confirmDiscardDrafts.mockReturnValue(true)
        await submitProject(path)
        await vi.waitFor(() => expect(control('project-open-controls').hidden).toBe(true))
        expect(confirmDiscardDrafts).toHaveBeenCalledTimes(2)
        expect(control('scene-title').value).toBe('shop')
        expect(control('editor-scenes').disabled).toBe(false)
        expect(onProjectChange.mock.calls).toEqual([[''], [path]])
      } finally {
        dispose()
      }
    },
  )

  it('reports the open project only after a successful change of folder', async () => {
    const { control, onProjectChange, submitProject, setLatest, dispose } = panel()
    const folder = control('editor-folder')
    const load = control('editor-load')

    try {
      await submitProject()
      await vi.waitFor(() => expect(onProjectChange.mock.calls).toEqual([['']]))
      expect(folder.children.map(({ textContent }) => textContent)).toEqual([
        'Root game (workspace root)',
        'Basic game (basic)',
      ])

      setLatest(undefined)
      await submitProject('basic')
      await vi.waitFor(() =>
        expect(control('editor-error').textContent).toBe('Project could not be loaded'),
      )
      expect(onProjectChange.mock.calls).toEqual([['']])

      setLatest(project('two'))
      const enter = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter' })
      folder.dispatchEvent(enter)
      expect(enter.defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(onProjectChange.mock.calls).toEqual([[''], ['basic']]))

      control('editor-reload').fire('click')
      await vi.waitFor(() => expect(load.disabled).toBe(false))
      expect(onProjectChange.mock.calls).toEqual([[''], ['basic']])
    } finally {
      dispose()
    }
  })

  it('keeps folder controls visible on failure and hides them after an explicit open', async () => {
    const { control, submitProject, setLatest, dispose } = panel()
    const openControls = control('project-open-controls')
    const workspace = control('editor-workspace')
    const toggle = control('project-open-toggle')
    const feedback = control('project-open-feedback')

    try {
      setLatest(undefined)
      await submitProject()
      await vi.waitFor(() => expect(feedback.textContent).toBe('Project could not be loaded'))
      expect(openControls.hidden).toBe(false)
      expect(workspace.hidden).toBe(true)
      expect(control('editor-header').hidden).toBe(true)

      setLatest(project('one'))
      await submitProject()
      await vi.waitFor(() => expect(workspace.hidden).toBe(false))
      expect(openControls.hidden).toBe(true)
      expect(control('editor-reload').hidden).toBe(false)
      expect(feedback.hidden).toBe(true)
      expect(toggle.attributes.get('aria-expanded')).toBe('false')

      toggle.fire('click')
      expect(openControls.hidden).toBe(false)
      expect(toggle.attributes.get('aria-expanded')).toBe('true')

      control('editor-reload').fire('click')
      await vi.waitFor(() => expect(control('editor-reload').disabled).toBe(false))
      expect(openControls.hidden).toBe(false)

      await submitProject()
      await vi.waitFor(() => expect(openControls.hidden).toBe(true))
    } finally {
      dispose()
    }
  })

  it('preserves unsaved drafts and selection while translating status messages', async () => {
    const { control, requests, submitProject, setLanguage, dispose } = panel()

    try {
      await submitProject()
      await vi.waitFor(() => expect(control('scene-title').value).toBe('shop'))
      control('scene-title').value = 'Unsaved draft'
      control('scene-metadata').fire('input')
      setLanguage('nl')
      expect(control('scene-title').value).toBe('Unsaved draft')
      expect(control('editor-scenes').value).toBe('shop')
      expect(control('editor-scenes').disabled).toBe(true)
      expect(control('editor-status').textContent).toContain('geladen uit')
      expect(requests).toEqual([])
    } finally {
      dispose()
    }
  })

  it('reloads clean forms while preserving only dirty form values', async () => {
    const { control, requests, submitProject, setLatest, dispose } = panel()

    try {
      await submitProject('basic')
      await vi.waitFor(() => expect(control('editor-title').value).toBe('Game'))
      control('scene-rows').value = '22'
      control('scene-layout').fire('input')

      const updated = project('two')
      updated.game!.title = 'Agent title'
      updated.scenes[0]!.title = 'Agent scene'
      updated.scenes[0]!.screen.grid.rows = 30
      setLatest(updated)
      control('editor-reload').fire('click')
      await vi.waitFor(() => expect(control('editor-title').value).toBe('Agent title'))
      expect(control('scene-title').value).toBe('Agent scene')
      expect(control('scene-rows').value).toBe('22')

      control('editor-metadata').fire('submit')
      await vi.waitFor(() => expect(requests).toHaveLength(1))
      expect(requests[0]).toMatchObject({
        expectedRevision: 'two',
        command: { title: 'Agent title' },
      })
      expect(control('scene-rows').value).toBe('22')
    } finally {
      dispose()
    }
  })

  it('never retargets a removed scene draft to the next scene after reload', async () => {
    const { control, submitProject, setLatest, confirmDiscardDrafts, dispose } = panel()

    try {
      await submitProject()
      await vi.waitFor(() => expect(control('scene-title').value).toBe('shop'))
      control('scene-title').value = 'Draft shop'
      control('scene-metadata').fire('input')
      const updated = project('two')
      updated.game!.scenes = ['other']
      updated.scenes = updated.scenes.filter((scene) => scene.id !== 'shop')
      setLatest(updated)
      control('editor-reload').fire('click')
      await vi.waitFor(() =>
        expect(control('editor-status').textContent).toContain('selected scene is unavailable'),
      )
      expect(control('editor-scenes').value).toBe('shop')
      expect(control('scene-title').value).toBe('Draft shop')
      expect(control('scene-metadata').hidden).toBe(true)

      confirmDiscardDrafts.mockReturnValue(true)
      await submitProject()
      await vi.waitFor(() => expect(control('editor-scenes').value).toBe('other'))
      expect(control('scene-title').value).toBe('other')
      expect(control('editor-scenes').disabled).toBe(false)
    } finally {
      dispose()
    }
  })
})
