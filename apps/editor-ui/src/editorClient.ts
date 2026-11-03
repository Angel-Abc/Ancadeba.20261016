import type { CommandRequest, Diagnostic, ProjectView } from '@ancadeba/editor-core'
import { apiErrorSchema, projectViewSchema } from '@ancadeba/editor-core'

export class EditorClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message)
  }
}

export interface IEditorClient {
  inspect(path: string): Promise<ProjectView>
  apply(request: CommandRequest): Promise<ProjectView>
  importAsset?(
    metadata: {
      path: string
      expectedRevision: string
      id: string
      format: 'svg' | 'png' | 'jpeg' | 'webp'
    },
    file: File,
  ): Promise<ProjectView>
}

export class HttpEditorClient implements IEditorClient {
  constructor(private readonly fetcher: typeof fetch) {}

  inspect(path: string): Promise<ProjectView> {
    return this.request(`/api/editor/project?${new URLSearchParams({ path })}`)
  }
  apply(request: CommandRequest): Promise<ProjectView> {
    return this.request('/api/editor/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }
  importAsset(
    metadata: {
      path: string
      expectedRevision: string
      id: string
      format: 'svg' | 'png' | 'jpeg' | 'webp'
    },
    file: File,
  ): Promise<ProjectView> {
    const body = new FormData()
    body.set('metadata', JSON.stringify(metadata))
    body.set('file', file)

    return this.request('/api/editor/assets/import', { method: 'POST', body })
  }
  private async request(url: string, init?: RequestInit): Promise<ProjectView> {
    const fetcher = this.fetcher
    const response = await fetcher(url, { ...init, cache: 'no-store' })
    const value: unknown = await response.json()

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(value)
      throw new EditorClientError(
        parsed.success ? (parsed.data.code ?? 'request_failed') : 'request_failed',
        parsed.success ? parsed.data.error : 'Editor request failed',
        parsed.success ? parsed.data.diagnostics : [],
      )
    }

    const parsed = projectViewSchema.safeParse(value)

    if (!parsed.success)
      throw new EditorClientError('invalid_response', 'Editor response was malformed')

    return parsed.data
  }
}
