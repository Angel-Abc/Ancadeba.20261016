import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'

const failure = (code: string) => Object.assign(new Error(code), { code })

describe('workspace fallbacks for restrictive filesystems', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-workspace-fallback-', import.meta.url)))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // FAT, exFAT and some network shares reject hard links.
  const withoutHardLinks = () =>
    FileWorkspace.open(root, { link: () => Promise.reject(failure('EPERM')), rename })

  it('creates files by exclusive copy where hard links are unsupported', async () => {
    const workspace = await withoutHardLinks()
    await workspace.create('scene.json', new TextEncoder().encode('scene'))
    expect(await readFile(join(root, 'scene.json'), 'utf8')).toBe('scene')
    expect(await readdir(root)).toEqual(['scene.json'])
  })

  it('never replaces an existing file through the copy fallback', async () => {
    const workspace = await withoutHardLinks()
    await writeFile(join(root, 'scene.json'), 'original')
    await expect(
      workspace.create('scene.json', new TextEncoder().encode('replacement')),
    ).rejects.toMatchObject({ status: 409 })
    expect(await readFile(join(root, 'scene.json'), 'utf8')).toBe('original')
    expect(await readdir(root)).toEqual(['scene.json'])
  })

  it('retries a project folder move while another process briefly holds a handle', async () => {
    let attempts = 0

    const workspace = await FileWorkspace.open(root, {
      link,
      rename: async (from, to) => {
        if (++attempts === 1) throw failure('EBUSY')
        await rename(from, to)
      },
    })

    await mkdir(join(root, 'source'))
    await writeFile(join(root, 'source/game.json'), '{}')
    await workspace.moveDirectory('source', 'renamed')
    expect(attempts).toBe(2)
    expect(await readdir(root)).toEqual(['renamed'])
    expect(await readFile(join(root, 'renamed/game.json'), 'utf8')).toBe('{}')
  })
})
