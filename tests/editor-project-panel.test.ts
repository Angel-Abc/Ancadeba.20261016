import { describe, expect, it, vi } from 'vite-plus/test'
import {
  commandRequestSchema,
  createProjectRequestSchema,
  historyRequestSchema,
  type CommandRequest,
  type CreateProjectRequest,
  type ProjectChoice,
  type ProjectView,
  type HistoryRequest,
} from '@ancadeba/editor-core'
import { bindProjectPanel } from '../apps/editor-ui/src/projectPanel.js'
import { editorLocalization } from '../apps/editor-ui/src/localization.js'

// A small DOM surface for testing form reconciliation without a browser runtime.
class Control extends EventTarget {
  value = ''
  textContent = ''
  disabled = false
  hidden = false
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
) {
  const controls = new Map<string, Control>()

  const control = (id: string) => {
    let result = controls.get(id)

    if (!result) {
      result = new Control(id)
      result.hidden = id === 'project-create-controls'
      controls.set(id, result)
    }

    return result
  }

  let latest: ProjectView | undefined = project('one')
  const requests: CommandRequest[] = []
  const creations: CreateProjectRequest[] = []
  const historyRequests: HistoryRequest[] = []
  let createResponse: (() => Promise<Response>) | undefined
  const onProjectChange = vi.fn<(path: string) => void>()
  const confirmDiscardDrafts = vi.fn(() => false)
  let localization = editorLocalization()
  let languageChanged = () => {}

  const root = {
    querySelector: (selector: string) =>
      ['#assets-panel', '#project-tree'].includes(selector) ? null : control(selector.slice(1)),
    ownerDocument: { createElement: () => new Control('option'), defaultView: new EventTarget() },
  }

  const fetcher: typeof fetch = async (url, init) => {
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
    }

    if (!latest) throw new Error('Project could not be loaded')

    return new Response(JSON.stringify(latest))
  }

  const dispose = bindProjectPanel(
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
    { onProjectChange, confirmDiscardDrafts },
  )

  const submitProject = async (path?: string) => {
    await vi.waitFor(() => expect(control('editor-load').disabled).toBe(false))

    if (path !== undefined) control('editor-folder').value = path

    control('project-open-controls').requestSubmit()
  }

  return {
    control,
    requests,
    historyRequests,
    window: root.ownerDocument.defaultView,
    creations,
    onProjectChange,
    confirmDiscardDrafts,
    submitProject,
    dispose,
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
  }
}

describe('project panel form reconciliation', () => {
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
