import { z } from 'zod'

export const gameSchema = z.looseObject({})

export type Game = z.infer<typeof gameSchema>
