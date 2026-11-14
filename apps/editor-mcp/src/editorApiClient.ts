import {
  commandRequestSchema,
  type EditorCommand,
  type EditorWriteOutcome,
  projectLocationSchema,
  deletedProjectSchema,
  deletedProjectListSchema,
} from '@ancadeba/editor-core'
import type { z } from 'zod'
import type { AdapterConfig } from './config.js'
import { workspaceProjectPathSchema } from './projectPath.js'
import {
  assetUploadInputSchema,
  historyInputSchema,
  maxUploadBytes,
  createProjectInputSchema,
  duplicateProjectInputSchema,
  renameProjectInputSchema,
  deleteProjectInputSchema,
  restoreProjectInputSchema,
  exportGameInputSchema,
  importProjectInputSchema,
  exportProjectInputSchema,
} from './operationSupport.js'
import { EditorApiError } from './editorApiError.js'
import { readExportArchive, type ExportArchive } from './exportArchive.js'
import {
  apiErrorSchema,
  appliedChangeSchema,
  capabilitiesSchema,
  projectViewSchema,
  sceneViewSchema,
  projectListSchema,
} from './protocol.js'

export { EditorApiError } from './editorApiError.js'

// These editor errors are raised before persistence. Other failures may come from
// the server's reread after saving, including legacy workspace errors with a 4xx status.
/**
 * Trust the editor's declared rejection only with a status that cannot follow a write.
 * Request-size and content-type failures are raised before the body is read.
 */
function writeFailureOutcome(status: number, declared: EditorWriteOutcome | undefined) {
  if (status === 413 || status === 415) return 'not_applied'

  return declared === 'not_applied' && ((status >= 400 && status < 500) || status === 503)
    ? 'not_applied'
    : 'unknown'
}

interface RequestBody {
  body: string | ArrayBuffer
  headers: Record<string, string>
}

const jsonBody = (value: unknown): RequestBody => ({
  body: JSON.stringify(value),
  headers: { 'Content-Type': 'application/json' },
})

export interface IEditorApi {
  importProject?(
    input: z.infer<typeof importProjectInputSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof projectViewSchema>>
  exportProject?(
    input: z.input<typeof exportProjectInputSchema>,
    signal?: AbortSignal,
  ): Promise<ExportArchive>
  renameProject?(
    input: z.infer<typeof renameProjectInputSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof projectLocationSchema>>
  deleteProject?(
    input: z.infer<typeof deleteProjectInputSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof deletedProjectSchema>>
  listDeletedProjects?(signal?: AbortSignal): Promise<z.infer<typeof deletedProjectListSchema>>
  restoreProject?(
    input: z.infer<typeof restoreProjectInputSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof projectLocationSchema>>
  forProject(path: string): IEditorApi
  exportGame(
    input: z.input<typeof exportGameInputSchema>,
    signal?: AbortSignal,
  ): Promise<ExportArchive>
  listProjects(signal?: AbortSignal): Promise<z.infer<typeof projectListSchema>>
  createProject(
    input: z.infer<typeof createProjectInputSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof projectViewSchema>>
  duplicateProject?(
    input: z.infer<typeof duplicateProjectInputSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof projectViewSchema>>
  capabilities(signal?: AbortSignal): Promise<z.infer<typeof capabilitiesSchema>>
  inspectGame(signal?: AbortSignal): Promise<z.infer<typeof projectViewSchema>>
  inspectScene(id: string, signal?: AbortSignal): Promise<z.infer<typeof sceneViewSchema>>
  apply(
    expectedRevision: string,
    command: EditorCommand,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof appliedChangeSchema>>
  restore(
    expectedRevision: string,
    direction: 'undo' | 'redo',
    signal?: AbortSignal,
  ): Promise<z.infer<typeof projectViewSchema>>
  uploadAsset(
    input: z.infer<typeof assetUploadInputSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof appliedChangeSchema>>
}

export class EditorApiClient implements IEditorApi {
  constructor(
    private readonly config: AdapterConfig,
    private readonly fetcher: typeof fetch,
    private readonly shutdownSignal?: AbortSignal,
  ) {}

  async importProject(input: z.infer<typeof importProjectInputSchema>, signal?: AbortSignal) {
    const parsed = importProjectInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError(
        'invalid_request',
        'Provide a new destination and canonical base64 project ZIP up to 6 MiB',
      )

    if (!(await this.capabilities(signal)).features?.projectImport)
      throw new EditorApiError('unsupported_project_import', 'Project import is unavailable')
    const bytes = new Uint8Array(Buffer.from(parsed.data.dataBase64, 'base64'))

    return this.request(
      `/api/editor/projects/import?${new URLSearchParams({ destination: parsed.data.destination }).toString()}`,
      projectViewSchema,
      { body: bytes.buffer, headers: { 'Content-Type': 'application/zip' } },
      signal,
    )
  }

  async exportProject(input: z.input<typeof exportProjectInputSchema>, signal?: AbortSignal) {
    const parsed = exportProjectInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError(
        'invalid_request',
        'Provide the current revision and an optional timeoutMs from 1 to 300000',
      )

    if (!(await this.capabilities(signal)).features?.projectExport)
      throw new EditorApiError('unsupported_project_export', 'Project export is unavailable')

    return this.request(
      '/api/editor/projects/export',
      undefined,
      jsonBody({ path: this.config.game, expectedRevision: parsed.data.expectedRevision }),
      signal,
      {
        readResponse: (response) => readExportArchive(response, 'project'),
        timeoutMs: parsed.data.timeoutMs,
        readOnly: true,
      },
    )
  }

  private async managementSupport(
    feature: 'projectRenaming' | 'projectDeletion' | 'projectRestoration',
    signal?: AbortSignal,
  ) {
    if (!(await this.capabilities(signal)).features?.[feature])
      throw new EditorApiError(
        'unsupported_project_management',
        'The connected editor does not advertise this project operation',
      )
  }

  async renameProject(input: z.infer<typeof renameProjectInputSchema>, signal?: AbortSignal) {
    const parsed = renameProjectInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError(
        'invalid_request',
        'Provide the source revision and a new title or folder name',
      )
    await this.managementSupport('projectRenaming', signal)

    return this.request(
      '/api/editor/projects/rename',
      projectLocationSchema,
      jsonBody({ ...parsed.data, path: this.config.game }),
      signal,
    )
  }

  async deleteProject(input: z.infer<typeof deleteProjectInputSchema>, signal?: AbortSignal) {
    const parsed = deleteProjectInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError('invalid_request', 'Provide the source revision and confirm: true')
    await this.managementSupport('projectDeletion', signal)

    return this.request(
      '/api/editor/projects/delete',
      deletedProjectSchema,
      jsonBody({ ...parsed.data, path: this.config.game }),
      signal,
    )
  }

  async listDeletedProjects(signal?: AbortSignal) {
    await this.managementSupport('projectRestoration', signal)

    return this.request('/api/editor/projects/trash', deletedProjectListSchema, undefined, signal)
  }

  async restoreProject(input: z.infer<typeof restoreProjectInputSchema>, signal?: AbortSignal) {
    const parsed = restoreProjectInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError(
        'invalid_request',
        'Provide a trash ID, its revision and an optional unused destination',
      )
    await this.managementSupport('projectRestoration', signal)

    return this.request(
      '/api/editor/projects/restore',
      projectLocationSchema,
      jsonBody(parsed.data),
      signal,
    )
  }

  forProject(path: string): IEditorApi {
    const parsed = workspaceProjectPathSchema.safeParse(path)

    if (!parsed.success)
      throw new EditorApiError('invalid_request', 'Select a workspace-relative project folder')

    return new EditorApiClient(
      { ...this.config, game: parsed.data },
      this.fetcher,
      this.shutdownSignal,
    )
  }

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

  async listProjects(signal?: AbortSignal) {
    const available = await this.capabilities(signal)

    if (!available.features?.projectDiscovery)
      throw new EditorApiError(
        'unsupported_discovery',
        'The connected editor does not advertise project discovery support',
      )

    return this.request('/api/editor/projects', projectListSchema, undefined, signal)
  }

  async exportGame(input: z.input<typeof exportGameInputSchema>, signal?: AbortSignal) {
    const parsed = exportGameInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError('invalid_request', 'Export timeoutMs must be 1 to 300000')
    const available = await this.capabilities(signal)

    if (!available.features?.gameExport)
      throw new EditorApiError(
        'unsupported_export',
        'The connected editor does not advertise game export support',
      )

    return this.request('/api/exports', undefined, jsonBody({ path: this.config.game }), signal, {
      readResponse: readExportArchive,
      timeoutMs: parsed.data.timeoutMs,
      readOnly: true,
    })
  }

  async createProject(input: z.infer<typeof createProjectInputSchema>, signal?: AbortSignal) {
    const parsed = createProjectInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError(
        'invalid_request',
        'Provide a new single-folder project path and a nonempty title',
        parsed.error.issues.map((issue) => ({
          code: 'invalid_request',
          file: '',
          path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
          message: issue.message,
        })),
      )
    const available = await this.capabilities(signal)

    if (!available.features?.projectCreation)
      throw new EditorApiError(
        'unsupported_creation',
        'The connected editor does not advertise project creation support',
      )

    return this.request('/api/editor/projects', projectViewSchema, jsonBody(parsed.data), signal)
  }

  inspectGame(signal?: AbortSignal) {
    return this.request(
      `/api/editor/project?${new URLSearchParams({ path: this.config.game }).toString()}`,
      projectViewSchema,
      undefined,
      signal,
    )
  }

  async duplicateProject(input: z.infer<typeof duplicateProjectInputSchema>, signal?: AbortSignal) {
    const parsed = duplicateProjectInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError(
        'invalid_request',
        'Provide the source revision, a new folder name, and a title',
      )
    const available = await this.capabilities(signal)

    if (!available.features?.projectDuplication)
      throw new EditorApiError(
        'unsupported_duplication',
        'The connected editor does not advertise project duplication support',
      )

    return this.request(
      '/api/editor/projects/duplicate',
      projectViewSchema,
      jsonBody({ ...parsed.data, path: this.config.game }),
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

    return this.request('/api/editor/commands', appliedChangeSchema, jsonBody(request.data), signal)
  }

  async restore(expectedRevision: string, direction: 'undo' | 'redo', signal?: AbortSignal) {
    const parsed = historyInputSchema.safeParse({ expectedRevision })

    if (!parsed.success || !['undo', 'redo'].includes(direction))
      throw new EditorApiError('invalid_request', 'Provide a revision and an undo/redo direction')
    const available = await this.capabilities(signal)

    if (!available.features?.history)
      throw new EditorApiError(
        'unsupported_history',
        'The connected editor does not advertise undo/redo support',
      )

    return this.request(
      '/api/editor/history',
      projectViewSchema,
      jsonBody({ path: this.config.game, ...parsed.data, direction }),
      signal,
    )
  }

  async uploadAsset(input: z.infer<typeof assetUploadInputSchema>, signal?: AbortSignal) {
    const parsed = assetUploadInputSchema.safeParse(input)

    if (!parsed.success)
      throw new EditorApiError(
        'invalid_request',
        'Provide a revision, image ID, format and canonical base64 image bytes',
        parsed.error.issues.map((issue) => ({
          code: 'invalid_request',
          file: '',
          path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
          message: issue.message,
        })),
      )
    const { dataBase64, ...metadata } = parsed.data
    const bytes = Buffer.from(dataBase64, 'base64')
    const form = new FormData()
    form.set('metadata', JSON.stringify({ path: this.config.game, ...metadata }))

    const mime = { svg: 'image/svg+xml', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[
      metadata.format
    ]

    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: mime }),
      `${metadata.id}.${metadata.format}`,
    )
    const encoded = new Response(form)
    const body = await encoded.arrayBuffer()

    if (body.byteLength > maxUploadBytes)
      throw new EditorApiError(
        'request_too_large',
        'The complete multipart upload must fit within 10 MiB, including metadata',
        [],
        'not_applied',
        413,
      )
    const available = await this.capabilities(signal)

    if (!available.features?.assetImport)
      throw new EditorApiError(
        'unsupported_import',
        'The connected editor does not advertise asset upload support',
      )

    return this.request(
      '/api/editor/assets/import',
      appliedChangeSchema,
      {
        body,
        headers: { 'Content-Type': encoded.headers.get('content-type')! },
      },
      signal,
    )
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T> | undefined,
    body?: RequestBody,
    requestSignal?: AbortSignal,
    options?: {
      readResponse: (response: Response) => Promise<T>
      timeoutMs: number
      readOnly: boolean
    },
  ): Promise<T> {
    const signals = [
      AbortSignal.timeout(options?.timeoutMs ?? this.config.timeoutMs),
      requestSignal,
      this.shutdownSignal,
    ].filter((signal): signal is AbortSignal => signal !== undefined)

    const signal = AbortSignal.any(signals)

    if (signal.aborted)
      throw new EditorApiError('cancelled', 'Request was cancelled before sending')
    const writing = body !== undefined && !options?.readOnly
    let sent = false

    try {
      const fetcher = this.fetcher
      sent = true

      const response = await fetcher(`${this.config.editorServerUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        ...body,
        redirect: 'error',
        cache: 'no-store',
        signal,
      })

      if (response.ok && options) return await options.readResponse(response)

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
          writing ? writeFailureOutcome(response.status, error.data.outcome) : 'not_applied',
          response.status,
        )
      }

      const parsed = schema?.safeParse(value)

      if (!parsed?.success)
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
