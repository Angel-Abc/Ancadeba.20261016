import type { IEngineHost } from '@ancadeba/game-runtime'
import { describe, expect, it, vi } from 'vite-plus/test'
import { ContainerBuilder } from '../apps/editor-ui/src/ioc/containerBuilder.js'
import type { EditorDependencies } from '../apps/editor-ui/src/ioc/factories/index.js'
import type { PreviewStateListener } from '../apps/editor-ui/src/previewController.js'
import type { ExportStateListener } from '../apps/editor-ui/src/exportController.js'

function gameDefinition(title: string) {
  return {
    'schema-version': '1.0.0' as const,
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    scenes: [] as string[],
  }
}

function gameData(title: string) {
  return {
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    scenes: new Map(),
  }
}

function createDependencies() {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(gameDefinition('Preview'))))
  const cleanup = vi.fn<() => void>()
  const host = { mount: vi.fn<IEngineHost['mount']>().mockReturnValue(cleanup) }
  const dependencies = {
    runtime: { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} } },
    fetcher,
    host,
    onPreviewStateChange: vi.fn<PreviewStateListener>(),
    download: vi.fn<(archive: Blob, fileName: string) => void>(),
    onExportStateChange: vi.fn<ExportStateListener>(),
  } satisfies EditorDependencies
  return { dependencies, cleanup }
}

describe('editor container', () => {
  it('builds lazily and wires the preview controller to its registered dependencies', async () => {
    const { dependencies, cleanup } = createDependencies()
    const container = new ContainerBuilder(dependencies).build()
    const controller = container.resolve('previewController')
    const info = vi.spyOn(container.resolve('logger'), 'info')

    expect(container.resolve('previewController')).toBe(controller)
    expect(container.resolve('host')).toBe(dependencies.host)
    expect(dependencies.fetcher).not.toHaveBeenCalled()
    expect(dependencies.onPreviewStateChange).not.toHaveBeenCalled()

    await controller.start('basic')

    expect(dependencies.fetcher).toHaveBeenCalledExactlyOnceWith(
      '/api/files?path=basic%2Fgame.json',
      {
        cache: 'no-store',
      },
    )
    expect(dependencies.host.mount).toHaveBeenCalledExactlyOnceWith(gameData('Preview'), {
      input: undefined,
      messages: expect.anything(),
      timers: expect.anything(),
      actions: expect.anything(),
      lifecycle: expect.anything(),
    })
    expect(dependencies.onPreviewStateChange.mock.calls).toEqual([['starting'], ['running']])
    expect(dependencies.onExportStateChange).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith('Engine', 'The engine workspace is ready.')

    controller.stop()
    await controller.start('second')
    expect(dependencies.fetcher).toHaveBeenLastCalledWith('/api/files?path=second%2Fgame.json', {
      cache: 'no-store',
    })
    controller.dispose()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('creates fresh preview engines and session buses for each selected folder', async () => {
    const { dependencies } = createDependencies()
    const container = new ContainerBuilder(dependencies).build()
    const createPreviewEngine = container.resolve('createPreviewEngine')
    const first = createPreviewEngine('first')
    const second = createPreviewEngine('second')

    expect(first).not.toBe(second)
    expect(dependencies.fetcher).not.toHaveBeenCalled()
    await Promise.all([first.start(), second.start()])
    expect(first.messages).not.toBe(second.messages)
    expect(dependencies.fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/files?path=first%2Fgame.json',
      '/api/files?path=second%2Fgame.json',
    ])

    first.stop()
    expect(second.state).toBe('running')
    const previousBus = first.messages
    await first.start()
    expect(first.messages).not.toBe(previousBus)
    first.stop()
    second.stop()
  })

  it('wires export requests, state changes, and archive downloads through the container', async () => {
    const { dependencies } = createDependencies()
    const bytes = new Uint8Array([80, 75, 3, 4])
    dependencies.fetcher.mockResolvedValueOnce(
      new Response(bytes, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="basic.zip"',
        },
      }),
    )
    const container = new ContainerBuilder(dependencies).build()
    const controller = container.resolve('exportController')

    expect(container.resolve('exportController')).toBe(controller)
    await controller.export(' basic/ ')

    expect(dependencies.fetcher).toHaveBeenCalledExactlyOnceWith(
      '/api/exports',
      expect.objectContaining({
        method: 'POST',
        body: '{"path":"basic"}',
      }),
    )
    expect(dependencies.onExportStateChange.mock.calls).toEqual([
      ['exporting'],
      ['ready', 'basic.zip'],
    ])
    expect(dependencies.download).toHaveBeenCalledTimes(1)
    const [archive, fileName] = dependencies.download.mock.calls[0]!
    expect(fileName).toBe('basic.zip')
    expect(new Uint8Array(await archive.arrayBuffer())).toEqual(bytes)
    expect(dependencies.onPreviewStateChange).not.toHaveBeenCalled()
    expect(dependencies.host.mount).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('isolates controller state and logging services between builds', async () => {
    const { dependencies, cleanup } = createDependencies()
    const builder = new ContainerBuilder(dependencies)
    const first = builder.build()
    const second = builder.build()
    const firstPreview = first.resolve('previewController')
    const secondPreview = second.resolve('previewController')

    expect(firstPreview).not.toBe(secondPreview)
    expect(first.resolve('exportController')).not.toBe(second.resolve('exportController'))
    expect(first.resolve('logger')).not.toBe(second.resolve('logger'))
    expect(first.resolve('console')).not.toBe(second.resolve('console'))
    await Promise.all([firstPreview.start('first'), secondPreview.start('second')])

    firstPreview.dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
    const fetches = dependencies.fetcher.mock.calls.length
    await firstPreview.start('ignored')
    await secondPreview.start('already-running')
    expect(dependencies.fetcher).toHaveBeenCalledTimes(fetches)
    secondPreview.dispose()
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
