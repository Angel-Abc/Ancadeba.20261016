import { describe, expect, it } from 'vite-plus/test'
import {
  previewSizeAfterKey,
  previewSizeRange,
  readLayoutPreferences,
  type LayoutStorage,
} from '../apps/editor-ui/src/workspaceLayout.js'

function storage(values: Record<string, string>): () => LayoutStorage {
  return () => ({
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
  })
}

describe('workspace layout preferences', () => {
  it('restores a stored layout and clamps the stored preview size', () => {
    expect(
      readLayoutPreferences(
        storage({ 'ancadeba.editor.layout': 'preview', 'ancadeba.editor.previewSize': '95' }),
      ),
    ).toEqual({ layout: 'preview', previewSize: previewSizeRange.maximum })
  })

  it('falls back to the split layout when storage is empty, invalid, or unavailable', () => {
    const defaults = { layout: 'split', previewSize: previewSizeRange.initial }

    expect(readLayoutPreferences(storage({}))).toEqual(defaults)
    expect(
      readLayoutPreferences(
        storage({ 'ancadeba.editor.layout': 'wide', 'ancadeba.editor.previewSize': 'large' }),
      ),
    ).toEqual(defaults)
    expect(
      readLayoutPreferences(() => {
        throw new Error('Storage is blocked')
      }),
    ).toEqual(defaults)
  })

  it('resizes the preview from the splitter keyboard keys within the allowed range', () => {
    expect(previewSizeAfterKey(50, 'ArrowLeft')).toBe(55)
    expect(previewSizeAfterKey(50, 'ArrowRight')).toBe(45)
    expect(previewSizeAfterKey(previewSizeRange.maximum, 'ArrowLeft')).toBe(
      previewSizeRange.maximum,
    )
    expect(previewSizeAfterKey(55, 'Home')).toBe(previewSizeRange.minimum)
    expect(previewSizeAfterKey(55, 'End')).toBe(previewSizeRange.maximum)
    expect(previewSizeAfterKey(55, 'Enter')).toBeUndefined()
  })
})
