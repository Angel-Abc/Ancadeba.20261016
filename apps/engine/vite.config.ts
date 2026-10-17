import { defineConfig } from 'vite-plus'
import { engineRuntimeConfigPlugin, loadEngineConfig } from './tooling/config.js'

const config = loadEngineConfig()

export default defineConfig({
  plugins: [engineRuntimeConfigPlugin(config.gameUrl)],
  server: {
    port: config.port,
    strictPort: true,
  },
})
