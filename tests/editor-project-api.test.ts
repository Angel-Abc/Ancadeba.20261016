import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import type { Server } from 'node:http'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { projectViewSchema, type ProjectView } from '@ancadeba/editor-core'

const manifest = {
  'schema-version': '1.0.0',
  id: 'test',
  title: 'Game',
  description: '',
  version: '1',
  scenes: [],
  extension: 'keep',
}

const scene = {
  'schema-version': '1.0.0',
  id: 'shop',
  title: 'Shop',
  description: '',
  type: 'stand-alone',
  screen: { type: 'grid', grid: { rows: 12, columns: 16, extension: 'keep' } },
  components: [],
  extension: 'keep',
}

describe('shared editor project API', () => {
  let root: string
  let base: string
  let workspace: FileWorkspace
  let server: Server
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-editor-project-', import.meta.url)))
    await mkdir(join(root, 'basic'))
    await writeFile(join(root, 'basic/game.json'), JSON.stringify(manifest))
    workspace = await FileWorkspace.open(root)

    const projects = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      projects,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    // SAFETY: this server is listening on a TCP loopback port, not a Unix socket.
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  })

  // SAFETY: this helper calls our editor project route, whose success response is ProjectView.
  const inspect = async () =>
    (await fetch(`${base}/api/editor/project?path=basic`)).json() as Promise<ProjectView>

  const command = (revision: string, operation: unknown, path = 'basic') =>
    fetch(`${base}/api/editor/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, expectedRevision: revision, command: operation }),
    })

  it.each(['success', 'before-manifest', 'after-manifest'] as const)(
    'publishes dialogue files with revision checks and rollback: %s',
    async (failure) => {
      const before = await inspect()
      const original = await readFile(join(root, 'basic/game.json'), 'utf8')
      let failed = false

      const failing: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        write: async (path, bytes) => {
          if (!failed && path.endsWith('game.json') && failure !== 'success') {
            failed = true

            if (failure === 'after-manifest') await workspace.write(path, bytes)
            throw new Error('Story publication failed')
          }

          return workspace.write(path, bytes)
        },
      }

      const service = new EditorProjectService(
        new WorkspaceProjectRepository(failing),
        new EditorCoordinator(),
      )

      const operation = {
        type: 'game.upsertDialogue',
        dialogue: {
          'schema-version': '1.0.0',
          id: 'greeting',
          label: 'Greeting',
          entry: 'hello',
          nodes: { hello: { terminal: true, lines: [{ text: 'Hello.' }] } },
        },
      }

      const saving = service.apply({
        path: 'basic',
        expectedRevision: before.revision,
        command: operation,
      })

      if (failure === 'before-manifest') {
        await expect(saving).rejects.toThrow('Story publication failed')
        expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(original)
        await expect(readFile(join(root, 'basic/dialogues/greeting.json'))).rejects.toHaveProperty(
          'code',
          'ENOENT',
        )
      } else {
        const saved = await saving
        expect(saved.view.dialogues!.greeting!.entry).toBe('hello')
        await expect(
          service.apply({ path: 'basic', expectedRevision: before.revision, command: operation }),
        ).rejects.toMatchObject({ status: 409 })
        await writeFile(
          join(root, 'basic/dialogues/greeting.json'),
          JSON.stringify({ ...saved.view.dialogues!.greeting!, extension: 'external' }),
        )
        await expect(
          service.apply({
            path: 'basic',
            expectedRevision: saved.view.revision,
            command: operation,
          }),
        ).rejects.toMatchObject({ status: 409 })
      }
    },
  )
  it('creates, updates and protects quest resources through the shared API', async () => {
    await command((await inspect()).revision, {
      type: 'scene.create',
      scene: { ...scene, type: 'game' },
    })
    const before = await inspect()

    const operation = {
      type: 'game.upsertQuest',
      quest: {
        'schema-version': '1.0.0',
        id: 'visit',
        label: 'Visit shop',
        stages: [
          {
            id: 'visit',
            objectives: [
              { id: 'visit', label: 'Visit', when: [{ type: 'scene-is', scene: 'shop' }] },
            ],
          },
        ],
      },
    }

    expect((await command(before.revision, operation)).status).toBe(200)
    const saved = await inspect()
    expect(saved.quests!.visit!.stages[0]!.id).toBe('visit')
    expect((await command(before.revision, operation)).status).toBe(409)
    expect(
      (
        await command(saved.revision, {
          type: 'scene.upsertComponent',
          sceneId: 'shop',
          component: {
            id: 'journal',
            type: 'quest-log',
            quests: ['visit'],
            placement: { row: 1, column: 1 },
          },
        })
      ).status,
    ).toBe(200)
    const linked = await inspect()
    expect(
      (await command(linked.revision, { type: 'game.removeQuest', questId: 'visit' })).status,
    ).toBe(422)
  })
  it.each(['success', 'before-scene', 'after-scene'] as const)(
    'publishes a leveling profile, manifest and view consistently: %s',
    async (failure) => {
      await command((await inspect()).revision, {
        type: 'scene.create',
        scene: { ...scene, type: 'game' },
      })
      await command((await inspect()).revision, {
        type: 'game.updateRules',
        ruleId: 'values',
        rules: {
          state: [
            { path: ['xp'], value: 0 },
            { path: ['level'], value: 1 },
            { path: ['maximumHealth'], value: 30 },
          ],
          actions: {},
        },
      })
      const before = await inspect()
      const originalManifest = await readFile(join(root, 'basic/game.json'), 'utf8')
      const originalScene = await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')
      let failed = false

      const failing: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        write: async (path, bytes) => {
          if (!failed && path.endsWith('scenes/shop.json') && failure !== 'success') {
            failed = true

            if (failure === 'after-scene') await workspace.write(path, bytes)
            throw new Error('Scene publication failed')
          }

          return workspace.write(path, bytes)
        },
      }

      const service = new EditorProjectService(
        new WorkspaceProjectRepository(failing),
        new EditorCoordinator(),
      )

      const operation = {
        type: 'game.upsertLeveling',
        profile: {
          'schema-version': '1.0.0',
          id: 'player',
          label: 'Player',
          xp: { source: 'game.state', path: ['xp'] },
          level: { source: 'game.state', path: ['level'] },
          levels: [
            { xp: 0 },
            {
              xp: 5,
              gains: [
                {
                  id: 'health',
                  label: 'Maximum health',
                  field: { source: 'game.state', path: ['maximumHealth'] },
                  amount: 6,
                },
              ],
            },
          ],
        },
        scene: {
          id: 'shop',
          component: {
            id: 'progression',
            type: 'character-progression',
            profile: 'player',
            placement: { row: 1, column: 1 },
          },
        },
      }

      const saving = service.apply({
        path: 'basic',
        expectedRevision: before.revision,
        command: operation,
      })

      if (failure === 'before-scene') {
        await expect(saving).rejects.toThrow('Scene publication failed')
        expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(originalManifest)
        expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe(originalScene)
        await expect(readFile(join(root, 'basic/leveling/player.json'))).rejects.toHaveProperty(
          'code',
          'ENOENT',
        )
      } else {
        const saved = await saving
        expect(saved.view.leveling!.player!.levels[1]!.xp).toBe(5)
        expect(saved.view.scenes[0]!.components[0]!.type).toBe('character-progression')
        await expect(
          service.apply({ path: 'basic', expectedRevision: before.revision, command: operation }),
        ).rejects.toMatchObject({ status: 409 })

        const deleted = await command(saved.view.revision, {
          type: 'game.removeLeveling',
          profileId: 'player',
        })

        expect(deleted.status).toBe(422)
      }
    },
  )
  it.each(['success', 'before-manifest', 'after-manifest', 'concurrent'] as const)(
    'publishes a combat library and manifest consistently: %s',
    async (failure) => {
      const before = await inspect()
      const originalManifest = await readFile(join(root, 'basic/game.json'), 'utf8')
      let failed = false

      const failing: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        write: async (path, bytes) => {
          if (!failed && path.endsWith('game.json') && failure !== 'success') {
            failed = true

            if (failure === 'after-manifest') await workspace.write(path, bytes)

            if (failure === 'concurrent')
              await workspace.write(path, Buffer.from('external library edit'))
            throw new Error('Library publication failed')
          }

          return workspace.write(path, bytes)
        },
      }

      const service = new EditorProjectService(
        new WorkspaceProjectRepository(failing),
        new EditorCoordinator(),
      )

      const operation = {
        type: 'game.upsertCombatLibrary',
        library: { 'schema-version': '1.0.0', id: 'common', moves: {}, statuses: {} },
      }

      const saving = service.apply({
        path: 'basic',
        expectedRevision: before.revision,
        command: operation,
      })

      if (failure === 'success' || failure === 'after-manifest') {
        const saved = await saving
        expect(saved.view.game!.combatLibraries).toEqual(['common'])
        expect(saved.view.combatLibraries!.common!.moves).toEqual({})
        await expect(
          service.apply({ path: 'basic', expectedRevision: before.revision, command: operation }),
        ).rejects.toMatchObject({ status: 409 })
        await writeFile(
          join(root, 'basic/combat-libraries/common.json'),
          JSON.stringify({ ...saved.view.combatLibraries!.common!, extension: 'external' }),
        )
        await expect(
          service.apply({
            path: 'basic',
            expectedRevision: saved.view.revision,
            command: operation,
          }),
        ).rejects.toMatchObject({ status: 409 })
      } else if (failure === 'before-manifest') {
        await expect(saving).rejects.toThrow('Library publication failed')
        expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(originalManifest)
        await expect(
          readFile(join(root, 'basic/combat-libraries/common.json')),
        ).rejects.toHaveProperty('code', 'ENOENT')
        expect((await inspect()).revision).toBe(before.revision)
      } else {
        await expect(saving).rejects.toMatchObject({ code: 'combat_publication_failed' })
        expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe('external library edit')
      }
    },
  )
  it('saves reward configuration with revision checks and protects referenced fields', async () => {
    await cp(new URL('../sample-games/basic/', import.meta.url), join(root, 'rewards'), {
      recursive: true,
    })

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

    const current = await service.inspect('rewards')
    expect(current.diagnostics).toEqual([])
    const encounter = current.combatSources!.training!

    const updated = await service.apply({
      path: 'rewards',
      expectedRevision: current.revision,
      command: {
        type: 'game.upsertCombat',
        encounter: {
          ...encounter,
          rewards: {
            ...encounter.rewards!,
            numeric: encounter.rewards!.numeric.map((entry) => ({ ...entry, amount: 12 })),
          },
        },
      },
    })

    expect(updated.view.combat!.training!.rewards!.numeric[0]!.amount).toBe(12)
    await expect(
      service.apply({
        path: 'rewards',
        expectedRevision: current.revision,
        command: { type: 'game.upsertCombat', encounter },
      }),
    ).rejects.toMatchObject({ status: 409 })
    const rules = JSON.parse(await readFile(join(root, 'rewards/rules/combat.json'), 'utf8'))
    await expect(
      service.apply({
        path: 'rewards',
        expectedRevision: updated.view.revision,
        command: {
          type: 'game.updateRules',
          ruleId: 'combat',
          rules: {
            ...rules,
            state: rules.state.filter(
              (field: { path: string[] }) => field.path.at(-1) !== 'experience',
            ),
          },
        },
      }),
    ).rejects.toMatchObject({ status: 422 })
  })
  it('saves usable item drafts with revision checks and reloads authored references in preview', async () => {
    await cp(new URL('../sample-games/basic/', import.meta.url), join(root, 'usable'), {
      recursive: true,
    })

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

    const current = await service.inspect('usable')
    const item = current.inventory!.itemTypes['healing-potion']!

    const operation = {
      type: 'inventory.setItemPresentation',
      itemType: 'healing-potion',
      presentation: item,
      use: { ...item.use!, consumption: 'keep' },
    }

    const saved = await service.apply({
      path: 'usable',
      expectedRevision: current.revision,
      command: operation,
    })

    expect(saved.view.inventory!.itemTypes['healing-potion']!.use!.consumption).toBe('keep')
    await expect(
      service.apply({ path: 'usable', expectedRevision: current.revision, command: operation }),
    ).rejects.toMatchObject({ status: 409 })
    const raw = JSON.parse(await readFile(join(root, 'usable/inventory/museum.json'), 'utf8'))
    expect(raw.itemTypes['healing-potion'].use.ability).toEqual({
      library: 'common',
      id: 'restore-vitality',
    })
    await expect(
      service.apply({
        path: 'usable',
        expectedRevision: saved.view.revision,
        command: { type: 'game.removeCombatLibrary', libraryId: 'common' },
      }),
    ).rejects.toMatchObject({ status: 422 })

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: (path) => readFile(join(root, 'usable', path), 'utf8'),
          readBytes: async () => new Uint8Array(),
        },
        { debug: () => '', info: () => '', warn: () => '', error: () => '' },
      ),
    ).load()

    expect(game.inventory!.itemTypes['healing-potion']!.use!.consumption).toBe('keep')
    expect(game.combat!.get('training')!.moves['restore-vitality']).toBeDefined()
    expect(game.combat!.get('training')!.player.moves).not.toContain('restore-vitality')
  })
  it.each(['success', 'before-scene', 'after-scene', 'concurrent'] as const)(
    'publishes encounter, manifest, and view consistently: %s',
    async (failure) => {
      await command((await inspect()).revision, {
        type: 'scene.create',
        scene: { ...scene, type: 'game' },
      })
      await command((await inspect()).revision, {
        type: 'game.updateRules',
        ruleId: 'health',
        rules: {
          state: [
            { path: ['health'], value: 40 },
            { path: ['enemyHealth'], value: 20 },
          ],
          actions: {},
        },
      })
      const before = await inspect()
      const sceneBefore = await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')
      const manifestBefore = await readFile(join(root, 'basic/game.json'), 'utf8')
      let failed = false

      const failing: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        write: async (path, bytes) => {
          if (!failed && path.endsWith('scenes/shop.json') && failure !== 'success') {
            failed = true

            if (failure === 'after-scene') await workspace.write(path, bytes)

            if (failure === 'concurrent') await workspace.write(path, Buffer.from('external edit'))
            throw new Error('Scene publication failed')
          }

          return workspace.write(path, bytes)
        },
      }

      const service = new EditorProjectService(
        new WorkspaceProjectRepository(failing),
        new EditorCoordinator(),
      )

      const encounter = {
        'schema-version': '1.0.0',
        id: 'practice',
        label: 'Practice',
        player: {
          id: 'player',
          label: 'Player',
          health: { source: 'game.state', path: ['health'] },
          maximumHealth: 40,
          moves: ['attack'],
        },
        enemies: [
          {
            id: 'enemy',
            label: 'Enemy',
            health: { source: 'game.state', path: ['enemyHealth'] },
            maximumHealth: 20,
            moves: ['attack'],
            rotation: ['attack'],
          },
        ],
        moves: {
          attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 2, max: 4 } },
        },
      }

      const operation = {
        type: 'game.upsertCombat',
        encounter,
        scene: {
          id: 'shop',
          component: {
            type: 'combat',
            id: 'combat',
            encounter: 'practice',
            placement: { row: 1, column: 1 },
          },
        },
      }

      const save = service.apply({
        path: 'basic',
        expectedRevision: before.revision,
        command: operation,
      })

      if (failure === 'success' || failure === 'after-scene') {
        const result = await save
        expect(result.view.game!.combat).toEqual(['practice'])
        expect(result.view.combat!.practice!.player.ap).toBe(3)
        expect(result.view.scenes[0]!.components[0]!.type).toBe('combat')
        await expect(
          service.apply({ path: 'basic', expectedRevision: before.revision, command: operation }),
        ).rejects.toMatchObject({ status: 409 })

        const protectedField = await command(result.view.revision, {
          type: 'game.updateRules',
          ruleId: 'health',
          rules: { state: [{ path: ['enemyHealth'], value: 20 }], actions: {} },
        })

        expect(protectedField.status).toBe(422)
      } else if (failure === 'before-scene') {
        await expect(save).rejects.toThrow('Scene publication failed')
        expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe(sceneBefore)
        expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(manifestBefore)
        await expect(readFile(join(root, 'basic/combat/practice.json'))).rejects.toHaveProperty(
          'code',
          'ENOENT',
        )
        expect((await inspect()).revision).toBe(before.revision)
      } else {
        await expect(save).rejects.toMatchObject({ code: 'combat_publication_failed' })
        expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe('external edit')
      }
    },
  )
  it('authors action bars and per-game input through revision-checked saves', async () => {
    const initial = await inspect()

    const created = await command(initial.revision, {
      type: 'scene.create',
      scene: { ...scene, type: 'game' },
    })

    const withScene = projectViewSchema.parse(await created.json())

    const input = {
      'schema-version': '1.0.0',
      'virtual-keys': ['primary'],
      keyboard: { KeyQ: 'primary' },
      contexts: { gameplay: { primary: 'slot-1' } },
      'initial-context': 'gameplay',
    }

    const response = await command(withScene.revision, {
      type: 'game.updateInput',
      inputId: 'controls',
      input,
    })

    expect(response.status).toBe(200)
    const withInput = projectViewSchema.parse(await response.json())
    expect(withInput.input).toEqual(input)
    expect(withInput.game?.input).toBe('controls')

    const bar = {
      id: 'actions',
      type: 'action-bar',
      placement: { row: 10, column: 3, rowSpan: 3, columnSpan: 8 },
      slots: {
        '1': {
          label: 'Visit',
          action: { type: 'enter-scene', scene: 'shop' },
          inputBinding: { context: 'gameplay', input: 'slot-1' },
        },
      },
    }

    const saved = await command(withInput.revision, {
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: bar,
    })

    expect(saved.status).toBe(200)
    const withBar = projectViewSchema.parse(await saved.json())
    expect(withBar.scenes[0]!.components).toEqual([bar])
    expect(
      (
        await command(withInput.revision, {
          type: 'scene.setActionBar',
          sceneId: 'shop',
          component: null,
        })
      ).status,
    ).toBe(409)
    const changedInput = { ...input, keyboard: { KeyJ: 'primary', Digit1: 'primary' } }

    const rebound = await command(withBar.revision, {
      type: 'game.updateInput',
      inputId: 'controls',
      input: changedInput,
    })

    const afterRebind = projectViewSchema.parse(await rebound.json())

    const orphan = await command(afterRebind.revision, {
      type: 'game.updateInput',
      inputId: 'controls',
      input: { ...changedInput, contexts: { gameplay: { primary: 'other' } } },
    })

    expect(orphan.status).toBe(422)
    expect(JSON.parse(await readFile(join(root, 'basic/input/controls.json'), 'utf8'))).toEqual(
      changedInput,
    )

    const loader = new GameLoader(
      new JsonResourceLoader(
        {
          readText: (path) => readFile(join(root, 'basic', path), 'utf8'),
          readBytes: async (path) => new Uint8Array(await readFile(join(root, 'basic', path))),
        },
        { debug: () => '', info: () => '', warn: () => '', error: () => '' },
      ),
    )

    const loaded = await loader.load()
    expect(loaded.input?.keyboard).toEqual(changedInput.keyboard)
    expect(loaded.scenes.get('shop')!.components[0]).toMatchObject(bar)

    const removed = await command(afterRebind.revision, {
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: null,
    })

    expect(removed.status).toBe(200)
    expect(projectViewSchema.parse(await removed.json()).scenes[0]!.components).toEqual([])
  })

  it('protects an unlisted input file when creating input configuration', async () => {
    await mkdir(join(root, 'basic/input'))
    await writeFile(join(root, 'basic/input/controls.json'), 'orphan')

    const response = await command((await inspect()).revision, {
      type: 'game.updateInput',
      inputId: 'controls',
      input: {
        'schema-version': '1.0.0',
        'virtual-keys': ['key'],
        keyboard: {},
        contexts: { gameplay: { key: 'act' } },
        'initial-context': 'gameplay',
      },
    })

    expect(response.status).toBe(409)
    expect(await readFile(join(root, 'basic/input/controls.json'), 'utf8')).toBe('orphan')
    expect((await inspect()).game?.input).toBeUndefined()
  })

  it.each([false, true])(
    'keeps input publication consistent when manifest saving fails (committed: %s)',
    async (committed) => {
      const failing: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        write: async (path, bytes) => {
          if (committed) await workspace.write(path, bytes)
          throw new Error('Manifest write failed')
        },
      }

      const service = new EditorProjectService(
        new WorkspaceProjectRepository(failing),
        new EditorCoordinator(),
      )

      const current = await service.inspect('basic')

      const result = service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: {
          type: 'game.updateInput',
          inputId: 'controls',
          input: {
            'schema-version': '1.0.0',
            'virtual-keys': ['key'],
            keyboard: {},
            contexts: { gameplay: { key: 'act' } },
            'initial-context': 'gameplay',
          },
        },
      })

      if (committed) {
        expect((await result).view.game?.input).toBe('controls')
      } else {
        await expect(result).rejects.toThrow('Manifest write failed')
        await expect(readFile(join(root, 'basic/input/controls.json'))).rejects.toHaveProperty(
          'code',
          'ENOENT',
        )
        expect((await inspect()).game?.input).toBeUndefined()
      }
    },
  )

  it('preserves a new input file when another manifest already references it', async () => {
    const uncertain: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, bytes) => workspace.create(path, bytes),
      removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
      write: async (path) => {
        await workspace.write(
          path,
          Buffer.from(JSON.stringify({ ...manifest, title: 'External', input: 'controls' })),
        )
        throw new Error('Publication outcome changed')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(uncertain),
      new EditorCoordinator(),
    )

    await expect(
      service.apply({
        path: 'basic',
        expectedRevision: (await service.inspect('basic')).revision,
        command: {
          type: 'game.updateInput',
          inputId: 'controls',
          input: {
            'schema-version': '1.0.0',
            'virtual-keys': ['key'],
            keyboard: {},
            contexts: { gameplay: { key: 'act' } },
            'initial-context': 'gameplay',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'input_publication_failed' })
    expect((await inspect()).input?.contexts.gameplay).toEqual({ key: 'act' })
  })

  it('saves rules and trigger links, guards deletion, and rejects a stale rules draft', async () => {
    const owners = {
      'schema-version': '1.0.0',
      itemTypes: {},
      owners: { player: { label: 'Player' } },
      items: { letter: { itemType: 'letter', placement: { type: 'carried', owner: 'player' } } },
    }

    await mkdir(join(root, 'basic/inventory'))
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({
        ...manifest,
        inventory: ['owners', 'letters'],
      }),
    )
    await writeFile(join(root, 'basic/inventory/owners.json'), JSON.stringify(owners))
    await writeFile(
      join(root, 'basic/inventory/letters.json'),
      JSON.stringify({
        'schema-version': '1.0.0',
        itemTypes: { letter: { label: 'Letter', extension: 'keep' } },
        owners: {},
        items: {},
      }),
    )
    const initial = await inspect()

    const savedScene = await command(initial.revision, {
      type: 'scene.create',
      scene: { ...scene, type: 'game' },
    })

    expect(savedScene.status).toBe(200)
    const withScene = projectViewSchema.parse(await savedScene.json())

    const state = [
      { path: ['ready'], value: true },
      { path: ['clue'], value: '' },
    ]

    const invalid = await command(withScene.revision, {
      type: 'game.updateRules',
      ruleId: 'rules',
      rules: {
        state,
        actions: {
          read: [
            { when: [], effects: [{ type: 'set-state', path: ['ready'], value: 'wrong type' }] },
          ],
        },
      },
    })

    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({
      diagnostics: [
        {
          file: 'rules/rules.json',
          path: ['actions', 'read', 0, 'effects', 0, 'value'],
        },
      ],
    })

    const rules = {
      state,
      actions: {
        read: [{ when: [], effects: [{ type: 'set-state', path: ['clue'], value: 'Read me' }] }],
      },
    }

    const operation = { type: 'game.updateRules', ruleId: 'rules', rules }
    const saved = await command(withScene.revision, operation)
    expect(saved.status).toBe(200)
    const afterRules = projectViewSchema.parse(await saved.json())
    expect(afterRules.game?.rules).toEqual(['rules'])
    expect(afterRules.rules).toEqual(rules)
    expect(JSON.parse(await readFile(join(root, 'basic/rules/rules.json'), 'utf8'))).toEqual(rules)
    expect((await command(withScene.revision, operation)).status).toBe(409)

    const button = {
      type: 'button',
      id: 'read-letter',
      label: 'Read',
      placement: { row: 1, column: 1 },
    }

    const buttonEdit = { type: 'scene.upsertRuleButton', sceneId: 'shop' }

    const bound = await command(afterRules.revision, {
      ...buttonEdit,
      component: {
        ...button,
        action: {
          type: 'request-action',
          action: 'read',
          enabledWhen: { source: 'game.state', path: ['ready'] },
        },
      },
    })

    expect(bound.status).toBe(200)
    const afterButton = projectViewSchema.parse(await bound.json())
    const inspectionEdit = { type: 'inventory.setRuleInspection', itemType: 'letter' }

    const inspectLink = await command(afterButton.revision, {
      ...inspectionEdit,
      inspection: {
        action: 'read',
        details: { source: 'game.state', path: ['clue'] },
        inline: false,
      },
    })

    expect(inspectLink.status).toBe(200)
    const afterInspection = projectViewSchema.parse(await inspectLink.json())
    expect(afterInspection.inventory?.itemTypes.letter?.inspection?.action).toBe('read')
    expect(afterInspection.inventory?.itemTypes.letter?.inspection?.inline).toBe(false)
    expect(
      JSON.parse(await readFile(join(root, 'basic/inventory/letters.json'), 'utf8')),
    ).toHaveProperty('itemTypes.letter.inspection.action', 'read')
    const deletion = { type: 'game.updateRules', ruleId: 'rules', rules: { state, actions: {} } }
    expect(await (await command(afterInspection.revision, deletion)).json()).toHaveProperty(
      'code',
      'rule_in_use',
    )

    const unbound = await command(afterInspection.revision, { ...buttonEdit, component: button })
    expect(unbound.status).toBe(200)
    const withoutButtonLink = projectViewSchema.parse(await unbound.json())
    expect(withoutButtonLink.scenes[0]?.components[0]).not.toHaveProperty('action')
    expect(await (await command(withoutButtonLink.revision, deletion)).json()).toHaveProperty(
      'code',
      'rule_in_use',
    )

    const unlinked = await command(withoutButtonLink.revision, {
      ...inspectionEdit,
      inspection: null,
    })

    expect(unlinked.status).toBe(200)
    const withoutInspection = projectViewSchema.parse(await unlinked.json())
    expect(withoutInspection.inventory?.itemTypes.letter).not.toHaveProperty('inspection')
    const savedManifest = await readFile(join(root, 'basic/game.json'), 'utf8')
    expect((await command(withoutInspection.revision, deletion)).status).toBe(200)
    expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(savedManifest)
    expect(JSON.parse(await readFile(join(root, 'basic/rules/rules.json'), 'utf8'))).toEqual(
      deletion.rules,
    )
    expect(
      JSON.parse(await readFile(join(root, 'basic/inventory/letters.json'), 'utf8')),
    ).toHaveProperty('itemTypes.letter.extension', 'keep')
    expect(await readFile(join(root, 'basic/inventory/owners.json'), 'utf8')).toBe(
      JSON.stringify(owners),
    )
  })

  it('includes the referenced rule file in revisions and updates it in place', async () => {
    const ruleFile = join(root, 'basic/rules/mechanics.json')
    const rules = { state: [], actions: {} }
    const savedManifest = JSON.stringify({ ...manifest, rules: ['mechanics'] })
    await writeFile(join(root, 'basic/game.json'), savedManifest)
    const missing = await inspect()
    expect(missing.diagnostics).toEqual([
      expect.objectContaining({ code: 'missing_file', file: 'rules/mechanics.json' }),
    ])

    await mkdir(join(root, 'basic/rules'))
    await writeFile(ruleFile, JSON.stringify(rules))
    const beforeEdit = await inspect()
    expect(beforeEdit.rules).toEqual(rules)
    const outsideEdit = { ...rules, state: [{ path: ['ready'], value: true }] }
    await writeFile(ruleFile, JSON.stringify(outsideEdit))
    const commandBody = { type: 'game.updateRules', ruleId: 'mechanics', rules }
    expect((await command(beforeEdit.revision, commandBody)).status).toBe(409)

    const afterEdit = await inspect()
    expect(afterEdit.rules).toEqual(outsideEdit)
    expect((await command(afterEdit.revision, commandBody)).status).toBe(200)
    expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(savedManifest)
    expect(JSON.parse(await readFile(ruleFile, 'utf8'))).toEqual(rules)
  })

  it('adds and edits feature rule files with shared state and file-specific diagnostics', async () => {
    const state = [{ path: ['ready'], value: true }]
    const actions = { prepare: [{ when: [], effects: [] }] }
    const initial = await inspect()

    const first = await command(initial.revision, {
      type: 'game.updateRules',
      ruleId: 'setup',
      rules: { state, actions },
    })

    expect(first.status).toBe(200)
    const setup = projectViewSchema.parse(await first.json())
    const finish = [{ when: [{ type: 'state-is', path: ['ready'], value: true }], effects: [] }]

    const duplicate = await command(setup.revision, {
      type: 'game.updateRules',
      ruleId: 'finish',
      rules: { state, actions: { prepare: finish } },
    })

    expect(duplicate.status).toBe(422)
    expect(await duplicate.json()).toMatchObject({
      diagnostics: [
        { file: 'rules/finish.json', path: ['state', 0, 'path'] },
        { file: 'rules/finish.json', path: ['actions', 'prepare'] },
      ],
    })
    await expect(readFile(join(root, 'basic/rules/finish.json'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )

    const finishRules = { state: [], actions: { finish } }

    const added = await command(setup.revision, {
      type: 'game.updateRules',
      ruleId: 'finish',
      rules: finishRules,
    })

    expect(added.status).toBe(200)
    const both = projectViewSchema.parse(await added.json())
    expect(both.game?.rules).toEqual(['setup', 'finish'])
    expect(both.ruleFiles).toEqual({
      setup: { state, actions },
      finish: finishRules,
    })
    expect(both.rules).toMatchObject({ state, actions: { ...actions, finish } })

    expect(
      (await command(both.revision, { type: 'game.updateRules', rules: finishRules })).status,
    ).toBe(400)
    const originalSetup = await readFile(join(root, 'basic/rules/setup.json'), 'utf8')
    const originalManifest = await readFile(join(root, 'basic/game.json'), 'utf8')

    const updated = await command(both.revision, {
      type: 'game.updateRules',
      ruleId: 'finish',
      rules: { state: [], actions: {} },
    })

    expect(updated.status).toBe(200)
    expect(await readFile(join(root, 'basic/rules/setup.json'), 'utf8')).toBe(originalSetup)
    expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(originalManifest)
  })

  it('protects an unlisted rule file when creating a rule set', async () => {
    const rules = { state: [], actions: {} }
    const savedManifest = await readFile(join(root, 'basic/game.json'), 'utf8')
    const ruleFile = join(root, 'basic/rules/rules.json')
    await mkdir(join(root, 'basic/rules'))
    await writeFile(ruleFile, 'existing data')
    const initial = await inspect()
    expect(initial.rules).toBeUndefined()
    const operation = { type: 'game.updateRules', ruleId: 'rules', rules }
    expect((await command(initial.revision, operation)).status).toBe(409)
    expect(await readFile(ruleFile, 'utf8')).toBe('existing data')
    expect(await readFile(join(root, 'basic/game.json'), 'utf8')).toBe(savedManifest)

    await rm(ruleFile)
    const created = await command(initial.revision, operation)
    expect(created.status).toBe(200)
    expect(projectViewSchema.parse(await created.json()).game?.rules).toEqual(['rules'])
    expect(JSON.parse(await readFile(ruleFile, 'utf8'))).toEqual(rules)
  })

  it('discovers, creates, edits, and loads the saved game through the unchanged engine loader', async () => {
    const capabilities = await fetch(`${base}/api/editor/capabilities`)
    expect((await capabilities.json()).commands).toHaveLength(52)
    const initial = await inspect()
    const created = await command(initial.revision, { type: 'scene.create', scene })
    expect(created.status).toBe(200)
    // SAFETY: the successful scene.create route returns the updated ProjectView.
    const first = (await created.json()) as ProjectView
    expect(first.revision).not.toBe(initial.revision)
    expect(first.game?.scenes).toEqual(['shop'])

    const updated = await command(first.revision, {
      type: 'scene.updateLayout',
      sceneId: 'shop',
      rows: 20,
      columns: 25,
    })

    expect(updated.status).toBe(200)
    const bytes = await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')
    expect(JSON.parse(bytes)).toMatchObject({
      extension: 'keep',
      screen: { grid: { rows: 20, columns: 25, extension: 'keep' } },
    })
    expect(JSON.parse(await readFile(join(root, 'basic/game.json'), 'utf8'))).toHaveProperty(
      'extension',
      'keep',
    )

    const logger: ILogger = {
      debug() {
        return ''
      },
      info() {
        return ''
      },
      warn() {
        return ''
      },
      error() {
        return ''
      },
    }

    const loader = new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (path) =>
            Buffer.from(await workspace.read(`basic/${path}`)).toString('utf8'),
          readBytes: (path) => workspace.read(`basic/${path}`),
        },
        logger,
      ),
    )

    expect((await loader.load()).scenes.get('shop')?.screen.grid.rows).toBe(20)
    const inspected = await fetch(`${base}/api/editor/scene?path=basic&id=shop`)
    expect((await inspected.json()).scene.id).toBe('shop')
  })

  it('lets only one competing revision-checked edit succeed', async () => {
    const initial = await inspect()
    const operation = { type: 'game.updateMetadata', title: 'A', description: '', version: '1' }

    const results = await Promise.all([
      command(initial.revision, operation),
      command(initial.revision, { ...operation, title: 'B' }),
    ])

    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409])
    const rejected = results.find((result) => result.status === 409)!
    expect((await rejected.json()).code).toBe('revision_conflict')
  })

  it('detects raw API writes, direct filesystem changes, and input-file changes', async () => {
    const initial = await inspect()
    await fetch(`${base}/api/files?path=basic/game.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...manifest, title: 'External' }),
    })

    const rejected = await command(initial.revision, {
      type: 'game.updateMetadata',
      title: 'Old',
      description: '',
      version: '1',
    })

    expect(rejected.status).toBe(409)
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({ ...manifest, input: 'controls' }),
    )

    const input = {
      'schema-version': '1.0.0',
      'virtual-keys': ['confirm'],
      keyboard: { Enter: 'confirm' },
      contexts: { menu: { confirm: 'accept' } },
      'initial-context': 'menu',
    }

    await mkdir(join(root, 'basic/input'))
    await writeFile(join(root, 'basic/input/controls.json'), JSON.stringify(input))
    const before = await inspect()
    await writeFile(
      join(root, 'basic/input/controls.json'),
      JSON.stringify({ ...input, keyboard: { Space: 'confirm' } }),
    )
    expect((await inspect()).revision).not.toBe(before.revision)
    const repository = new WorkspaceProjectRepository(workspace)
    expect((await repository.load('basic')).revision).toBe((await inspect()).revision)
  })

  it('does not overwrite orphan files and reports missing or malformed referenced documents', async () => {
    await mkdir(join(root, 'basic/scenes'))
    await writeFile(join(root, 'basic/scenes/shop.json'), 'orphan')
    const before = await inspect()
    const response = await command(before.revision, { type: 'scene.create', scene })
    expect(response.status).toBe(409)
    expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe('orphan')
    expect((await inspect()).game?.scenes).toEqual([])
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({ ...manifest, scenes: ['missing', 'shop'] }),
    )
    const invalid = await inspect()
    expect(invalid.diagnostics.map((item) => item.file)).toEqual([
      'scenes/missing.json',
      'scenes/shop.json',
    ])

    const rejected = await command(invalid.revision, {
      type: 'game.updateMetadata',
      title: 'X',
      description: '',
      version: '1',
    })

    expect(rejected.status).toBe(422)
    expect((await rejected.json()).diagnostics[0]).toHaveProperty('path')
  })

  it('rejects invalid commands and unsafe folders without changing saved content', async () => {
    const initial = await inspect()

    const invalid = await command(initial.revision, {
      type: 'scene.create',
      scene: { ...scene, id: '../escape' },
    })

    expect(invalid.status).toBe(400)
    expect((await invalid.json()).diagnostics.length).toBeGreaterThan(0)

    const badLayout = await command(initial.revision, {
      type: 'scene.updateLayout',
      sceneId: 'shop',
      rows: 0,
      columns: 1,
    })

    expect(badLayout.status).toBe(400)

    for (const path of ['../outside', 'C:/outside', 'basic/../outside']) {
      expect(
        (await command(initial.revision, { type: 'scene.create', scene }, path)).status,
      ).toBeGreaterThanOrEqual(400)
    }

    expect((await inspect()).revision).toBe(initial.revision)
    const plain = await fetch(`${base}/api/editor/commands`, { method: 'POST', body: '{}' })
    expect(plain.status).toBe(415)

    const malformed = await fetch(`${base}/api/editor/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })

    expect(malformed.status).toBe(400)
  })

  it('rejects scene writes through links', async () => {
    await mkdir(join(root, 'outside'))
    await symlink(
      join(root, 'outside'),
      join(root, 'basic/scenes'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const response = await command((await inspect()).revision, { type: 'scene.create', scene })
    expect(response.status).toBe(403)
    await expect(readFile(join(root, 'outside/shop.json'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it.each([false, true])(
    'keeps rule file publication consistent when the manifest write throws (committed: %s)',
    async (committed) => {
      const failing: ProjectWorkspace = {
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        create: (path, contents) => workspace.create(path, contents),
        removeCreated: (path, contents) => workspace.removeCreated(path, contents),
        write: async (path, contents) => {
          if (committed) await workspace.write(path, contents)
          throw new Error('Manifest write failed')
        },
      }

      const service = new EditorProjectService(
        new WorkspaceProjectRepository(failing),
        new EditorCoordinator(),
      )

      const current = await service.inspect('basic')
      const rules = { state: [], actions: {} }

      const save = service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: { type: 'game.updateRules', ruleId: 'rules', rules },
      })

      const ruleFile = join(root, 'basic/rules/rules.json')

      if (committed) {
        await expect(save).resolves.toMatchObject({
          view: { game: { rules: ['rules'] }, rules },
        })
        expect(JSON.parse(await readFile(ruleFile, 'utf8'))).toEqual(rules)
      } else {
        await expect(save).rejects.toThrow('Manifest write failed')
        await expect(readFile(ruleFile)).rejects.toHaveProperty('code', 'ENOENT')
        expect((await inspect()).game?.rules).toBeUndefined()
      }
    },
  )

  it('cleans a created scene after a failed manifest save and leaves the project usable', async () => {
    const failing: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async () => {
        throw new Error('Disk failure')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(failing),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')
    await expect(
      service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: { type: 'scene.create', scene },
      }),
    ).rejects.toThrow('Disk failure')
    await expect(readFile(join(root, 'basic/scenes/shop.json'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )
    expect((await inspect()).revision).toBe(current.revision)
    const success = await command(current.revision, { type: 'scene.create', scene })
    expect(success.status).toBe(200)
  })

  it('reports failed cleanup and never deletes a scene changed by another writer', async () => {
    const failing: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async () => {
        await writeFile(join(root, 'basic/scenes/shop.json'), 'external edit')
        throw new Error('Disk failure')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(failing),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')
    await expect(
      service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: { type: 'scene.create', scene },
      }),
    ).rejects.toMatchObject({ code: 'scene_cleanup_failed' })
    expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe('external edit')
    expect((await inspect()).game?.scenes).toEqual([])
  })

  it('keeps a committed scene when manifest writing reports an error after publication', async () => {
    const uncertain: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async (path, contents) => {
        await workspace.write(path, contents)
        throw new Error('Cleanup failed after publication')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(uncertain),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')

    const result = await service.apply({
      path: 'basic',
      expectedRevision: current.revision,
      command: { type: 'scene.create', scene },
    })

    expect(result.view.game?.scenes).toEqual(['shop'])
    expect(result.view.diagnostics).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).id).toBe('shop')
  })

  it('refuses rollback when a different manifest already references the created scene', async () => {
    const uncertain: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async (path) => {
        await workspace.write(
          path,
          Buffer.from(JSON.stringify({ ...manifest, title: 'External', scenes: ['shop'] })),
        )
        throw new Error('Publication outcome changed')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(uncertain),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')
    await expect(
      service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: { type: 'scene.create', scene },
      }),
    ).rejects.toMatchObject({ code: 'scene_cleanup_failed' })
    const saved = await inspect()
    expect(saved.game?.scenes).toEqual(['shop'])
    expect(saved.diagnostics).toEqual([])
  })
})
