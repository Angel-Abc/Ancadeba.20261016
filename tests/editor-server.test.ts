import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { createEditorServer } from '../apps/editor-server/src/server.js'

describe('editor server', () => {
  const server = createEditorServer()
  let baseUrl: string

  beforeAll(async () => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
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
})
