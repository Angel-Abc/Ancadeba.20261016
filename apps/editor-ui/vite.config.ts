import { defineConfig } from 'vite-plus'
import { parseEditorUiConfig } from '@ancadeba/schemas'
import { loadAppConfig } from '../../tooling/app-config.js'

const config = loadAppConfig(new URL('./config.json', import.meta.url), (value, env) => {
  const parsed = parseEditorUiConfig(value, env)
  new URL(parsed.editorServerUrl)

  return parsed
})

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Capture validation and its dependencies before the runtime that uses them.
            { name: 'validation', test: /[\\/]packages[\\/]schemas[\\/]/ },
            {
              name: 'game-runtime',
              test: /[\\/]packages[\\/](?:game-runtime|ui-components|utilities)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: config.port,
    strictPort: true,
    proxy: {
      '/health': config.editorServerUrl,
      '/api': config.editorServerUrl,
    },
  },
})
