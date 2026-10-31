import type { CommandRequest, Diagnostic, ProjectView } from '@ancadeba/editor-core'

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
  private async request(url: string, init?: RequestInit): Promise<ProjectView> {
    const fetcher = this.fetcher
    const response = await fetcher(url, { ...init, cache: 'no-store' })
    const value = (await response.json()) as ProjectView & { error?: string; code?: string }
    if (!response.ok)
      throw new EditorClientError(
        value.code ?? 'request_failed',
        value.error ?? 'Editor request failed',
        value.diagnostics ?? [],
      )
    return value
  }
}
