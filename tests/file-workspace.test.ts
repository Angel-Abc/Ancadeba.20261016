import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'

describe('atomic workspace saves', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-workspace-save-', import.meta.url)))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps a complete version during concurrent saves from separate workspaces', async () => {
    const first = await FileWorkspace.open(root)
    const second = await FileWorkspace.open(root)
    const original = new Uint8Array(1024).fill(67)
    const large = new Uint8Array(10 * 1024 * 1024).fill(65)
    const small = new Uint8Array(1024 * 1024).fill(66)
    const target = join(root, 'game.bin')
    await writeFile(target, original)

    await Promise.all([first.write('game.bin', large), second.write('game.bin', small)])
    const saved = new Uint8Array(await readFile(target))
    expect(Buffer.from(saved).equals(saved[0] === 65 ? large : small)).toBe(true)
    expect(await readdir(root)).toEqual(['game.bin'])
  })

  it('creates, replaces, and empties files without leaving staging files', async () => {
    const workspace = await FileWorkspace.open(root)
    await expect(workspace.write('game.json', new TextEncoder().encode('original'))).resolves.toBe(
      true,
    )
    await expect(workspace.write('game.json', new TextEncoder().encode('updated'))).resolves.toBe(
      false,
    )
    expect(await readFile(join(root, 'game.json'), 'utf8')).toBe('updated')
    await expect(workspace.write('game.json', new Uint8Array())).resolves.toBe(false)
    expect(await readFile(join(root, 'game.json'), 'utf8')).toBe('')
    expect(await readdir(root)).toEqual(['game.json'])
  })
})
