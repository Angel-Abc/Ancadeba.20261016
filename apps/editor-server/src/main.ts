import { createEditorServer } from './server.js'
import { loadEditorServerConfig } from './config.js'
import { FileWorkspace } from './workspace.js'
import { WorkspaceGameExporter } from './gameExports.js'
import { buildGame } from './buildGame.js'
import { writeGameArchive } from './gameArchive.js'

const config = await loadEditorServerConfig()
const workspace = await FileWorkspace.open(config.workFolder)
const exports = new WorkspaceGameExporter(workspace, buildGame, writeGameArchive)
const server = createEditorServer(config, workspace, exports)

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
