import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { gameIdSchema, type InputDefinition } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export interface InputDraft {
  virtualKeys: string
  keyboard: { code: string; key: string }[]
  contexts: Record<string, { key: string; input: string }[]>
  initialContext: string
  newContext: string
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
    newContext: '',
  }
}

function uniqueMappings(
  entries: [string, string][],
  name: string,
  t: Translate,
): Record<string, string> {
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new Error(t('controls.duplicateKeys', { name }))

  return Object.fromEntries(entries)
}

export function readInputDraft(
  draft: InputDraft,
  t: Translate = editorLocalization().t,
): InputDefinition {
  if (draft.newContext) throw new Error(t('controls.pendingContext'))

  return {
    'schema-version': '1.0.0',
    'virtual-keys': draft.virtualKeys
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
    keyboard: uniqueMappings(
      draft.keyboard.map(({ code, key }) => [code, key]),
      t('controls.keyboard'),
      t,
    ),
    contexts: Object.fromEntries(
      Object.entries(draft.contexts).map(([id, mappings]) => [
        id,
        uniqueMappings(
          mappings.map(({ key, input }) => [key, input]),
          t('controls.context', { id }),
          t,
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
  const { create, input, select, button, group, t } = controls
  const keyboard = group(t('controls.keyboardMappings'))
  const contexts = group(t('controls.inputContexts'))
  let selectedContext = draft.initialContext

  const keys = () =>
    draft.virtualKeys
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)

  const renderKeyboard = () => {
    const rows = draft.keyboard.map((mapping, index) => {
      const row = group(t('controls.keyboardMapping', { number: index + 1 }))
      row.className = 'control-mapping-row'
      row.append(
        input(t('controls.keyCode'), mapping.code, (value) => {
          mapping.code = value.trim()
        }),
        select(t('controls.virtualKey'), mapping.key, keys(), (value) => {
          mapping.key = value
        }),
        button(t('controls.removeKeyMapping'), () => {
          draft.keyboard.splice(index, 1)
          edited()
          renderKeyboard()
        }),
      )

      return row
    })

    const heading = create('legend')
    heading.textContent = t('controls.keyboardMappings')
    keyboard.replaceChildren(
      heading,
      ...rows,
      button(t('controls.addKeyMapping'), () => {
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
    heading.textContent = t('controls.inputContexts')
    contexts.replaceChildren(
      heading,
      select(t('controls.initialContext'), draft.initialContext, ids, (value) => {
        draft.initialContext = value
      }),
      select(
        t('controls.editContext'),
        selectedContext,
        ids,
        (value) => {
          selectedContext = value
          renderContexts()
        },
        false,
      ),
      ...mappings.map((mapping, index) => {
        const row = group(t('controls.contextMapping', { number: index + 1 }))
        row.className = 'control-mapping-row'
        row.append(
          select(t('controls.virtualKey'), mapping.key, keys(), (value) => {
            mapping.key = value
          }),
          input(t('controls.virtualInputId'), mapping.input, (value) => {
            mapping.input = value.trim()
          }),
          button(t('controls.removeContextMapping'), () => {
            mappings.splice(index, 1)
            edited()
            renderContexts()
          }),
        )

        return row
      }),
      button(t('controls.addContextMapping'), () => {
        mappings.push({ key: keys()[0] ?? '', input: '' })
        edited()
        renderContexts()
      }),
      button(
        t('controls.removeContext'),
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
      input(t('controls.newContextId'), draft.newContext, (value) => {
        draft.newContext = value.trim()
      }),
      button(t('controls.addContext'), () => {
        if (
          !gameIdSchema.safeParse(draft.newContext).success ||
          Object.hasOwn(draft.contexts, draft.newContext)
        ) {
          reportError(t('controls.invalidContextId'))

          return
        }

        draft.contexts = { ...draft.contexts, [draft.newContext]: [] }
        selectedContext = draft.newContext
        draft.newContext = ''
        edited()
        renderContexts()
      }),
    )
  }

  const virtualKeys = input(t('controls.virtualKeys'), draft.virtualKeys, (value) => {
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
    section(t('controls.keyboardMappings'), keyboard),
    section(t('controls.inputContexts'), contexts),
  ]
}
