import { describe, expect, it } from 'vite-plus/test'
import { gameSchema, sceneSchema, textComponentSchema } from '@ancadeba/schemas'
import { assembleGameData } from '@ancadeba/game-runtime'

const text = {
  id: 'story',
  type: 'text',
  text: 'First line\nSecond line',
  placement: { row: 2, column: 3 },
}
const scene = {
  'schema-version': '1.0.0',
  id: 'standard',
  title: 'Standard',
  description: '',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 12, columns: 12 } },
  components: [text],
}

describe('text component definitions', () => {
  it('defaults to a single grid cell and body text aligned to the start', () => {
    expect(textComponentSchema.parse(text)).toEqual({
      ...text,
      placement: { row: 2, column: 3, rowSpan: 1, columnSpan: 1 },
      presentation: { variant: 'body', align: 'start' },
    })
    expect(textComponentSchema.parse({ ...text, text: '' }).text).toBe('')
  })

  it('supports spans, headings, and alignment at the exact grid boundary', () => {
    const definition = sceneSchema.parse({
      ...scene,
      components: [
        {
          ...text,
          placement: { row: 2, column: 3, rowSpan: 11, columnSpan: 10 },
          presentation: { variant: 'heading', align: 'end' },
        },
      ],
    })
    expect(definition.components[0]?.presentation).toEqual({ variant: 'heading', align: 'end' })
  })

  it.each([
    { row: 0, column: 1 },
    { row: -1, column: 1 },
    { row: 1.5, column: 1 },
    { row: 1, column: 0 },
    { row: 1, column: -1 },
    { row: 1, column: 1.5 },
    { row: 1, column: 1, rowSpan: 0 },
    { row: 1, column: 1, columnSpan: -1 },
    { row: 1, column: 1, rowSpan: 1.5 },
    { row: 1, column: 1, columnSpan: 1.5 },
    { row: 13, column: 1 },
    { row: 1, column: 13 },
    { row: 12, column: 1, rowSpan: 2 },
    { row: 1, column: 12, columnSpan: 2 },
  ])('rejects invalid or out-of-bounds placement %#', (placement) => {
    expect(sceneSchema.safeParse({ ...scene, components: [{ ...text, placement }] }).success).toBe(
      false,
    )
  })

  it.each([
    { ...text, id: '' },
    { ...text, type: 'button' },
    { ...text, text: 12 },
    { ...text, presentation: { variant: 'script' } },
    { ...text, presentation: { align: 'justify' } },
  ])('rejects unsupported component definitions %#', (component) => {
    expect(sceneSchema.safeParse({ ...scene, components: [component] }).success).toBe(false)
  })

  it('rejects duplicate IDs while allowing intentional overlaps and empty scenes', () => {
    expect(sceneSchema.safeParse({ ...scene, components: [text, text] }).success).toBe(false)
    expect(
      sceneSchema.parse({ ...scene, components: [text, { ...text, id: 'overlay' }] }).components,
    ).toHaveLength(2)
    expect(sceneSchema.parse({ ...scene, components: [] }).components).toEqual([])
  })

  it('copies nested component configuration into runtime data', () => {
    const definition = sceneSchema.parse(scene)
    const game = gameSchema.parse({
      'schema-version': '1.0.0',
      id: 'demo',
      title: 'Demo',
      description: '',
      version: '1',
      scenes: ['standard'],
    })
    const assembled = assembleGameData(game, new Map([['standard', definition]]))
    definition.components[0]!.text = 'Changed'
    definition.components[0]!.placement.row = 7
    definition.components[0]!.presentation.align = 'end'
    expect(assembled.scenes.get('standard')?.components[0]).toEqual({
      ...text,
      placement: { row: 2, column: 3, rowSpan: 1, columnSpan: 1 },
      presentation: { variant: 'body', align: 'start' },
    })
  })
})
