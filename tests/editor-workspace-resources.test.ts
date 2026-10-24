import { describe, expect, it, vi } from 'vite-plus/test'
import { EditorWorkspaceResources } from '../apps/editor-ui/src/workspaceResources.js'

describe('editor workspace resources', () => {
  it.each([
    ['', 'game.json', 'game.json'],
    ['basic/', 'game.json', 'basic/game.json'],
    ['my game', 'dialogue/intro #1.txt', 'my game/dialogue/intro #1.txt'],
    ['basic', 'literal%2f.txt', 'basic/literal%2f.txt'],
  ])('reads %s / %s through the file API', async (folder, path, expectedPath) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Café'))
    const source = new EditorWorkspaceResources(folder, fetcher)

    await expect(source.readText(path)).resolves.toBe('Café')
    expect(fetcher.mock.contexts).toEqual([undefined])

    const expectedQuery = new URLSearchParams({ path: expectedPath })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/files?${expectedQuery.toString()}`, {
      cache: 'no-store',
    })
  })

  it('reads binary data without changing its bytes', async () => {
    const bytes = new Uint8Array([0, 128, 255, 42])
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes))
    const source = new EditorWorkspaceResources('basic', fetcher)

    await expect(source.readBytes('assets/sprite.bin')).resolves.toEqual(bytes)
  })

  it.each(['../other', '/', '/basic', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:/game', 'a\0b'])(
    'rejects an invalid game folder %j',
    (folder) => {
      const fetcher = vi.fn<typeof fetch>()
      expect(() => new EditorWorkspaceResources(folder, fetcher)).toThrow('game-relative path')
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each([
    '',
    '../secret',
    '/secret',
    '//server/file',
    'a/../../secret',
    'a\\b',
    'https://host/file',
  ])('rejects a resource outside its game folder %j', async (path) => {
    const fetcher = vi.fn<typeof fetch>()
    const source = new EditorWorkspaceResources('basic', fetcher)

    await expect(source.readText(path)).rejects.toThrow('game-relative path')
    await expect(source.readBytes(path)).rejects.toThrow('game-relative path')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports HTTP failures with the workspace-relative file path', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }))
    const source = new EditorWorkspaceResources('basic', fetcher)

    await expect(source.readText('game.json')).rejects.toThrow('basic/game.json: HTTP 404')
  })

  it('preserves the cause of network errors', async () => {
    const error = new Error('Offline')
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error)
    const source = new EditorWorkspaceResources('', fetcher)

    await expect(source.readText('game.json')).rejects.toMatchObject({
      message: 'Could not read workspace resource game.json',
      cause: error,
    })
  })
})
