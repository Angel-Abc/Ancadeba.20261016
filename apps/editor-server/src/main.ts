import { createEditorServer } from './server.js'
import { loadEditorServerConfig } from './config.js'
import { FileWorkspace } from './workspace.js'

const config = await loadEditorServerConfig()
const workspace = await FileWorkspace.open(config.workFolder)
const server = createEditorServer(config, workspace)

server.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

server.listen(config.port, config.host, () => {
  console.info(`Editor server listening at http://${config.host}:${config.port}`)
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
