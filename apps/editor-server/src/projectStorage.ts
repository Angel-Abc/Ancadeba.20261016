import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EditorError, projectRegistryFile } from '@ancadeba/editor-core'
import type { ProjectWorkspace } from './editorProjectRepository.js'
import { restoreHistoryFiles } from './historyFiles.js'
import { workspaceError } from './workspace.js'

const registrySchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(z.tuple([z.string(), z.string()])),
})

/** Workspace-owned aliases preserve browser saves across moves and isolate reused folder names. */
export class ProjectStorage {
  constructor(private readonly workspace: ProjectWorkspace) {}

  private key(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  private async read() {
    let bytes: Uint8Array | undefined

    try {
      bytes = await this.workspace.read(projectRegistryFile)
    } catch (error) {
      if (workspaceError(error).status !== 404) throw error
    }

    if (!bytes) return { bytes, projects: new Map<string, string>() }

    try {
      const parsed = registrySchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))

      return { bytes, projects: new Map(parsed.projects) }
    } catch {
      throw new EditorError(
        500,
        'project_storage_invalid',
        `Project storage metadata is damaged. Inspect ${projectRegistryFile} before continuing.`,
      )
    }
  }

  async get(path: string): Promise<string | undefined> {
    return (await this.read()).projects.get(this.key(path))
  }

  private async change(
    update: (projects: Map<string, string>) => void,
    onlyIfPresent = false,
  ): Promise<void> {
    const { bytes, projects } = await this.read()

    if (onlyIfPresent && !bytes) return
    update(projects)

    const after = Buffer.from(
      `${JSON.stringify({ version: 1, projects: [...projects] }, null, 2)}\n`,
    )

    await restoreHistoryFiles(this.workspace, '', [
      { file: projectRegistryFile, before: bytes, after },
    ])
  }

  /** Existing workspaces keep their original namespaces until project management is first used. */
  registerNew(path: string): Promise<void> {
    return this.change((projects) => projects.set(this.key(path), `project:${randomUUID()}`), true)
  }

  relocate(from: string, to: string, storageKey: string): Promise<void> {
    return this.change((projects) => {
      if (this.key(from) !== this.key(to)) projects.set(this.key(from), `project:${randomUUID()}`)
      projects.set(this.key(to), storageKey)
    })
  }

  release(path: string): Promise<void> {
    return this.change((projects) => projects.set(this.key(path), `project:${randomUUID()}`))
  }

  restore(path: string, storageKey: string): Promise<void> {
    return this.change((projects) => projects.set(this.key(path), storageKey))
  }
}
