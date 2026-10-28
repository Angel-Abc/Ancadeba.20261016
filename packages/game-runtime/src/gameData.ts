import type { GameDefinition, InputDefinition, SceneDefinition } from '@ancadeba/schemas'

export interface InputData {
  readonly virtualKeys: readonly string[]
  readonly keyboard: Readonly<Record<string, string>>
  readonly contexts: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly initialContext: string
}

export interface SceneData {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly type: SceneDefinition['type']
  readonly screen: {
    readonly type: 'grid'
    readonly grid: { readonly rows: number; readonly columns: number }
  }
  readonly components: readonly never[]
}

export interface GameData {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly input?: InputData
  /** Iteration follows the manifest order. No initial scene is selected here. */
  readonly scenes: ReadonlyMap<string, SceneData>
}

/** Assemble already validated definitions without performing resource I/O. */
export function assembleGameData(
  definition: GameDefinition,
  sceneDefinitions: ReadonlyMap<string, SceneDefinition>,
  inputDefinition?: InputDefinition,
): GameData {
  if (Boolean(definition.input) !== Boolean(inputDefinition)) {
    throw new Error('Input definition must match the game input reference')
  }
  const scenes = new Map<string, SceneData>()
  for (const id of definition.scenes) {
    if (scenes.has(id)) throw new Error(`Duplicate scene reference: ${id}`)
    const scene = sceneDefinitions.get(id)
    if (!scene) throw new Error(`Missing scene definition: ${id}`)
    if (scene.id !== id) {
      throw new Error(`Scene scenes/${id}.json has ID ${scene.id}; expected ${id}`)
    }
    scenes.set(id, {
      id: scene.id,
      title: scene.title,
      description: scene.description,
      type: scene.type,
      screen: { type: scene.screen.type, grid: { ...scene.screen.grid } },
      components: [...scene.components],
    })
  }
  if (sceneDefinitions.size !== scenes.size) {
    throw new Error('Scene definitions contain unreferenced scenes')
  }
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    version: definition.version,
    ...(inputDefinition
      ? {
          input: {
            virtualKeys: [...inputDefinition['virtual-keys']],
            keyboard: { ...inputDefinition.keyboard },
            contexts: Object.fromEntries(
              Object.entries(inputDefinition.contexts).map(([id, mappings]) => [
                id,
                { ...mappings },
              ]),
            ),
            initialContext: inputDefinition['initial-context'],
          },
        }
      : {}),
    scenes,
  }
}
