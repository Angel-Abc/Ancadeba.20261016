export const workspaceLayouts = ['edit', 'split', 'preview'] as const

export type WorkspaceLayout = (typeof workspaceLayouts)[number]

export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface WorkspaceLayoutElements {
  shell: HTMLElement
  modes: HTMLElement
  workspace: HTMLElement
  splitter: HTMLElement
  preview: HTMLElement
}

export interface WorkspaceLayoutPreferences {
  layout: WorkspaceLayout
  previewSize: number
}

const layoutKey = 'ancadeba.editor.layout'
const previewSizeKey = 'ancadeba.editor.previewSize'

/** Preview width as a percentage of the editor workspace. */
export const previewSizeRange = { minimum: 25, maximum: 80, initial: 50, step: 5 }

export function clampPreviewSize(size: number): number {
  return Math.min(previewSizeRange.maximum, Math.max(previewSizeRange.minimum, size))
}

/** Stored values are per-viewer conveniences; anything unreadable falls back to defaults. */
export function readLayoutPreferences(storage: () => LayoutStorage): WorkspaceLayoutPreferences {
  const read = (key: string) => {
    try {
      return storage().getItem(key)
    } catch {
      return null
    }
  }

  const storedLayout = read(layoutKey)
  const storedSize = Number(read(previewSizeKey))

  return {
    layout: workspaceLayouts.find((layout) => layout === storedLayout) ?? 'split',
    previewSize:
      Number.isFinite(storedSize) && storedSize > 0
        ? clampPreviewSize(storedSize)
        : previewSizeRange.initial,
  }
}

/** The splitter sits left of the preview, so moving it left widens the preview. */
export function previewSizeAfterKey(size: number, key: string): number | undefined {
  switch (key) {
    case 'ArrowLeft':
      return clampPreviewSize(size + previewSizeRange.step)
    case 'ArrowRight':
      return clampPreviewSize(size - previewSizeRange.step)
    case 'Home':
      return previewSizeRange.minimum
    case 'End':
      return previewSizeRange.maximum
    default:
      return undefined
  }
}

export function bindWorkspaceLayout(
  { shell, modes, workspace, splitter, preview }: WorkspaceLayoutElements,
  storage: () => LayoutStorage,
) {
  const abort = new AbortController()
  const signal = abort.signal
  let { layout, previewSize } = readLayoutPreferences(storage)

  const write = (key: string, value: string) => {
    try {
      storage().setItem(key, value)
    } catch {
      // Without storage the layout still works for this session.
    }
  }

  const apply = () => {
    shell.dataset.layout = layout

    for (const button of modes.querySelectorAll<HTMLElement>('[data-layout-mode]'))
      button.setAttribute('aria-pressed', String(button.dataset.layoutMode === layout))
    preview.style.setProperty('--preview-size', `${previewSize}%`)
    splitter.setAttribute('aria-valuenow', String(Math.round(previewSize)))
  }

  const setLayout = (next: WorkspaceLayout) => {
    layout = next
    write(layoutKey, next)
    apply()
  }

  const setPreviewSize = (next: number) => {
    previewSize = clampPreviewSize(next)
    apply()
  }

  const savePreviewSize = () => write(previewSizeKey, String(Math.round(previewSize)))

  splitter.setAttribute('aria-valuemin', String(previewSizeRange.minimum))
  splitter.setAttribute('aria-valuemax', String(previewSizeRange.maximum))

  modes.addEventListener(
    'click',
    (event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-layout-mode]')
          : null

      const next = workspaceLayouts.find((layout) => layout === button?.dataset.layoutMode)

      if (next) setLayout(next)
    },
    { signal },
  )

  splitter.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return

      event.preventDefault()
      splitter.setPointerCapture(event.pointerId)
      splitter.dataset.dragging = ''
    },
    { signal },
  )
  splitter.addEventListener(
    'pointermove',
    (event) => {
      if (!splitter.hasPointerCapture(event.pointerId)) return

      const bounds = workspace.getBoundingClientRect()

      if (bounds.width > 0) setPreviewSize(((bounds.right - event.clientX) / bounds.width) * 100)
    },
    { signal },
  )

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    splitter.addEventListener(
      type,
      () => {
        if (!('dragging' in splitter.dataset)) return

        delete splitter.dataset.dragging
        savePreviewSize()
      },
      { signal },
    )
  }

  splitter.addEventListener(
    'keydown',
    (event) => {
      const next = previewSizeAfterKey(previewSize, event.key)

      if (next === undefined) return

      event.preventDefault()
      setPreviewSize(next)
      savePreviewSize()
    },
    { signal },
  )

  apply()

  return {
    /** Starting the game from the editor-only layout brings the preview back into view. */
    revealPreview() {
      if (layout === 'edit') setLayout('split')
    },
    dispose() {
      abort.abort()
    },
  }
}
