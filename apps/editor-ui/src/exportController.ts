import { normalizeGameFolder } from './workspaceResources.js'

export type ExportState = 'idle' | 'exporting' | 'ready' | 'error'

export type ExportStateListener = (state: ExportState, message?: string) => void

export class EditorExportController {
  private request: AbortController | undefined
  private disposed = false

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly download: (archive: Blob, fileName: string) => void,
    private readonly onStateChange: ExportStateListener,
    private readonly confirmExport: () => boolean = () => true,
  ) {}

  async export(folder: string): Promise<void> {
    if (this.disposed || this.request) return

    if (!this.confirmExport()) return

    const request = new AbortController()
    this.request = request

    try {
      const path = normalizeGameFolder(folder)
      this.onStateChange('exporting')
      const fetcher = this.fetcher

      const response = await fetcher('/api/exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
        signal: request.signal,
      })

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => undefined)

        const message =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : `Export failed: HTTP ${response.status}`

        throw new Error(message)
      }

      if (response.headers.get('content-type')?.split(';')[0] !== 'application/zip') {
        throw new Error('The server did not return a game archive')
      }

      const archive = await response.blob()

      if (this.request !== request) return
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1]
      const fileName = name && /^[a-zA-Z0-9_-]+\.zip$/.test(name) ? name : 'game.zip'
      this.download(archive, fileName)
      this.onStateChange('ready', fileName)
    } catch (error) {
      if (this.request === request) {
        this.onStateChange('error', error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (this.request === request) this.request = undefined
    }
  }

  reset(): void {
    this.request?.abort()
    this.request = undefined

    if (!this.disposed) this.onStateChange('idle')
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}
