import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { build, createServer, preview } from 'vite-plus'
import { describe, expect, it } from 'vite-plus/test'
import { engineRuntimeConfigPlugin } from '../apps/engine/tooling/config.js'

describe('engine runtime configuration delivery', () => {
  it('serves JSON under the Vite base and permits deployment edits without rebuilding', async () => {
    const root = await mkdtemp(fileURLToPath(new URL('./.tmp-vite-', import.meta.url)))
    const options = {
      configFile: false as const,
      root,
      base: '/nested/',
      logLevel: 'silent' as const,
      plugins: [engineRuntimeConfigPlugin('/games/demo')],
    }
    const server = await createServer({
      ...options,
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
    })
    try {
      await server.listen()
      const address = server.httpServer?.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/nested/config.json?fresh=1`)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('cache-control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({ gameUrl: '/games/demo' })

      await writeFile(join(root, 'index.html'), '<!doctype html><title>Config test</title>')
      await build(options)
      const output = join(root, 'dist/config.json')
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ gameUrl: '/games/demo' })
      await writeFile(output, JSON.stringify({ gameUrl: 'https://cdn.example/changed/' }))
      const production = await preview({
        ...options,
        preview: { host: '127.0.0.1', port: 0, strictPort: true },
      })
      try {
        const previewAddress = production.httpServer.address() as AddressInfo
        const runtime = await fetch(`http://127.0.0.1:${previewAddress.port}/nested/config.json`)
        await expect(runtime.json()).resolves.toEqual({ gameUrl: 'https://cdn.example/changed/' })
      } finally {
        await new Promise<void>((resolve, reject) => {
          production.httpServer.close((error) => (error ? reject(error) : resolve()))
        })
      }
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
