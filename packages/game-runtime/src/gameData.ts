import type {
  GameDefinition,
  InputDefinition,
  SceneDefinition,
  TextComponentDefinition,
  ButtonComponentDefinition,
} from '@ancadeba/schemas'
import type { TextTemplate } from './textBindings.js'
import { assertGameLanguages } from '@ancadeba/schemas'

export interface TextComponentData extends TextTemplate {
  readonly id: string
  readonly type: 'text'
  readonly text: string
  readonly placement: Readonly<TextComponentDefinition['placement']>
  readonly presentation: Readonly<TextComponentDefinition['presentation']>
}

export interface ButtonComponentData {
  readonly id: string
  readonly type: 'button'
  readonly label: string
  readonly placement: Readonly<ButtonComponentDefinition['placement']>
  readonly action?: Readonly<NonNullable<ButtonComponentDefinition['action']>> | undefined
}

export type SceneComponentData = TextComponentData | ButtonComponentData

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
  readonly components: readonly SceneComponentData[]
}

export interface GameData {
  readonly language?: string
  readonly id: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly initialScene?: string
  readonly input?: InputData
  /** Iteration follows the manifest order. */
  readonly scenes: ReadonlyMap<string, SceneData>
}

/** Assemble already validated definitions without performing resource I/O. */
export function assembleGameData(
  definition: GameDefinition,
  sceneDefinitions: ReadonlyMap<string, SceneDefinition>,
  inputDefinition?: InputDefinition,
): GameData {
  assertGameLanguages(definition, sceneDefinitions)

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
      components: scene.components.map((component) =>
        component.type === 'button'
          ? {
              ...component,
              placement: { ...component.placement },
              ...(component.action ? { action: { ...component.action } } : {}),
            }
          : {
              ...component,
              placement: { ...component.placement },
              presentation: { ...component.presentation },
              ...(component.bindings === undefined
                ? {}
                : {
                    bindings: Object.fromEntries(
                      Object.entries(component.bindings).map(([alias, binding]) => [
                        alias,
                        { ...binding, path: [...binding.path] },
                      ]),
                    ),
                  }),
            },
      ),
    })
  }

  if (sceneDefinitions.size !== scenes.size) {
    throw new Error('Scene definitions contain unreferenced scenes')
  }

  if (definition['initial-scene'] !== undefined && !scenes.has(definition['initial-scene'])) {
    throw new Error('Initial scene must reference a scene in the manifest')
  }

  for (const scene of scenes.values()) {
    for (const component of scene.components) {
      if (component.type !== 'button' || !component.action) continue
      const target = scenes.get(component.action.scene)

      if (!target)
        throw new Error(`Button ${component.id} references missing scene ${component.action.scene}`)

      if (component.action.type === 'new-game' && target.type !== 'game') {
        throw new Error(`New game button ${component.id} must target a game scene`)
      }
    }
  }

  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    version: definition.version,
    ...(definition['initial-scene'] === undefined
      ? {}
      : { initialScene: definition['initial-scene'] }),
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
