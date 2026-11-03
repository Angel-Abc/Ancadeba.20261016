import { commandRequestSchema, type EditorCommand, type Diagnostic } from '@ancadeba/editor-core'
import type { z } from 'zod'
import type { AdapterConfig } from './config.js'
import {
  apiErrorSchema,
  appliedChangeSchema,
  capabilitiesSchema,
  projectViewSchema,
  sceneViewSchema,
} from './protocol.js'

// These editor errors are raised before persistence. Other failures may come from
// the server's reread after saving, including legacy workspace errors with a 4xx status.
const rejectedCommandStatuses = new Map<string, number>([
  ['invalid_request', 400],
  ['invalid_json', 400],
  ['invalid_command', 400],
  ['invalid_project', 422],
  ['revision_conflict', 409],
  ['scene_exists', 409],
  ['scene_not_found', 404],
])

export class EditorApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
    readonly outcome: 'not_applied' | 'unknown' = 'not_applied',
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface IEditorApi {
  capabilities(signal?: AbortSignal): Promise<z.infer<typeof capabilitiesSchema>>
  inspectGame(signal?: AbortSignal): Promise<z.infer<typeof projectViewSchema>>
  inspectScene(id: string, signal?: AbortSignal): Promise<z.infer<typeof sceneViewSchema>>
  apply(
    expectedRevision: string,
    command: EditorCommand,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof appliedChangeSchema>>
}

export class EditorApiClient implements IEditorApi {
  constructor(
    private readonly config: AdapterConfig,
    private readonly fetcher: typeof fetch,
    private readonly shutdownSignal?: AbortSignal,
  ) {}

  async capabilities(signal?: AbortSignal) {
    const data = await this.request(
      '/api/editor/capabilities',
      capabilitiesSchema,
      undefined,
      signal,
    )
    if (data.version !== 1)
      throw new EditorApiError('incompatible_api', 'This adapter requires editor API version 1')
    return data
  }

  inspectGame(signal?: AbortSignal) {
    return this.request(
      `/api/editor/project?${new URLSearchParams({ path: this.config.game }).toString()}`,
      projectViewSchema,
      undefined,
      signal,
    )
  }

  inspectScene(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/editor/scene?${new URLSearchParams({ path: this.config.game, id }).toString()}`,
      sceneViewSchema,
      undefined,
      signal,
    )
  }

  async apply(expectedRevision: string, input: EditorCommand, signal?: AbortSignal) {
    const request = commandRequestSchema.safeParse({
      path: this.config.game,
      expectedRevision,
      command: input,
    })
    if (!request.success) {
      throw new EditorApiError(
        'invalid_request',
        'Invalid editing request',
        request.error.issues.map((issue) => ({
          code: 'invalid_request',
          file: '',
          path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
          message: issue.message,
        })),
      )
    }
    const { command } = request.data
    // Check every write so a restarted or upgraded server cannot silently change the contract.
    const capabilities = await this.capabilities(signal)
    if (!capabilities.commands.some((item) => item.type === command.type)) {
      throw new EditorApiError(
        'unsupported_command',
        'The connected editor does not support this command',
      )
    }
    return this.request('/api/editor/commands', appliedChangeSchema, request.data, signal)
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const signals = [
      AbortSignal.timeout(this.config.timeoutMs),
      requestSignal,
      this.shutdownSignal,
    ].filter((signal): signal is AbortSignal => signal !== undefined)
    const signal = AbortSignal.any(signals)
    if (signal.aborted)
      throw new EditorApiError('cancelled', 'Request was cancelled before sending')
    const writing = body !== undefined
    let sent = false
    try {
      const fetcher = this.fetcher
      sent = true
      const response = await fetcher(`${this.config.editorServerUrl}${path}`, {
        method: writing ? 'POST' : 'GET',
        ...(writing
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
        redirect: 'error',
        cache: 'no-store',
        signal,
      })
      let value: unknown
      try {
        value = await response.json()
      } catch (error) {
        if (signal.aborted) throw error
        throw new EditorApiError(
          'invalid_response',
          'Editor response was not valid JSON',
          [],
          writing ? 'unknown' : 'not_applied',
          response.status,
        )
      }
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(value)
        if (!error.success)
          throw new EditorApiError(
            'invalid_response',
            'Editor error response was malformed',
            [],
            writing ? 'unknown' : 'not_applied',
            response.status,
          )
        const fallback =
          response.status === 404
            ? 'not_found'
            : response.status === 409
              ? 'workspace_conflict'
              : 'editor_error'
        throw new EditorApiError(
          error.data.code ?? fallback,
          error.data.error,
          error.data.diagnostics,
          writing &&
            rejectedCommandStatuses.get(error.data.code ?? '') !== response.status &&
            ![413, 415].includes(response.status)
            ? 'unknown'
            : 'not_applied',
          response.status,
        )
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success)
        throw new EditorApiError(
          'invalid_response',
          'Editor response did not match the expected API schema',
          [],
          writing ? 'unknown' : 'not_applied',
          response.status,
        )
      return parsed.data
    } catch (error) {
      if (error instanceof EditorApiError) throw error
      const cancelled = requestSignal?.aborted || this.shutdownSignal?.aborted
      throw new EditorApiError(
        cancelled ? 'cancelled' : signal.aborted ? 'timeout' : 'server_unavailable',
        cancelled
          ? 'Editor request was cancelled'
          : signal.aborted
            ? 'Editor request timed out'
            : 'Could not reach the configured editor server. Start it separately.',
        [],
        writing && sent ? 'unknown' : 'not_applied',
      )
    }
  }
}
