import { createEditorServer } from './server.js'
import { loadEditorServerConfig } from './config.js'
import { FileWorkspace } from './workspace.js'
import { WorkspaceGameExporter } from './gameExports.js'
import { buildGame } from './buildGame.js'
import { writeGameArchive } from './gameArchive.js'

import { EditorCoordinator } from './editorCoordinator.js'
import { WorkspaceProjectRepository } from './editorProjectRepository.js'
import { EditorProjectService } from './editorProjectService.js'
import type { ErrorReporter } from './errorReporter.js'

const config = await loadEditorServerConfig()
const workspace = await FileWorkspace.open(config.workFolder)
const reportError: ErrorReporter = (context, error) => console.error(context, error)

const exports = new WorkspaceGameExporter(
  workspace,
  buildGame,
  writeGameArchive,
  undefined,
  reportError,
)

const projects = new EditorProjectService(
  new WorkspaceProjectRepository(workspace),
  new EditorCoordinator(),
)

const server = createEditorServer(config, workspace, exports, projects, reportError)

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
