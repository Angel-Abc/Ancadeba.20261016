import { createEditorServer } from './server.js'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

const server = createEditorServer()

server.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

server.listen(port, host, () => {
  console.info(`Editor server listening at http://${host}:${port}`)
})

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error(error)
      process.exitCode = 1
    }
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
