import { gameIdSchema, type InputDefinition } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export interface InputDraft {
  virtualKeys: string
  keyboard: { code: string; key: string }[]
  contexts: Record<string, { key: string; input: string }[]>
  initialContext: string
}

export function createInputDraft(input: InputDefinition): InputDraft {
  return {
    virtualKeys: input['virtual-keys'].join(', '),
    keyboard: Object.entries(input.keyboard).map(([code, key]) => ({ code, key })),
    contexts: Object.fromEntries(
      Object.entries(input.contexts).map(([id, mappings]) => [
        id,
        Object.entries(mappings).map(([key, input]) => ({ key, input })),
      ]),
    ),
    initialContext: input['initial-context'],
  }
}

function uniqueMappings(entries: [string, string][], name: string): Record<string, string> {
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new Error(`${name} contains duplicate keys. Each key can have one mapping.`)

  return Object.fromEntries(entries)
}

export function readInputDraft(draft: InputDraft): InputDefinition {
  return {
    'schema-version': '1.0.0',
    'virtual-keys': draft.virtualKeys
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
    keyboard: uniqueMappings(
      draft.keyboard.map(({ code, key }) => [code, key]),
      'Keyboard',
    ),
    contexts: Object.fromEntries(
      Object.entries(draft.contexts).map(([id, mappings]) => [
        id,
        uniqueMappings(
          mappings.map(({ key, input }) => [key, input]),
          `Context ${id}`,
        ),
      ]),
    ),
    'initial-context': draft.initialContext,
  }
}

export function inputDefinitionForm(
  controls: RuleFormControls,
  draft: InputDraft,
  edited: () => void,
  reportError: (message: string) => void,
): HTMLElement[] {
  const { create, input, select, button, group } = controls
  const keyboard = group('Physical keyboard mappings')
  const contexts = group('Input contexts')
  let selectedContext = draft.initialContext
  let newContext = ''

  const keys = () =>
    draft.virtualKeys
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)

  const renderKeyboard = () => {
    const rows = draft.keyboard.map((mapping, index) => {
      const row = group(`Keyboard mapping ${index + 1}`)
      row.className = 'control-mapping-row'
      row.append(
        input('Physical key code', mapping.code, (value) => {
          mapping.code = value.trim()
        }),
        select('Virtual key', mapping.key, keys(), (value) => {
          mapping.key = value
        }),
        button('Remove key mapping', () => {
          draft.keyboard.splice(index, 1)
          edited()
          renderKeyboard()
        }),
      )

      return row
    })

    const heading = create('legend')
    heading.textContent = 'Physical keyboard mappings'
    keyboard.replaceChildren(
      heading,
      ...rows,
      button('Add key mapping', () => {
        draft.keyboard.push({ code: '', key: keys()[0] ?? '' })
        edited()
        renderKeyboard()
      }),
    )
  }

  const renderContexts = () => {
    const ids = Object.keys(draft.contexts)
    const mappings = draft.contexts[selectedContext] ?? []
    const heading = create('legend')
    heading.textContent = 'Input contexts'
    contexts.replaceChildren(
      heading,
      select('Initial context', draft.initialContext, ids, (value) => {
        draft.initialContext = value
      }),
      select(
        'Edit context',
        selectedContext,
        ids,
        (value) => {
          selectedContext = value
          renderContexts()
        },
        false,
      ),
      ...mappings.map((mapping, index) => {
        const row = group(`Context mapping ${index + 1}`)
        row.className = 'control-mapping-row'
        row.append(
          select('Virtual key', mapping.key, keys(), (value) => {
            mapping.key = value
          }),
          input('Virtual input ID', mapping.input, (value) => {
            mapping.input = value.trim()
          }),
          button('Remove context mapping', () => {
            mappings.splice(index, 1)
            edited()
            renderContexts()
          }),
        )

        return row
      }),
      button('Add context mapping', () => {
        mappings.push({ key: keys()[0] ?? '', input: '' })
        edited()
        renderContexts()
      }),
      button(
        'Remove context',
        () => {
          delete draft.contexts[selectedContext]
          selectedContext = Object.keys(draft.contexts)[0] ?? ''

          if (!Object.hasOwn(draft.contexts, draft.initialContext))
            draft.initialContext = selectedContext
          edited()
          renderContexts()
        },
        ids.length < 2,
      ),
      input('New context ID', newContext, (value) => {
        newContext = value.trim()
      }),
      button('Add context', () => {
        if (
          !gameIdSchema.safeParse(newContext).success ||
          Object.hasOwn(draft.contexts, newContext)
        ) {
          reportError('Enter a unique context ID using letters, numbers, underscores, or hyphens.')

          return
        }

        draft.contexts = { ...draft.contexts, [newContext]: [] }
        selectedContext = newContext
        newContext = ''
        edited()
        renderContexts()
      }),
    )
  }

  const virtualKeys = input('Virtual keys (comma-separated)', draft.virtualKeys, (value) => {
    draft.virtualKeys = value
    renderKeyboard()
    renderContexts()
  })

  renderKeyboard()
  renderContexts()

  const section = (title: string, content: HTMLElement) => {
    const details = create('details')
    const summary = create('summary')
    summary.textContent = title
    details.append(summary, content)

    return details
  }

  return [
    virtualKeys,
    section('Physical keyboard mappings', keyboard),
    section('Input contexts', contexts),
  ]
}
