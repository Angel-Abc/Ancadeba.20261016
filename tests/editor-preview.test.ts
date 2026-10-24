import { createEngine, type IEngineHost } from '@ancadeba/game-runtime'
import type { ILogger } from '@ancadeba/utilities'
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  EditorPreviewController,
  type PreviewStateListener,
} from '../apps/editor-ui/src/previewController.js'
import { EditorWorkspaceResources } from '../apps/editor-ui/src/workspaceResources.js'

function createPreview() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'))
  const cleanup = vi.fn<() => void>()
  const host = { mount: vi.fn<IEngineHost['mount']>().mockReturnValue(cleanup) }
  const logger: ILogger = {
    debug: () => '',
    info: () => '',
    warn: () => '',
    error: () => '',
  }
  const onStateChange = vi.fn<PreviewStateListener>()
  const createInstance = vi.fn((folder: string) =>
    createEngine({ resourceSource: new EditorWorkspaceResources(folder, fetcher), host, logger }),
  )
  const controller = new EditorPreviewController(createInstance, onStateChange)
  return { controller, fetcher, host, cleanup, onStateChange, createInstance }
}

describe('editor preview', () => {
  it('starts from the workspace file API and cleans up on stop', async () => {
    const { controller, fetcher, host, cleanup, onStateChange } = createPreview()
    fetcher.mockResolvedValueOnce(new Response('{"title":"Workspace game"}'))

    await controller.start('basic')

    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/files?path=basic%2Fgame.json', {
      cache: 'no-store',
    })
    expect(host.mount).toHaveBeenCalledExactlyOnceWith({ title: 'Workspace game' })
    expect(onStateChange.mock.calls).toEqual([['starting'], ['running']])

    controller.stop()
    controller.stop()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenLastCalledWith('stopped')
  })

  it('prevents duplicate starts and creates a fresh instance for another folder after stopping', async () => {
    const { controller, createInstance, fetcher, host } = createPreview()
    const first = controller.start('first')
    await controller.start('ignored')
    await first
    await controller.start('also ignored')
    expect(createInstance).toHaveBeenCalledTimes(1)

    controller.stop()
    await controller.start('second')

    expect(createInstance.mock.calls).toEqual([['first'], ['second']])
    expect(fetcher).toHaveBeenLastCalledWith('/api/files?path=second%2Fgame.json', {
      cache: 'no-store',
    })
    expect(host.mount).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing', '', 404],
    ['malformed', 'invalid JSON', 200],
    ['non-object', '[]', 200],
  ])('shows a %s game error and allows retrying', async (_reason, body, status) => {
    const { controller, fetcher, host, onStateChange } = createPreview()
    fetcher.mockResolvedValueOnce(new Response(body, { status }))

    await controller.start('basic')

    expect(host.mount).not.toHaveBeenCalled()
    expect(onStateChange).toHaveBeenLastCalledWith('stopped', expect.any(String))
    await controller.start('basic')
    expect(onStateChange).toHaveBeenLastCalledWith('running')
  })

  it('shows folder validation failures without fetching', async () => {
    const { controller, fetcher, onStateChange } = createPreview()

    await controller.start('../outside')

    expect(fetcher).not.toHaveBeenCalled()
    expect(onStateChange).toHaveBeenLastCalledWith('stopped', expect.any(String))
    await controller.start('')
    expect(onStateChange).toHaveBeenLastCalledWith('running')
  })

  it('prevents a cancelled start from overwriting a new preview status', async () => {
    const { controller, fetcher, host, onStateChange } = createPreview()
    let finish!: (response: Response) => void
    fetcher.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    const first = controller.start('first')
    await Promise.resolve()
    controller.stop()
    const second = controller.start('second')
    await Promise.all([first, second])
    expect(onStateChange.mock.calls).toEqual([['starting'], ['stopped'], ['starting'], ['running']])

    finish(new Response('{"title":"Old game"}'))
    await Promise.resolve()
    await Promise.resolve()

    expect(host.mount).toHaveBeenCalledExactlyOnceWith({})
    expect(onStateChange).toHaveBeenLastCalledWith('running')
  })

  it('stops on disposal and ignores later requests', async () => {
    const { controller, createInstance, cleanup, onStateChange } = createPreview()
    await controller.start('')
    onStateChange.mockClear()

    controller.dispose()
    controller.dispose()
    await controller.start('basic')
    controller.stop()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(createInstance).toHaveBeenCalledTimes(1)
    expect(onStateChange).not.toHaveBeenCalled()
  })
})
