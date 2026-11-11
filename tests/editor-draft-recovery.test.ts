import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createStarterProject, inspectProject } from '@ancadeba/editor-core'
import { textComponentSchema } from '@ancadeba/schemas'
import {
  EditorDraftStore,
  type EditorDraft,
  type EditorDraftStorage,
} from '../apps/editor-ui/src/editorDraftStore.js'
import { bindEditorDraftRecovery } from '../apps/editor-ui/src/editorDraftRecovery.js'
import {
  captureEditorDrafts,
  registerEditorDraft,
  restoreEditorDrafts,
} from '../apps/editor-ui/src/editorDraftState.js'
import type { ProjectEditorState } from '../apps/editor-ui/src/projectController.js'

class Storage implements EditorDraftStorage {
  values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

function snapshot(path = 'demo', savedAt = 1): EditorDraft {
  return {
    version: 1,
    path,
    savedAt,
    base: inspectProject({
      revision: 'one',
      documents: createStarterProject({ path: 'demo', title: 'Demo', description: '' }),
    }),
    selection: 'game',
    drafts: { text: { text: 'Unfinished story' } },
  }
}

class Control extends EventTarget {
  hidden = false
  disabled = false
  textContent = ''
  attributes = new Map<string, string>()
  children: Control[] = []
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  querySelectorAll(): Control[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()])
  }
  asElement(): HTMLElement {
    // @ts-expect-error -- The draft registry only uses attributes and descendant enumeration.
    return this
  }
}

function harness(storage = new Storage(), session = 'tab') {
  const controls = new Map(
    ['draft-recovery', 'draft-recovery-message', 'draft-restore', 'draft-discard'].map((id) => [
      id,
      new Control(),
    ]),
  )

  const window = Object.assign(new EventTarget(), { confirm: vi.fn(() => true) })
  const document = Object.assign(new EventTarget(), { defaultView: window, hidden: false })

  const root = Object.assign(new EventTarget(), {
    ownerDocument: document,
    querySelector: (selector: string) => controls.get(selector.slice(1)),
  })

  const store = new EditorDraftStore(() => storage, session)
  let draft = snapshot()
  let dirty = false

  const restore = vi.fn<(value: EditorDraft) => string[]>(() => {
    dirty = true

    return []
  })

  const binding = bindEditorDraftRecovery(
    // @ts-expect-error -- Partial DOM harness supplies events and the recovery banner controls.
    root,
    store,
    (key) => key,
    () => ({ ...draft, savedAt: Date.now() }),
    () => dirty,
    restore,
  )

  const state: ProjectEditorState = {
    path: draft.path,
    view: draft.base,
    busy: false,
    conflict: false,
    changedElsewhere: false,
    error: '',
    lastCommand: null,
    preserveDrafts: false,
  }

  binding.afterRender(state)

  return {
    storage,
    store,
    window,
    document,
    root,
    controls,
    binding,
    restore,
    state,
    dirty(value: boolean) {
      dirty = value
    },
    draft(value: EditorDraft) {
      draft = value
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('local editor draft storage', () => {
  it('isolates projects and tabs, including the workspace root, and retains unfinished numbers', () => {
    const storage = new Storage()
    const first = new EditorDraftStore(() => storage, 'first')
    const second = new EditorDraftStore(() => storage, 'second')
    first.write({ ...snapshot('', 1), drafts: { number: NaN } })
    second.write(snapshot('', 2))
    first.write(snapshot('other', 3))
    expect(storage.length).toBe(3)
    expect(first.latest('')?.draft.savedAt).toBe(2)
    second.clear('')
    expect(first.latest('')?.draft.drafts.number).toBeNaN()
    expect(first.latest('other')?.draft.path).toBe('other')
    expect(first.latest('missing')).toBeUndefined()
  })

  it('ignores damaged and incompatible records without deleting another recovery copy', () => {
    const storage = new Storage()
    const store = new EditorDraftStore(() => storage, 'valid')
    store.write(snapshot())
    storage.setItem('ancadeba.editor.draft.v1:demo:bad', '{')
    storage.setItem(
      'ancadeba.editor.draft.v1:demo:old',
      JSON.stringify({ ...snapshot(), version: 2 }),
    )
    expect(store.latest('demo')?.draft.base.revision).toBe('one')
    expect(storage.length).toBe(3)
  })
})

describe('editor draft model recovery', () => {
  it('restores incomplete model values without applying game validation or accepting damaged structure', () => {
    const root = new Control()

    let draft = textComponentSchema.parse({
      id: 'story',
      type: 'text',
      placement: { row: 1, column: 1 },
      text: 'Original',
    })

    registerEditorDraft(
      root.asElement(),
      'text',
      textComponentSchema,
      () => draft,
      (saved) => {
        draft = saved
      },
    )
    draft.text = 'Unfinished story'
    draft.placement.row = -1
    const captured = structuredClone(captureEditorDrafts(root.asElement()))
    draft.text = 'Lost'
    expect(restoreEditorDrafts(root.asElement(), captured)).toEqual([])
    expect(draft.text).toBe('Unfinished story')
    expect(draft.placement.row).toBe(-1)
    expect(
      restoreEditorDrafts(root.asElement(), {
        text: { model: { ...draft, placement: 'broken' }, fields: [] },
      }),
    ).toEqual(['text'])
    expect(
      restoreEditorDrafts(root.asElement(), {
        text: { model: { ...draft, type: 'button' }, fields: [] },
      }),
    ).toEqual(['text'])
  })

  it('rediscovers child participants rebuilt while restoring their parent', () => {
    const root = new Control()

    const component = textComponentSchema.parse({
      id: 'text',
      type: 'text',
      placement: { row: 1, column: 1 },
    })

    let restoredChild = ''

    const child = () => {
      const result = new Control()
      registerEditorDraft(
        result.asElement(),
        'child',
        textComponentSchema,
        () => ({ ...component, text: 'Recovered child' }),
        (saved) => {
          restoredChild = saved.text
        },
      )

      return result
    }

    root.children = [child()]
    registerEditorDraft(
      root.asElement(),
      'parent',
      textComponentSchema,
      () => component,
      () => {
        root.children = [child()]
      },
    )
    expect(restoreEditorDrafts(root.asElement(), captureEditorDrafts(root.asElement()))).toEqual([])
    expect(restoredChild).toBe('Recovered child')
  })
})

describe('browser draft recovery lifecycle', () => {
  it('checkpoints edits, warns on close or reload, and stops warning after saving or discarding', () => {
    vi.useFakeTimers()
    const ui = harness()
    ui.dirty(true)
    ui.root.dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(250)
    expect(ui.store.latest('demo')?.draft.drafts).toEqual(snapshot().drafts)
    const leave = new Event('beforeunload', { cancelable: true })
    ui.window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    ui.dirty(false)
    ui.binding.afterRender(ui.state)
    vi.advanceTimersByTime(250)
    expect(ui.store.latest('demo')).toBeUndefined()
    const clean = new Event('beforeunload', { cancelable: true })
    ui.window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    ui.binding.dispose()
    ui.dirty(true)
    const disposed = new Event('beforeunload', { cancelable: true })
    ui.window.dispatchEvent(disposed)
    expect(disposed.defaultPrevented).toBe(false)
  })

  it('offers restoration after reopening and transfers only the selected recovery copy', () => {
    const storage = new Storage()
    const old = new EditorDraftStore(() => storage, 'closed')
    old.write(snapshot())
    const ui = harness(storage, 'new')
    expect(ui.controls.get('draft-restore')?.hidden).toBe(false)
    ui.controls.get('draft-restore')!.dispatchEvent(new Event('click'))
    expect(ui.restore).toHaveBeenCalledWith(snapshot())
    expect(storage.length).toBe(1)
    expect(ui.controls.get('draft-recovery-message')?.textContent).toBe('drafts.restored')
    ui.dirty(false)
    ui.binding.dispose()
    expect(storage.length).toBe(0)
  })

  it('preserves pending recovery while editing and lets the user discard it deliberately', () => {
    const storage = new Storage()
    new EditorDraftStore(() => storage, 'old').write(snapshot())
    const ui = harness(storage)
    ui.dirty(true)
    ui.window.confirm.mockReturnValue(false)
    ui.controls.get('draft-restore')!.dispatchEvent(new Event('click'))
    expect(ui.restore).not.toHaveBeenCalled()
    ui.controls.get('draft-discard')!.dispatchEvent(new Event('click'))
    expect(storage.length).toBe(0)
    ui.document.hidden = true
    ui.document.dispatchEvent(new Event('visibilitychange'))
    expect(ui.store.latest('demo')).toBeDefined()
    ui.binding.dispose()
  })

  it('reports storage failures and still warns before losing unsaved changes', () => {
    const ui = harness()
    vi.spyOn(ui.storage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    ui.dirty(true)
    const leave = new Event('beforeunload', { cancelable: true })
    ui.window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    expect(ui.controls.get('draft-recovery-message')?.textContent).toBe('drafts.storageError')
    ui.binding.dispose()
  })

  it('checkpoints new edits while an older recovery copy is awaiting a decision', () => {
    vi.useFakeTimers()
    const storage = new Storage()
    new EditorDraftStore(() => storage, 'old').write(snapshot())
    const ui = harness(storage, 'new')
    ui.draft({ ...snapshot(), drafts: { text: 'New edits' } })
    ui.dirty(true)
    ui.root.dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(250)
    expect(storage.length).toBe(2)
    expect(ui.store.latest('demo')?.draft.drafts.text).toBe('New edits')
    ui.binding.dispose()
  })
})
