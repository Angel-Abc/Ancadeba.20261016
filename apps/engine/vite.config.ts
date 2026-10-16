import { defineConfig } from 'vite-plus'

export default defineConfig({
  server: {
    port: Number(process.env.ENGINE_PORT ?? 5173),
    strictPort: true,
  },
})
