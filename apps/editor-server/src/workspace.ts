import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { WorkspaceListing } from '@ancadeba/schemas'

export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface WorkspaceService {
  list(path: string): Promise<WorkspaceListing>
  read(path: string): Promise<Uint8Array>
  write(path: string, contents: Uint8Array): Promise<boolean>
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function workspaceError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  if (hasCode(error, 'ENOENT')) return new WorkspaceError(404, 'Resource not found')
  if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM') || hasCode(error, 'ELOOP')) {
    return new WorkspaceError(403, 'Access denied')
  }
  if (hasCode(error, 'ENOTDIR') || hasCode(error, 'EISDIR') || hasCode(error, 'EEXIST')) {
    return new WorkspaceError(409, 'File or directory conflict')
  }
  return new WorkspaceError(500, 'Workspace operation failed')
}

export class FileWorkspace implements WorkspaceService {
  private constructor(private readonly root: string) {}

  static async open(workFolder: string): Promise<FileWorkspace> {
    try {
      const info = await lstat(workFolder)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('workFolder must be an existing directory, not a link or file')
      }
      return new FileWorkspace(await realpath(workFolder))
    } catch (error) {
      throw new Error(
        'Cannot open workFolder. Configure an existing, accessible directory in editor-server/config.json.',
        { cause: error },
      )
    }
  }

  private segments(path: string, allowRoot: boolean): string[] {
    if (path === '' && allowRoot) return []
    if (isAbsolute(path) || path.startsWith('/') || path.includes('\\')) {
      throw new WorkspaceError(400, 'Use a workspace-relative path with / separators')
    }
    const parts = path.split('/')
    if (parts.includes('..')) {
      throw new WorkspaceError(403, 'Path is outside the workspace')
    }
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          /[<>:"|?*]/.test(part) ||
          part.split('').some((character) => character.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
      )
    ) {
      throw new WorkspaceError(400, 'Invalid workspace path')
    }
    return parts
  }

  private async inspect(path: string) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new WorkspaceError(403, 'Links are not accessible')
    const canonical = await realpath(path)
    const fromRoot = relative(this.root, canonical)
    if (
      fromRoot === '..' ||
      fromRoot.startsWith('../') ||
      fromRoot.startsWith('..\\') ||
      isAbsolute(fromRoot)
    ) {
      throw new WorkspaceError(403, 'Path is outside the workspace')
    }
    return info
  }

  private async locate(path: string, allowRoot = false, createParents = false) {
    const parts = this.segments(path, allowRoot)
    let current = this.root
    const rootInfo = await this.inspect(current)
    if (!rootInfo.isDirectory()) throw new WorkspaceError(409, 'Expected a directory')
    for (const [index, part] of parts.entries()) {
      current = resolve(current, part)
      const leaf = index === parts.length - 1
      try {
        const info = await this.inspect(current)
        if (!leaf && !info.isDirectory()) throw new WorkspaceError(409, 'Expected a directory')
      } catch (error) {
        if (!createParents || !hasCode(error, 'ENOENT')) throw error
        if (leaf) return current
        try {
          await mkdir(current)
        } catch (mkdirError) {
          if (!hasCode(mkdirError, 'EEXIST')) throw mkdirError
        }
        if (!(await this.inspect(current)).isDirectory()) {
          throw new WorkspaceError(409, 'Expected a directory')
        }
      }
    }
    return current
  }

  async list(path: string): Promise<WorkspaceListing> {
    const target = await this.locate(path, true)
    if (!(await this.inspect(target)).isDirectory())
      throw new WorkspaceError(409, 'Expected a directory')
    const entries = await readdir(target, { withFileTypes: true })
    return {
      entries: entries
        .filter((entry) => !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const target = await this.locate(path)
    if (!(await this.inspect(target)).isFile()) throw new WorkspaceError(409, 'Expected a file')
    return readFile(target)
  }

  async write(path: string, contents: Uint8Array): Promise<boolean> {
    const target = await this.locate(path, false, true)
    let exists = false
    try {
      const info = await this.inspect(target)
      if (!info.isFile()) throw new WorkspaceError(409, 'Expected a file')
      exists = true
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
    await writeFile(target, contents)
    return !exists
  }
}
