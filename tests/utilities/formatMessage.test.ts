import { format } from 'node:util'
import { formatMessageForConsole } from '@ancadeba/utilities'
import { describe, expect, it } from 'vite-plus/test'

describe('formatMessageForConsole', () => {
  it('preserves diagnostic arguments without placeholders', () => {
    const error = new Error('Failed to load')
    const details = { path: 'scene.json' }
    const result = formatMessageForConsole('Load failed', error, details, 42)

    expect(result.formattedMessage).toBe('Load failed')
    expect(result.extraArgs).toEqual([error, details, 42])
    expect(result.extraArgs[0]).toBe(error)
    expect(result.extraArgs[1]).toBe(details)
  })

  it('appends unused arguments after objects in placeholder order', () => {
    const first = { id: 1 }
    const second = { id: 2 }
    const unused = new Error('Details')
    const result = formatMessageForConsole(
      '{2} {0} {2} {1}',
      first,
      'ready',
      second,
      unused,
      'context',
    )

    expect(result.formattedMessage).toBe('%o %o %o ready')
    expect(result.extraArgs).toEqual([second, first, second, unused, 'context'])
  })

  it('substitutes primitive values without forwarding them again', () => {
    expect(
      formatMessageForConsole('{4} {3} {2} {1} {0}', 'text', 3, false, null, undefined),
    ).toEqual({
      formattedMessage: 'undefined null false 3 text',
      extraArgs: [],
    })
  })

  it('keeps the existing undefined substitution for missing indices', () => {
    expect(formatMessageForConsole('{2}')).toEqual({
      formattedMessage: 'undefined',
      extraArgs: [],
    })
  })

  it('preserves percent signs when no console arguments remain', () => {
    expect(formatMessageForConsole('100% %% %s {0}', '50%')).toEqual({
      formattedMessage: '100% %% %s 50%',
      extraArgs: [],
    })
  })

  it('escapes literal specifiers when forwarding unused arguments', () => {
    const result = formatMessageForConsole('100% %s {0}', '50%', 'details')

    expect(format(result.formattedMessage, ...result.extraArgs)).toBe('100% %s 50% details')
  })

  it('keeps object substitutions separate from literal percent specifiers', () => {
    const details = { id: 1 }
    const result = formatMessageForConsole('literal %o {0}', details)

    expect(result).toEqual({
      formattedMessage: 'literal %%o %o',
      extraArgs: [details],
    })
    expect(format(result.formattedMessage, ...result.extraArgs)).toBe('literal %o { id: 1 }')
  })
})
