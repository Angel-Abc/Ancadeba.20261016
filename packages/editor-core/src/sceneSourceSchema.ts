import { z } from 'zod'
import { sceneSchema } from '@ancadeba/schemas'

/** Keep accepted source extensions while retaining known-field defaults and refinements. */
function preserveExtensions<T extends z.core.$ZodType>(schema: T): T {
  if (schema instanceof z.ZodObject)
    return schema.clone({
      ...schema.def,
      shape: Object.fromEntries(
        Object.entries(schema.shape).map(([key, child]) => [key, preserveExtensions(child)]),
      ),
      catchall: schema.def.catchall ?? z.unknown(),
    })

  if (schema instanceof z.ZodArray)
    return schema.clone({ ...schema.def, element: preserveExtensions(schema.element) })

  if (schema instanceof z.ZodRecord)
    return schema.clone({ ...schema.def, valueType: preserveExtensions(schema.valueType) })

  if (schema instanceof z.ZodUnion)
    return schema.clone({ ...schema.def, options: schema.options.map(preserveExtensions) })

  if (schema instanceof z.ZodOptional)
    return schema.clone({ ...schema.def, innerType: preserveExtensions(schema.unwrap()) })

  if (schema instanceof z.ZodNullable)
    return schema.clone({ ...schema.def, innerType: preserveExtensions(schema.unwrap()) })

  if (schema instanceof z.ZodDefault)
    return schema.clone({ ...schema.def, innerType: preserveExtensions(schema.unwrap()) })

  if (schema instanceof z.ZodPrefault)
    return schema.clone({ ...schema.def, innerType: preserveExtensions(schema.unwrap()) })

  return schema
}

const source = preserveExtensions(sceneSchema)

// Keep the public scene/screen/grid extension types accepted by existing callers.
export const sceneSourceSchema = source.passthrough().safeExtend({
  screen: source.shape.screen
    .passthrough()
    .extend({ grid: source.shape.screen.shape.grid.passthrough() }),
})
