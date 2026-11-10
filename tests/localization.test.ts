import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vite-plus/test'
import { GameLoader, resolveText, type GameLanguagePreferences } from '@ancadeba/game-runtime'
import { gameSchema, languageCatalogSchema, selectLanguage } from '@ancadeba/schemas'
import { validateProject } from '@ancadeba/editor-core'
import { createTranslator, JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { editorLocalization } from '../apps/editor-ui/src/localization.js'
import { BrowserGameLanguagePreferences } from '@ancadeba/ui-components'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'

const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

const game = {
  'schema-version': '1.0.0',
  id: 'localized',
  titleKey: 'game.title',
  version: '1',
  scenes: ['welcome'],
  languages: { default: 'en', available: ['en', 'nl'] },
}

const scene = {
  'schema-version': '1.0.0',
  id: 'welcome',
  titleKey: 'welcome.title',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 4, columns: 4 } },
  components: [
    {
      id: 'greeting',
      type: 'text',
      textKey: 'welcome.greeting',
      placement: { row: 1, column: 1 },
      bindings: { score: { source: 'game.state', path: ['score'], fallback: '7' } },
    },
    {
      id: 'next',
      type: 'button',
      labelKey: 'welcome.next',
      placement: { row: 2, column: 1 },
    },
  ],
}

interface GameFiles {
  [path: string]: unknown
}

function documents(): GameFiles {
  return {
    'game.json': game,
    'scenes/welcome.json': scene,
    'languages/en/messages.json': {
      'game.title': 'Example',
      'welcome.title': 'Welcome',
      'welcome.greeting': 'Score: {{score}}',
      'welcome.next': 'Next',
    },
    'languages/nl/messages.json': {
      'game.title': 'Voorbeeld',
      'welcome.greeting': '{{score}} punten',
    },
  }
}

function loader(
  files: Record<string, unknown>,
  preferences: readonly string[] = [],
  storage?: GameLanguagePreferences,
) {
  return new GameLoader(
    new JsonResourceLoader(
      {
        readText: async (path) => {
          if (!Object.hasOwn(files, path)) throw new Error(`Missing resource: ${path}`)

          return JSON.stringify(files[path])
        },
        readBytes: async () => new Uint8Array(),
      },
      logger,
    ),
    preferences,
    storage,
  )
}

describe('game localization', () => {
  it('remembers language per game, restores it on later loads, and permits explicit overrides', async () => {
    const saved = new Map<string, string>()

    const write = vi.fn((id: string, language: string) => {
      saved.set(id, language)
    })

    const preferences: GameLanguagePreferences = {
      read: (id) => saved.get(id),
      write,
    }

    const files = documents()
    const first = await loader(files, [], preferences).load()
    const changed = vi.fn()
    const unsubscribe = first.localization!.subscribe(changed)
    expect(first.localization!.current.language).toBe('en')
    first.localization!.select('nl')
    first.localization!.select('nl')
    expect(first.localization!.current.title).toBe('Voorbeeld')
    expect(first.title).toBe('Voorbeeld')
    expect(first.language).toBe('nl')
    expect(changed).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledExactlyOnceWith('localized', 'nl')
    expect((await loader(files, [], preferences).load()).language).toBe('nl')
    expect((await loader(files, ['en'], preferences).load()).language).toBe('en')
    expect(
      (await loader({ ...files, 'game.json': { ...game, id: 'other' } }, [], preferences).load())
        .language,
    ).toBe('en')
    expect(() => first.localization!.select('../unknown')).toThrow('Unsupported game language')
    expect(first.localization!.current.language).toBe('nl')
    unsubscribe()
    first.localization!.select('en')
    expect(changed).toHaveBeenCalledOnce()
    saved.set('localized', 'unsupported')
    expect((await loader(files, [], preferences).load()).language).toBe('en')
  })

  it('keeps language switching available when browser storage access fails', async () => {
    const storage = new BrowserGameLanguagePreferences(() => {
      throw new Error('Storage blocked')
    })

    const data = await loader(documents(), [], storage).load()
    expect(data.language).toBe('en')
    expect(() => data.localization!.select('nl')).not.toThrow()
    expect(data.localization!.current.language).toBe('nl')
    expect((await loader(documents(), [], storage).load()).language).toBe('en')
  })

  it('loads key-only definitions, falls back per key, and resolves translated game bindings', async () => {
    const files = documents()
    const data = await loader(files, ['nl-NL']).load()
    expect(data.language).toBe('nl')
    expect(data.title).toBe('Voorbeeld')
    const welcome = data.scenes.get('welcome')!
    expect(welcome.title).toBe('Welcome')
    const greeting = welcome.components[0]!

    if (greeting.type !== 'text') throw new Error('Expected a text component')
    expect(resolveText(greeting, undefined).text).toBe('7 punten')
    expect(welcome.components[1]).toMatchObject({ label: 'Next' })
    expect(scene.components[0]).not.toHaveProperty('text')
    expect(validateProject(files)).toEqual([])
  })

  it('chooses the configured default for unsupported preferences', async () => {
    const data = await loader(documents(), ['fr-FR']).load()
    expect(data.language).toBe('en')
    expect(data.title).toBe('Example')
  })

  it.each([
    ['missing default key', {}],
    ['non-string value', { 'game.title': 42 }],
    [
      'blank title',
      {
        'game.title': ' ',
        'welcome.title': 'Welcome',
        'welcome.greeting': '',
        'welcome.next': 'Next',
      },
    ],
  ])('rejects %s', async (_reason, catalog) => {
    const files = { ...documents(), 'languages/en/messages.json': catalog }
    await expect(loader(files).load()).rejects.toThrow()
    expect(validateProject(files).some(({ file }) => file === 'languages/en/messages.json')).toBe(
      true,
    )
  })

  it('rejects translated undeclared bindings before mounting', async () => {
    const files = {
      ...documents(),
      'languages/nl/messages.json': { 'welcome.greeting': '{{unknown}}' },
    }

    await expect(loader(files, ['nl']).load()).rejects.toThrow('Undeclared or invalid text binding')
    expect(validateProject(files)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_translation',
          file: 'languages/nl/messages.json',
        }),
      ]),
    )
  })

  it('reports a missing declared catalog and does not treat I/O failures as missing translations', async () => {
    const files = documents()
    delete files['languages/nl/messages.json']
    await expect(loader(files, ['nl']).load()).rejects.toThrow('languages/nl/messages.json')
    expect(validateProject(files)).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: 'languages/nl/messages.json' })]),
    )
  })

  it('requires language configuration for translation keys', async () => {
    const files = { ...documents(), 'game.json': { ...game, languages: undefined } }
    await expect(loader(files).load()).rejects.toThrow('Translation keys require languages')
    expect(validateProject(files)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'missing_languages' })]),
    )
  })

  it.each([
    { default: '../en', available: ['../en'] },
    { default: 'en', available: ['nl'] },
    { default: 'en', available: ['en', 'EN'] },
    { default: 'en', available: ['en', 'nl/../../secret'] },
    { default: 'en', available: [] },
  ])('rejects invalid language declarations: %j', (languages) => {
    expect(gameSchema.safeParse({ ...game, languages }).success).toBe(false)
  })

  it('loads the localized sample from disk in both languages', async () => {
    const resources = new JsonResourceLoader(
      {
        readText: (path) =>
          readFile(new URL(`../sample-games/localized/${path}`, import.meta.url), 'utf8'),
        readBytes: async () => new Uint8Array(),
      },
      logger,
    )

    expect((await new GameLoader(resources).load()).title).toBe('Language example')
    expect((await new GameLoader(resources, ['nl']).load()).title).toBe('Taalvoorbeeld')
  })

  it('loads all basic sample text from complete English and Dutch catalogs without losing bindings', async () => {
    const read = (path: string) =>
      readFile(new URL(`../sample-games/basic/${path}`, import.meta.url), 'utf8')

    const resources = new JsonResourceLoader(
      { readText: read, readBytes: async () => new Uint8Array() },
      logger,
    )

    const en = languageCatalogSchema.parse(JSON.parse(await read('languages/en/messages.json')))
    const nl = languageCatalogSchema.parse(JSON.parse(await read('languages/nl/messages.json')))
    expect(Object.keys(nl).sort()).toEqual(Object.keys(en).sort())

    for (const [key, value] of Object.entries(en)) {
      expect(nl[key]?.trim(), key).not.toBe('')
      expect(nl[key]?.match(/{{[^}]+}}/g)?.sort() ?? [], key).toEqual(
        value.match(/{{[^}]+}}/g)?.sort() ?? [],
      )
    }

    const english = await new GameLoader(resources).load()
    const dutch = await new GameLoader(resources, ['nl-NL']).load()
    expect(english.title).toBe('Basic Game')
    expect(dutch).toMatchObject({ title: 'Basisspel', language: 'nl' })
    expect(dutch.scenes.get('start-screen')?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'new-game', label: 'Nieuw spel' }),
        expect.objectContaining({ id: 'load-game', label: 'Spel laden' }),
      ]),
    )
    expect(dutch.scenes.get('standard')?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'location-title', text: 'In het museum' }),
        expect.objectContaining({
          id: 'narrative',
          text: nl['scenes.standard.components.narrative.text'],
        }),
      ]),
    )
    const footer = dutch.scenes.get('inventory')?.components.find(({ id }) => id === 'footer')

    if (footer?.type !== 'text') throw new Error('Expected the inventory footer')
    expect(resolveText(footer, undefined).text).toContain('Gezondheid 40 / 40')

    for (const path of [
      'game.json',
      ...[...english.scenes.keys()].map((id) => `scenes/${id}.json`),
    ]) {
      expect(await read(path), path).not.toMatch(/"(?:title|description|text|label)"\s*:\s*"/)
    }
  })

  it('includes catalog edits in project revisions and reports invalid JSON at its source', async () => {
    const files = documents()

    const workspace: ProjectWorkspace = {
      list: async () => ({ entries: [] }),
      read: async (path) => new TextEncoder().encode(JSON.stringify(files[path])),
      write: async () => true,
      create: async () => {},
      removeCreated: async () => {},
    }

    const repository = new WorkspaceProjectRepository(workspace)
    const initial = await repository.load('')
    expect(Object.keys(initial.documents)).toContain('languages/nl/messages.json')
    files['languages/nl/messages.json'] = { 'game.title': 'Gewijzigd' }
    expect((await repository.load('')).revision).not.toBe(initial.revision)
    workspace.read = async (path) =>
      new TextEncoder().encode(path.includes('/nl/') ? '{broken' : JSON.stringify(files[path]))
    const invalid = await repository.load('')
    expect(invalid.sourceDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'invalid_json',
        file: 'languages/nl/messages.json',
      }),
    )
  })
})

describe('application localization', () => {
  it('stores independent game language preferences and tolerates storage read and write failures', () => {
    const entries = new Map<string, string>()

    const preferences = new BrowserGameLanguagePreferences(() => ({
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, value)
      },
    }))

    preferences.write('first', 'nl')
    preferences.write('second', 'en')
    expect(preferences.read('first')).toBe('nl')
    expect(preferences.read('second')).toBe('en')
    expect(preferences.read('third')).toBeUndefined()

    const blocked = new BrowserGameLanguagePreferences(() => ({
      getItem: () => {
        throw new Error('Read blocked')
      },
      setItem: () => {
        throw new Error('Storage full')
      },
    }))

    expect(blocked.read('first')).toBeUndefined()
    expect(() => blocked.write('first', 'nl')).not.toThrow()
  })

  it('matches language tags without using untrusted input as a resource path', () => {
    expect(selectLanguage(['en', 'nl', 'pt-BR'], 'en', ['PT-br'])).toBe('pt-BR')
    expect(selectLanguage(['en', 'nl'], 'en', ['../nl', 'nl-NL'])).toBe('nl')
    expect(selectLanguage(['en', 'nl'], 'en', ['fr', 'nl'])).toBe('nl')
  })

  it('falls back by key and interpolates values once as plain text', () => {
    const t = createTranslator({ greeting: 'Hello {name}', empty: 'default' }, { empty: '' })
    expect(t('greeting', { name: '<b>{name}</b>' })).toBe('Hello <b>{name}</b>')
    expect(t('empty')).toBe('')
    expect(t('missing')).toBe('missing')
    expect(t('toString')).toBe('toString')
  })

  it('translates editor labels and dynamic messages with an English fallback', () => {
    const { language, t } = editorLocalization(['nl-NL'])
    expect(language).toBe('nl')
    expect(t('project.load')).toBe('Project openen')
    expect(t('export.ready', { file: 'game.zip' })).toBe('Export gereed: game.zip')
    expect(editorLocalization(['fr']).t('project.load')).toBe('Open project')
  })

  it('keeps the editor catalogs aligned and defines every message key the editor requests', async () => {
    const editor = new URL('../apps/editor-ui/', import.meta.url)

    const catalog = async (language: string) =>
      languageCatalogSchema.parse(
        JSON.parse(await readFile(new URL(`languages/${language}/messages.json`, editor), 'utf8')),
      )

    const en = await catalog('en')
    const nl = await catalog('nl')

    const placeholders = (text: string) =>
      [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
        .map(([, name]) => name ?? '')
        .sort((a, b) => a.localeCompare(b))

    expect(Object.keys(nl).sort()).toEqual(Object.keys(en).sort())

    for (const [key, text] of Object.entries(en))
      expect(placeholders(nl[key] ?? ''), key).toEqual(placeholders(text))

    const sources = new URL('src/', editor)
    const missing: string[] = []

    for (const file of await readdir(sources)) {
      if (!file.endsWith('.ts')) continue
      const source = await readFile(new URL(file, sources), 'utf8')

      for (const [, key] of source.matchAll(/\bt\(\s*'([^']+)'/g))
        if (!Object.hasOwn(en, key!)) missing.push(`${file}: ${key}`)
    }

    expect(missing).toEqual([])
  })
})
