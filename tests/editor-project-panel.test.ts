import { describe, expect, it, vi } from 'vite-plus/test'
import { commandRequestSchema, type CommandRequest, type ProjectView } from '@ancadeba/editor-core'
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

function panel() {
  const controls = new Map<string, Control>()

  const control = (id: string) => {
    let result = controls.get(id)

    if (!result) {
      result = new Control(id)
      controls.set(id, result)
    }

    return result
  }

  let latest: ProjectView | undefined = project('one')
  const requests: CommandRequest[] = []
  const onProjectChange = vi.fn<(path: string) => void>()
  let localization = editorLocalization()
  let languageChanged = () => {}

  const root = {
    querySelector: (selector: string) =>
      ['#assets-panel', '#project-tree'].includes(selector) ? null : control(selector.slice(1)),
    ownerDocument: { createElement: () => new Control('option'), defaultView: new EventTarget() },
  }

  const fetcher: typeof fetch = async (url, init) => {
    if (url === '/api/editor/projects') {
      return Response.json({
        projects: [
          { path: '', title: 'Root game' },
          { path: 'basic', title: 'Basic game' },
        ],
      })
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
    { onProjectChange },
  )

  const submitProject = async (path?: string) => {
    await vi.waitFor(() => expect(control('editor-load').disabled).toBe(false))

    if (path !== undefined) control('editor-folder').value = path

    control('project-open-controls').requestSubmit()
  }

  return {
    control,
    requests,
    onProjectChange,
    submitProject,
    dispose,
    setLanguage: (language: string) => {
      localization = editorLocalization([language])
      languageChanged()
    },
    setLatest: (view: ProjectView | undefined) => {
      latest = view
    },
  }
}

describe('project panel form reconciliation', () => {
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
    const { control, submitProject, setLatest, dispose } = panel()

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

      await submitProject()
      await vi.waitFor(() => expect(control('editor-scenes').value).toBe('other'))
      expect(control('scene-title').value).toBe('other')
      expect(control('editor-scenes').disabled).toBe(false)
    } finally {
      dispose()
    }
  })
})
