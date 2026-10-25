import { defineConfig } from 'vite-plus'
import { engineRuntimeConfigPlugin, loadEngineConfig } from './tooling/config.js'
import { gameFilesPlugin } from './tooling/gameFiles.js'

const config = loadEngineConfig()

export default defineConfig({
  plugins: [engineRuntimeConfigPlugin(config.gameUrl), gameFilesPlugin()],
  server: {
    port: config.port,
    strictPort: true,
  },
})
