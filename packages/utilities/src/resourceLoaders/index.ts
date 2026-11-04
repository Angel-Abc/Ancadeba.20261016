import type { ZodType } from 'zod'
import type { IResourceSource } from '../resourceSources/index.js'

export interface IJsonResourceLoader extends Pick<IResourceSource, 'readText'> {
  load<T>(path: string, schema: ZodType<T>): Promise<T>
}
