import { describe, expect, it, vi } from 'vite-plus/test'
import {
  EditorExportController,
  type ExportStateListener,
} from '../apps/editor-ui/src/exportController.js'

function archiveResponse(name = 'basic.zip') {
  return new Response(new Uint8Array([80, 75, 3, 4]), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  })
}

function createController() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => archiveResponse())
  const download = vi.fn<(archive: Blob, fileName: string) => void>()
  const onStateChange = vi.fn<ExportStateListener>()
  const controller = new EditorExportController(fetcher, download, onStateChange)
  return { controller, fetcher, download, onStateChange }
}

describe('editor export controller', () => {
  it('exports the selected game folder and delivers the ZIP download', async () => {
    const { controller, fetcher, download, onStateChange } = createController()
    await controller.export(' basic/ ')

    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      '/api/exports',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"path":"basic"}',
      }),
    )
    expect(fetcher.mock.contexts).toEqual([undefined])
    expect(download).toHaveBeenCalledTimes(1)
    const [archive, fileName] = download.mock.calls[0]!
    expect(new Uint8Array(await archive.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]))
    expect(fileName).toBe('basic.zip')
    expect(onStateChange.mock.calls).toEqual([['exporting'], ['ready', 'basic.zip']])
  })

  it('supports exporting the workspace root', async () => {
    const { controller, fetcher } = createController()
    await controller.export('')
    expect(fetcher).toHaveBeenCalledWith(
      '/api/exports',
      expect.objectContaining({ body: '{"path":""}' }),
    )
  })

  it('reports build failures and permits retrying', async () => {
    const { controller, fetcher, download, onStateChange } = createController()
    fetcher.mockResolvedValueOnce(new Response('{"error":"Check game.json"}', { status: 422 }))
    await controller.export('basic')
    expect(download).not.toHaveBeenCalled()
    expect(onStateChange).toHaveBeenLastCalledWith('error', 'Check game.json')

    await controller.export('basic')
    expect(download).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenLastCalledWith('ready', 'basic.zip')
  })

  it('handles non-JSON server errors', async () => {
    const { controller, fetcher, onStateChange } = createController()
    fetcher.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
    await controller.export('')
    expect(onStateChange).toHaveBeenLastCalledWith('error', 'Export failed: HTTP 503')
  })

  it('does not download a successful response with the wrong content type', async () => {
    const { controller, fetcher, download, onStateChange } = createController()
    fetcher.mockResolvedValueOnce(new Response('<html>fallback</html>'))
    await controller.export('')
    expect(download).not.toHaveBeenCalled()
    expect(onStateChange).toHaveBeenLastCalledWith(
      'error',
      'The server did not return a game archive',
    )
  })

  it('rejects an invalid folder without making a request', async () => {
    const { controller, fetcher, onStateChange } = createController()
    await controller.export('../outside')
    expect(fetcher).not.toHaveBeenCalled()
    expect(onStateChange).toHaveBeenLastCalledWith('error', expect.any(String))
  })

  it('prevents duplicate exports while a request is pending', async () => {
    const { controller, fetcher, download } = createController()
    let finish!: (response: Response) => void
    fetcher.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    const pending = controller.export('basic')
    await controller.export('other')
    expect(fetcher).toHaveBeenCalledTimes(1)
    finish(archiveResponse())
    await pending
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('aborts on disposal and ignores a response that arrives afterward', async () => {
    const { controller, fetcher, download, onStateChange } = createController()
    let finish!: (response: Response) => void
    fetcher.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    const pending = controller.export('basic')
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    controller.dispose()
    expect(signal?.aborted).toBe(true)
    finish(archiveResponse())
    await pending
    await controller.export('other')
    expect(download).not.toHaveBeenCalled()
    expect(onStateChange.mock.calls).toEqual([['exporting']])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uses a safe fallback filename for an unexpected attachment name', async () => {
    const { controller, fetcher, download } = createController()
    fetcher.mockResolvedValueOnce(archiveResponse('../unexpected.zip'))
    await controller.export('')
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'game.zip')
  })
})
