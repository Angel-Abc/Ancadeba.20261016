import { gameSchema, inputSchema, sceneSchema } from '@ancadeba/schemas'
import type { IJsonResourceLoader } from '@ancadeba/utilities'
import { assembleGameData, type GameData } from './gameData.js'

export interface IGameLoader {
  load(): Promise<GameData>
}

export class GameLoader implements IGameLoader {
  constructor(private readonly resources: IJsonResourceLoader) {}

  async load(): Promise<GameData> {
    const definition = await this.resources.load('game.json', gameSchema)
    const scenes = await Promise.all(
      definition.scenes.map(async (id) => {
        const scene = await this.resources.load(`scenes/${id}.json`, sceneSchema)
        return [id, scene] as const
      }),
    )
    const input = definition.input
      ? await this.resources.load(definition.input, inputSchema)
      : undefined
    return assembleGameData(definition, new Map(scenes), input)
  }
}
