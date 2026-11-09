import { describe, expect, it } from 'vite-plus/test'
import { projectViewSchema } from '@ancadeba/editor-core'
import {
  comparisonLabels,
  labelled,
  questChoices,
  sceneChoices,
} from '../apps/editor-ui/src/choiceLabels.js'
import {
  bindingFieldLabel,
  combatOwnerLabel,
  textBindingChoices,
} from '../apps/editor-ui/src/textBindingChoices.js'

const scene = (id: string, type: 'game' | 'stand-alone', title: string, titleKey?: string) => ({
  'schema-version': '1.0.0',
  id,
  type,
  title,
  ...(titleKey ? { titleKey } : {}),
  screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
  components: [],
})

const opponent = (path: string) => ({
  label: 'Advanced opponent',
  combatStats: {
    health: { source: 'game.state', path: ['combat', path] },
    maximumHealth: 20,
    attack: 2,
    defense: 1,
    guard: 1,
  },
})

const view = projectViewSchema.parse({
  revision: 'one',
  game: null,
  scenes: [
    scene('ember', 'game', 'Wardrobe'),
    scene('gallery', 'game', 'Wardrobe'),
    scene('harbour', 'game', '', 'harbour.title'),
    scene('menu', 'stand-alone', 'Main menu'),
  ],
  diagnostics: [],
  translations: { 'harbour.title': 'Old harbour', 'quest.survey': 'A harbour survey' },
  quests: {
    survey: {
      'schema-version': '1.0.0',
      id: 'survey',
      labelKey: 'quest.survey',
      stages: [
        {
          id: 'start',
          objectives: [
            { id: 'visit', label: 'Visit', when: [{ type: 'scene-is', scene: 'harbour' }] },
          ],
        },
      ],
    },
  },
  inventory: {
    'schema-version': '1.0.0',
    itemTypes: {},
    owners: {
      sentinel: opponent('sentinel'),
      keeper: opponent('keeper'),
      player: { ...opponent('player'), label: 'Player' },
    },
    items: {},
  },
})

describe('editor choice labels', () => {
  it('names scenes like the explorer and filters by scene type', () => {
    expect(sceneChoices(view)).toEqual([
      ['ember', 'Wardrobe (ember)'],
      ['gallery', 'Wardrobe (gallery)'],
      ['harbour', 'Old harbour'],
      ['menu', 'Main menu'],
    ])
    expect(sceneChoices(view, 'game').map(([id]) => id)).toEqual(['ember', 'gallery', 'harbour'])
  })

  it('names quests and labels stored codes, falling back to sentence case', () => {
    expect(questChoices(view)).toEqual([['survey', 'A harbour survey']])
    expect(labelled(['gte', 'unknown-code'], comparisonLabels)).toEqual([
      ['gte', 'At least'],
      ['unknown-code', 'Unknown code'],
    ])
  })

  it('tells same-named combat owners apart and names binding fields', () => {
    expect(combatOwnerLabel(view, 'sentinel')).toBe('Advanced opponent (sentinel)')
    expect(combatOwnerLabel(view, 'player')).toBe('Player')
    expect(bindingFieldLabel('xpToNextLevel')).toBe('XP still needed')
    expect(bindingFieldLabel('defense')).toBe('Defense')

    const labels = textBindingChoices(view).map((choice) => choice.label)
    expect(labels).toContain('Combat stats · Advanced opponent (keeper) · Maximum health')
    expect(new Set(labels).size).toBe(labels.length)
  })
})
