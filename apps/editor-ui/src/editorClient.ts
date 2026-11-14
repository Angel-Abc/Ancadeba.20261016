import type {
  CommandRequest,
  CreateProjectRequest,
  DuplicateProjectRequest,
  Diagnostic,
  ProjectChoice,
  ProjectView,
  HistoryRequest,
  ComponentCopyRequest,
  ComponentClipboard,
  ProjectRepairRequest,
  ProjectRepairCheck,
} from '@ancadeba/editor-core'
import {
  apiErrorSchema,
  projectListSchema,
  projectViewSchema,
  componentClipboardSchema,
  projectRepairCheckSchema,
} from '@ancadeba/editor-core'

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
  checkRepair?(request: ProjectRepairRequest): Promise<ProjectRepairCheck>
  repair?(request: ProjectRepairRequest): Promise<ProjectView>
  copyComponent?(request: ComponentCopyRequest): Promise<ComponentClipboard>
  restore?(request: HistoryRequest): Promise<ProjectView>
  create?(request: CreateProjectRequest): Promise<ProjectView>
  duplicate?(request: DuplicateProjectRequest): Promise<ProjectView>
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

  async checkRepair(request: ProjectRepairRequest): Promise<ProjectRepairCheck> {
    const value = await this.request('/api/editor/repair/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    const parsed = projectRepairCheckSchema.safeParse(value)

    if (!parsed.success)
      throw new EditorClientError('invalid_response', 'Repair check response was malformed')

    return parsed.data
  }

  repair(request: ProjectRepairRequest): Promise<ProjectView> {
    return this.requestProject('/api/editor/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  async copyComponent(request: ComponentCopyRequest): Promise<ComponentClipboard> {
    const value = await this.request('/api/editor/components/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })

    const parsed = componentClipboardSchema.safeParse(value)

    if (!parsed.success)
      throw new EditorClientError('invalid_response', 'Component copy response was malformed')

    return parsed.data
  }

  restore(request: HistoryRequest): Promise<ProjectView> {
    return this.requestProject('/api/editor/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  create(request: CreateProjectRequest): Promise<ProjectView> {
    return this.requestProject('/api/editor/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  duplicate(request: DuplicateProjectRequest): Promise<ProjectView> {
    return this.requestProject('/api/editor/projects/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  }

  async listProjects(signal: AbortSignal): Promise<ProjectChoice[]> {
    const value = await this.request('/api/editor/projects', { signal })
    const parsed = projectListSchema.safeParse(value)

    if (!parsed.success) {
      throw new EditorClientError('invalid_response', 'Project list response was malformed')
    }

    return parsed.data.projects
  }

  inspect(path: string): Promise<ProjectView> {
    return this.requestProject(`/api/editor/project?${new URLSearchParams({ path })}`)
  }
  apply(request: CommandRequest): Promise<ProjectView> {
    return this.requestProject('/api/editor/commands', {
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

    return this.requestProject('/api/editor/assets/import', { method: 'POST', body })
  }
  private async requestProject(url: string, init?: RequestInit): Promise<ProjectView> {
    const parsed = projectViewSchema.safeParse(await this.request(url, init))

    if (!parsed.success) {
      throw new EditorClientError('invalid_response', 'Editor response was malformed')
    }

    return parsed.data
  }

  private async request(url: string, init?: RequestInit): Promise<unknown> {
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

    return value
  }
}
