import type { ZodType } from 'zod'
import type { ILogger } from '../logger/index.js'
import type { IResourceSource } from '../resourceSources/index.js'
import type { IJsonResourceLoader } from './index.js'

const logName = 'JsonResourceLoader'
export class JsonResourceLoader implements IJsonResourceLoader {
  constructor(
    private readonly source: IResourceSource,
    private readonly logger: ILogger,
  ) {}
  async load<T>(path: string, schema: ZodType<T>): Promise<T> {
    this.logger.debug(logName, 'Loading JSON resource from path: {0}', path)

    let text: string
    try {
      text = await this.source.readText(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(logName, 'Error loading JSON resource from path {0}: {1}', path, message)
      throw error
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(logName, 'Failed to parse JSON from path {0}: {1}', path, message)
      throw error
    }

    const parseResult = schema.safeParse(json)
    if (!parseResult.success) {
      this.logger.error(
        logName,
        'JSON from path {0} does not match the expected schema: {1}',
        path,
        parseResult.error.message,
      )
      throw new Error(`JSON from path ${path} does not match the expected schema`)
    }

    const result = parseResult.data
    this.logger.debug(
      logName,
      'Successfully loaded JSON resource from path {0} resulting in {1}',
      path,
      result,
    )
    return result
  }
}
