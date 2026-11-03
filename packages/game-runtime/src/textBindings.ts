import { textPlaceholders } from '@ancadeba/schemas'
import type { Unsubscribe } from '@ancadeba/utilities'
import type { BindingDiagnostic, GameBinding, IGameBindings } from './gameBindings.js'

export interface TextTemplate {
  readonly text: string
  readonly bindings?: Readonly<Record<string, GameBinding>> | undefined
}

export interface TextBindingDiagnostic {
  readonly alias: string
  readonly source?: BindingDiagnostic['source']
  readonly path?: BindingDiagnostic['path']
  readonly reason: BindingDiagnostic['reason'] | 'undeclared-binding'
}

export interface TextResolution {
  readonly text: string
  readonly diagnostics: readonly TextBindingDiagnostic[]
}

export interface TextResolutionOptions {
  readonly mode?: 'standalone' | 'editor'
}

/** Resolve plain text without evaluating expressions, markup, or substituted placeholders. */
export function resolveText(
  template: TextTemplate,
  source: IGameBindings | undefined,
  options: TextResolutionOptions = {},
): TextResolution {
  if (template.bindings === undefined) return { text: template.text, diagnostics: [] }
  const diagnostics: TextBindingDiagnostic[] = []
  const replacements = new Map<string, string>()
  let text = ''
  let offset = 0

  for (const { alias, index, length } of textPlaceholders(template.text)) {
    if (!replacements.has(alias)) {
      // SAFETY: an own data property of the typed binding map is a GameBinding; absent/accessor properties yield undefined.
      const binding = Object.getOwnPropertyDescriptor(template.bindings, alias)?.value as
        | GameBinding
        | undefined

      const result = binding
        ? (source?.read(binding) ?? {
            status: 'unresolved' as const,
            diagnostic: {
              source: binding.source,
              path: [...binding.path],
              reason: 'source-unavailable' as const,
            },
          })
        : undefined

      if (result?.status === 'resolved') replacements.set(alias, String(result.value))
      else {
        diagnostics.push({
          alias,
          ...(result?.diagnostic ?? { reason: 'undeclared-binding' as const }),
        })
        replacements.set(
          alias,
          options.mode === 'editor' ? `[unresolved: ${alias}]` : (binding?.fallback ?? ''),
        )
      }
    }

    text += template.text.slice(offset, index) + replacements.get(alias)!
    offset = index + length
  }

  return { text: text + template.text.slice(offset), diagnostics }
}

/** Emit immediately, then only when the resolved text or diagnostics change. */
export function observeText(
  template: TextTemplate,
  source: IGameBindings,
  handler: (resolution: TextResolution) => void,
  options: TextResolutionOptions = {},
): Unsubscribe {
  let previous: string | undefined
  let active = true

  const emit = () => {
    if (!active) return
    const resolution = resolveText(template, source, options)
    const signature = JSON.stringify(resolution)

    if (signature === previous) return
    previous = signature
    handler(resolution)
  }

  const unsubscribe = source.subscribeChanges(emit)

  try {
    emit()
  } catch (error) {
    active = false
    unsubscribe()
    throw error
  }

  return () => {
    active = false
    unsubscribe()
  }
}
