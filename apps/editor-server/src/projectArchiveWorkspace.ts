import type { ProjectWorkspace } from './editorProjectRepository.js'
import { WorkspaceError } from './workspace.js'

/** A read-only filesystem view lets the normal repository validate imports before writing. */
export class ProjectArchiveWorkspace implements ProjectWorkspace {
  constructor(private readonly files: Readonly<Record<string, Uint8Array>>) {}

  async read(path: string): Promise<Uint8Array> {
    if (!Object.hasOwn(this.files, path)) throw new WorkspaceError(404, 'Archive file not found')

    return this.files[path]!
  }

  async list(path: string) {
    const prefix = path ? `${path}/` : ''
    const entries = new Map<string, 'file' | 'directory'>()

    for (const file of Object.keys(this.files)) {
      if (!file.startsWith(prefix)) continue
      const relative = file.slice(prefix.length)
      const name = relative.split('/')[0]!
      entries.set(name, relative.includes('/') ? 'directory' : 'file')
    }

    if (path && !entries.size) throw new WorkspaceError(404, 'Archive directory not found')

    return { entries: [...entries].map(([name, type]) => ({ name, type })) }
  }

  write(): Promise<boolean> {
    return Promise.reject(new WorkspaceError(403, 'Archive is read-only'))
  }
  create(): Promise<void> {
    return Promise.reject(new WorkspaceError(403, 'Archive is read-only'))
  }
  removeCreated(): Promise<void> {
    return Promise.reject(new WorkspaceError(403, 'Archive is read-only'))
  }
}
