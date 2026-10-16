import { defineConfig } from 'vite-plus'

export default defineConfig({
  server: {
    port: Number(process.env.EDITOR_UI_PORT ?? 5174),
    strictPort: true,
    proxy: {
      '/health': process.env.EDITOR_SERVER_URL ?? 'http://127.0.0.1:3000',
    },
  },
})
