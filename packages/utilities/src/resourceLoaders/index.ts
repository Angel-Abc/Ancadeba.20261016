import type { ZodType } from 'zod'

export interface IJsonResourceLoader {
  load<T>(path: string, schema: ZodType<T>): Promise<T>
}
