import type { CallToolResult } from '@modelcontextprotocol/server'
import { EditorApiError } from './editorApiClient.js'

interface RecoveryMessages {
  unknown: string
  notApplied: string
}

async function executeOperation(
  operation: () => Promise<Record<string, unknown>>,
  recovery?: RecoveryMessages,
) {
  try {
    return { ok: true as const, data: await operation() }
  } catch (error) {
    const failure =
      error instanceof EditorApiError
        ? error
        : new EditorApiError(
            'adapter_error',
            'The adapter could not complete the operation',
            [],
            'unknown',
          )

    return {
      ok: false as const,
      error: {
        code: failure.code,
        message: failure.message,
        diagnostics: failure.diagnostics,
        outcome: failure.outcome,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        recovery:
          failure.outcome === 'unknown'
            ? (recovery?.unknown ??
              'Inspect the game before another edit; the previous write may have been saved. Do not retry automatically.')
            : (recovery?.notApplied ??
              (failure.code === 'revision_conflict'
                ? 'Inspect the game again, review the newer content, then submit a deliberate change with that revision.'
                : 'Correct the reported problem and inspect the game before editing.')),
      },
    }
  }
}

export async function toolResult(
  operation: () => Promise<Record<string, unknown>>,
  recovery?: RecoveryMessages,
): Promise<CallToolResult> {
  const output = await executeOperation(operation, recovery)

  return {
    isError: !output.ok,
    structuredContent: output,
    content: [{ type: 'text', text: JSON.stringify(output) }],
  }
}
