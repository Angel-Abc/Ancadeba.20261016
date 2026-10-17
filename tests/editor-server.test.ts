import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { createEditorServer, maxWriteBytes } from '../apps/editor-server/src/server.js'
import {
  FileWorkspace,
  WorkspaceError,
  workspaceError,
} from '../apps/editor-server/src/workspace.js'

describe('editor server', () => {
  let server: Server
  let temp: string
  let root: string
  let baseUrl: string

  beforeAll(async () => {
    temp = await mkdtemp(fileURLToPath(new URL('./.tmp-editor-', import.meta.url)))
    root = join(temp, 'workspace')
    await mkdir(root)
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'hello.txt'), 'hello')
    const workspace = await FileWorkspace.open(root)
    server = createEditorServer({ workFolder: root, host: '127.0.0.1', port: 3100 }, workspace)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    await rm(temp, { recursive: true, force: true })
  })

  it('serves a JSON health response', async () => {
    const response = await fetch(`${baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it.each([
    ['GET', '/missing'],
    ['POST', '/health'],
  ])('returns 404 for %s %s', async (method, path) => {
    const response = await fetch(`${baseUrl}${path}`, { method })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
  })

  it('lists the root and nested directories without exposing host paths', async () => {
    const response = await fetch(`${baseUrl}/api/workspace`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      entries: [
        { name: 'folder', type: 'directory' },
        { name: 'hello.txt', type: 'file' },
      ],
    })
    const nested = await fetch(`${baseUrl}/api/workspace?path=folder`)
    await expect(nested.json()).resolves.toEqual({ entries: [] })
  })

  it('reads file bytes', async () => {
    const response = await fetch(`${baseUrl}/api/files?path=hello.txt`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(await response.text()).toBe('hello')
  })

  it('creates nested folders, round-trips binary files, and replaces contents', async () => {
    const url = `${baseUrl}/api/files?path=${encodeURIComponent('new folder/nested/file.bin')}`
    const contents = new Uint8Array([0, 1, 127, 128, 255])
    const created = await fetch(url, { method: 'PUT', body: contents })
    expect(created.status).toBe(201)
    const downloaded = await fetch(url)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(contents)
    const saved = await fetch(url, { method: 'PUT', body: 'updated' })
    expect(saved.status).toBe(204)
    expect(await saved.text()).toBe('')
    expect(await readFile(join(root, 'new folder/nested/file.bin'), 'utf8')).toBe('updated')
  })

  it('supports empty files', async () => {
    const response = await fetch(`${baseUrl}/api/files?path=empty.txt`, { method: 'PUT', body: '' })
    expect(response.status).toBe(201)
    expect((await readFile(join(root, 'empty.txt'))).length).toBe(0)
  })

  it.each([
    ['/api/files', 400],
    ['/api/files?path=missing.txt', 404],
    ['/api/workspace?path=missing', 404],
    ['/api/files?path=folder', 409],
    ['/api/workspace?path=hello.txt', 409],
    ['/api/files?path=hello.txt/child', 409],
  ])('returns a useful error for %s', async (path, status) => {
    const response = await fetch(`${baseUrl}${path}`)
    expect(response.status).toBe(status)
    const body = await response.text()
    expect(body).not.toContain(root)
    expect(JSON.parse(body)).toHaveProperty('error')
  })

  it.each([
    ['../outside.txt', 403],
    ['folder/../../outside.txt', 403],
    ['/absolute.txt', 400],
    ['C:/outside.txt', 400],
    ['folder\\outside.txt', 400],
    ['hello.txt:stream', 400],
    ['folder/../hello.txt', 403],
    ['folder/./hello.txt', 400],
    ['trailing. /file', 400],
    ['NUL.txt', 400],
    ['COM¹.txt', 400],
    ['CONOUT$', 400],
    ['bad\0name', 400],
  ])('rejects unsafe workspace path %j', async (path, status) => {
    const query = encodeURIComponent(path)
    for (const method of ['GET', 'PUT']) {
      const response = await fetch(`${baseUrl}/api/files?path=${query}`, {
        method,
        ...(method === 'PUT' ? { body: 'forbidden' } : {}),
      })
      expect(response.status).toBe(status)
    }
  })

  it('rejects directory writes and file parents', async () => {
    for (const path of ['folder', 'hello.txt/new.txt']) {
      const response = await fetch(`${baseUrl}/api/files?path=${path}`, {
        method: 'PUT',
        body: 'no',
      })
      expect(response.status).toBe(409)
    }
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hello')
  })

  it('hides directory links and rejects reads, listings, and writes through them', async () => {
    const outside = join(temp, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const link = join(root, 'linked')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const listing = await fetch(`${baseUrl}/api/workspace`)
    const body = (await listing.json()) as { entries: { name: string }[] }
    expect(body.entries.some((entry) => entry.name === 'linked')).toBe(false)
    for (const [method, path] of [
      ['GET', '/api/files?path=linked/secret.txt'],
      ['GET', '/api/workspace?path=linked'],
      ['PUT', '/api/files?path=linked/new/deep.txt'],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === 'PUT' ? { body: 'no' } : {}),
      })
      expect(response.status).toBe(403)
    }
    await expect(readFile(join(outside, 'new/deep.txt'))).rejects.toHaveProperty('code', 'ENOENT')
    await expect(FileWorkspace.open(link)).rejects.toThrow('Cannot open workFolder')
  })

  it('rejects work folders that are files or missing', async () => {
    await expect(FileWorkspace.open(join(root, 'hello.txt'))).rejects.toThrow(
      'Cannot open workFolder',
    )
    await expect(FileWorkspace.open(join(temp, 'nonexistent'))).rejects.toThrow(
      'Cannot open workFolder',
    )
  })

  it('rejects oversized writes before creating folders', async () => {
    const response = await fetch(`${baseUrl}/api/files?path=oversized/file.bin`, {
      method: 'PUT',
      body: new Uint8Array(maxWriteBytes + 1),
    })
    expect(response.status).toBe(413)
    await expect(readFile(join(root, 'oversized/file.bin'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )
  })

  it('enforces the write limit on chunked requests', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${baseUrl}/api/files?path=chunked/file.bin`,
        { method: 'PUT' },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode))
        },
      )
      request.on('error', reject)
      request.write(Buffer.alloc(maxWriteBytes))
      request.end(Buffer.alloc(1))
    })
    expect(status).toBe(413)
    await expect(readFile(join(root, 'chunked/file.bin'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('accepts a file exactly at the size limit', async () => {
    const response = await fetch(`${baseUrl}/api/files?path=limit.bin`, {
      method: 'PUT',
      body: new Uint8Array(maxWriteBytes),
    })
    expect(response.status).toBe(201)
    expect((await readFile(join(root, 'limit.bin'))).length).toBe(maxWriteBytes)
  })

  it('maps filesystem failures without leaking internal paths', () => {
    expect(workspaceError(Object.assign(new Error(root), { code: 'EACCES' })).status).toBe(403)
    expect(workspaceError(new Error(root)).message).toBe('Workspace operation failed')
    const error = new WorkspaceError(400, 'Invalid workspace path')
    expect(workspaceError(error)).toBe(error)
  })
})
