/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  inspectProject,
  type ProjectRepairCheck,
  type ProjectRepairRequest,
} from '@ancadeba/editor-core'
import { bindProjectRepair } from '../apps/editor-ui/src/projectRepair.js'
import { editorLocalization } from '../apps/editor-ui/src/localization.js'
import type { ProjectEditorState } from '../apps/editor-ui/src/projectController.js'
import { captureEditorDrafts, restoreEditorDrafts } from '../apps/editor-ui/src/editorDraftState.js'

class Element extends EventTarget {
  children: Element[] = []
  attributes = new Map<string, string>()
  value = ''
  textContent = ''
  type = ''
  className = ''
  hidden = false
  disabled = false
  readOnly = false
  tabIndex = -1
  rows = 0
  spellcheck = false
  constructor(
    readonly ownerDocument: DocumentFixture,
    readonly tagName: string,
  ) {
    super()
  }
  append(...children: Element[]) {
    this.children.push(...children)
  }
  replaceChildren(...children: Element[]) {
    this.children = children
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  all(): Element[] {
    return this.children.flatMap((child) => [child, ...child.all()])
  }
  querySelectorAll(selector: string) {
    return this.all().filter((element) =>
      selector === '[data-editor-draft]'
        ? element.attributes.has('data-editor-draft')
        : ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName),
    )
  }
  asElement(): HTMLElement {
    // @ts-expect-error -- The repair editor uses the event, attribute and child operations implemented here.
    return this
  }
}

class DocumentFixture {
  createElement(tag: string) {
    return new Element(this, tag.toUpperCase())
  }
}

function initialState(): ProjectEditorState {
  return {
    path: 'demo',
    view: inspectProject({
      revision: 'one',
      documents: { 'game.json': null },
      sourceDiagnostics: [
        { code: 'invalid_json', file: 'game.json', path: [], message: 'Invalid JSON' },
      ],
      sourceTexts: { 'game.json': '{broken', 'scenes/start.json': '{}' },
    }),
    busy: false,
    error: '',
    conflict: false,
    changedElsewhere: false,
    lastCommand: null,
    preserveDrafts: false,
  }
}

function harness() {
  const root = new DocumentFixture().createElement('section')
  let language = editorLocalization()

  const check = vi
    .fn<(request: Omit<ProjectRepairRequest, 'path'>) => Promise<ProjectRepairCheck | undefined>>()
    .mockResolvedValue({ revision: 'one', diagnostics: [] })

  const save = vi
    .fn<(request: Omit<ProjectRepairRequest, 'path'>) => Promise<boolean>>()
    .mockResolvedValue(false)

  const binding = bindProjectRepair(root.asElement(), (key, values) => language.t(key, values), {
    check,
    save,
  })

  const state = initialState()
  binding.render(state, true)

  const source = () =>
    root.all().find((element) => element.tagName === 'TEXTAREA' && !element.readOnly)!

  const button = (index: number) =>
    root.all().filter((element) => element.tagName === 'BUTTON')[index]!

  const edit = (value: string) => {
    source().value = value
    source().dispatchEvent(new Event('input'))
  }

  return {
    root,
    binding,
    state,
    check,
    save,
    source,
    button,
    edit,
    language: (tag: string) => {
      language = editorLocalization([tag])
      binding.render(state, false)
    },
  }
}

describe('project repair editor', () => {
  it('offers a reviewed manifest draft for a missing manifest and preserves typed or recovered entries', async () => {
    const ui = harness()

    const text =
      '{"id":"demo","title":"Recovered game","version":"1","scenes":[],"schema-version":"1.0.0"}'

    ui.state.view!.repairFiles = { 'game.json': null }
    ui.state.view!.recoveryManifest = text
    ui.binding.render(ui.state, true)
    expect(ui.button(3).hidden).toBe(false)
    expect(ui.button(3).disabled).toBe(false)
    ui.button(3).dispatchEvent(new Event('click'))
    expect(ui.source().value).toBe(text)
    expect(ui.binding.hasDrafts()).toBe(true)
    expect(ui.button(1).disabled).toBe(true)
    expect(ui.root.all().some((element) => element.textContent.includes('Original metadata'))).toBe(
      true,
    )
    const draft = captureEditorDrafts(ui.root.asElement())
    ui.button(2).dispatchEvent(new Event('click'))
    expect(ui.source().value).toBe('')
    expect(restoreEditorDrafts(ui.root.asElement(), draft)).toEqual([])
    expect(ui.source().value).toBe(text)
    ui.edit('A pasted backup')
    expect(ui.button(3).disabled).toBe(true)
    ui.button(3).dispatchEvent(new Event('click'))
    expect(ui.source().value).toBe('A pasted backup')
    ui.edit(text)
    ui.button(0).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.button(1).disabled).toBe(false))
    expect(ui.check).toHaveBeenLastCalledWith({ file: 'game.json', text, expectedRevision: 'one' })
    ui.language('nl')
    expect(ui.button(3).textContent).toBe('Manifestconcept maken')
    ui.binding.dispose()
  })

  it('shows malformed source and diagnostics, requires checking, and invalidates the preview on edits', async () => {
    const ui = harness()
    expect(ui.root.hidden).toBe(false)
    expect(ui.source().value).toBe('{broken')
    expect(ui.root.all().some((element) => element.textContent.includes('Invalid JSON'))).toBe(true)
    expect(ui.button(1).disabled).toBe(true)
    ui.edit('{"title":"Fixed"}')
    expect(ui.binding.hasDrafts()).toBe(true)
    ui.button(0).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.button(1).disabled).toBe(false))
    expect(ui.check).toHaveBeenCalledExactlyOnceWith({
      file: 'game.json',
      text: '{"title":"Fixed"}',
      expectedRevision: 'one',
    })
    ui.edit('{"title":"New edit"}')
    expect(ui.button(1).disabled).toBe(true)
    ui.binding.dispose()
  })

  it('labels partial repairs clearly and retains rejected or conflicting repair drafts', async () => {
    const ui = harness()
    ui.check.mockResolvedValue({
      revision: 'one',
      diagnostics: [
        { code: 'invalid_document', file: 'game.json', path: ['scenes'], message: 'Required' },
      ],
    })
    ui.edit('{}')
    ui.button(0).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.button(1).textContent).toContain('1 problems remain'))
    ui.button(1).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.save).toHaveBeenCalledTimes(1))
    expect(ui.binding.hasDrafts()).toBe(true)
    expect(ui.source().value).toBe('{}')
    ui.binding.dispose()
  })

  it('clears a successful repair and returns to ordinary editing when the project is valid', async () => {
    const ui = harness()
    ui.save.mockImplementation(async () => {
      ui.binding.render(
        {
          ...ui.state,
          view: { revision: 'two', game: null, scenes: [], diagnostics: [] },
          preserveDrafts: true,
        },
        true,
      )

      return true
    })
    ui.edit('{}')
    ui.button(0).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.button(1).disabled).toBe(false))
    ui.button(1).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.binding.hasDrafts()).toBe(false))
    expect(ui.root.hidden).toBe(true)
    ui.binding.dispose()
  })

  it('preserves the draft revision across unrelated saves and rebases only after an explicit reload', async () => {
    const ui = harness()
    ui.edit('{"draft":true}')

    const latest = {
      ...ui.state,
      view: {
        ...ui.state.view!,
        revision: 'two',
        repairFiles: { 'game.json': '{"external":true}' },
      },
      preserveDrafts: true,
    }

    ui.binding.render({ ...latest, lastCommand: 'game.updateMetadata' }, true)
    ui.button(0).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.check).toHaveBeenCalledTimes(1))
    expect(ui.check.mock.calls[0]?.[0].expectedRevision).toBe('one')
    ui.binding.render(latest, true)
    expect(ui.source().value).toBe('{"draft":true}')
    expect(
      ui.root.all().find((element) => element.className.includes('repair-saved-source'))
        ?.textContent,
    ).toBe('{"external":true}')
    ui.check.mockResolvedValue({ revision: 'two', diagnostics: [] })
    ui.button(0).dispatchEvent(new Event('click'))
    await vi.waitFor(() => expect(ui.check).toHaveBeenCalledTimes(2))
    expect(ui.check.mock.calls[1]?.[0].expectedRevision).toBe('two')
    ui.binding.dispose()
  })

  it('keeps source text through language changes and draft recovery, and guards file switching', () => {
    const ui = harness()
    ui.edit('{"unfinished":')
    const captured = captureEditorDrafts(ui.root.asElement())
    ui.language('nl')
    expect(ui.button(0).textContent).toBe('Herstel controleren')
    expect(ui.source().value).toBe('{"unfinished":')
    const picker = ui.root.all().find((element) => element.tagName === 'SELECT')!
    picker.value = 'scenes/start.json'
    picker.dispatchEvent(new Event('change'))
    expect(picker.value).toBe('game.json')
    ui.button(2).dispatchEvent(new Event('click'))
    expect(ui.binding.hasDrafts()).toBe(false)
    expect(ui.source().value).toBe('{broken')
    expect(restoreEditorDrafts(ui.root.asElement(), captured)).toEqual([])
    expect(ui.source().value).toBe('{"unfinished":')
    expect(ui.binding.hasDrafts()).toBe(true)
    expect(ui.button(1).disabled).toBe(true)
    ui.binding.dispose()
  })
})
