import type { Diagnostic, EditorWriteOutcome } from '@ancadeba/editor-core'

export class EditorApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
    readonly outcome: EditorWriteOutcome = 'not_applied',
    readonly status?: number,
  ) {
    super(message)
  }
}
