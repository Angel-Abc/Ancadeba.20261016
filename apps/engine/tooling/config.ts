import { parseEngineConfig, type ConfigOverrides } from '@ancadeba/schemas'
import type { Plugin } from 'vite-plus'
import { loadAppConfig } from '../../../tooling/app-config.js'

export const engineConfigFile = new URL('../config.json', import.meta.url)

export function loadEngineConfig(file = engineConfigFile, env: ConfigOverrides = process.env) {
  return loadAppConfig(
    file,
    (value, overrides) => {
      const config = parseEngineConfig(value, overrides)
      // URL also verifies the authority of absolute URLs before starting Vite.
      const url = new URL(config.gameUrl, 'http://localhost/')
      if (url.username || url.password) {
        throw new Error('gameUrl must not contain credentials')
      }
      return config
    },
    env,
  )
}

export function engineRuntimeConfigPlugin(gameUrl: string): Plugin {
  const source = JSON.stringify({ gameUrl })
  return {
    name: 'engine-runtime-config',
    configureServer(server) {
      const path = `${server.config.base}config.json`
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== path) {
          next()
          return
        }
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Cache-Control', 'no-store')
        response.end(source)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'config.json', source })
    },
  }
}
