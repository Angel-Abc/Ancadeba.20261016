import { Container, type Factories, type Resolver } from '@ancadeba/utilities'
import { describe, expect, it, vi } from 'vite-plus/test'

describe('Container', () => {
  it('creates dependencies lazily and reuses instances within a container', () => {
    interface Services {
      dependency: { name: string }
      service: { dependency: { name: string } }
    }
    const dependency = vi.fn(() => ({ name: 'dependency' }))
    const service = vi.fn((resolver: Resolver<Services>) => ({
      dependency: resolver.resolve('dependency'),
    }))
    const factories = { dependency, service } satisfies Factories<Services>
    const container = new Container(factories)

    expect(dependency).not.toHaveBeenCalled()
    expect(service).not.toHaveBeenCalled()
    const instance = container.resolve('service')
    expect(container.resolve('service')).toBe(instance)
    expect(instance.dependency).toBe(container.resolve('dependency'))
    expect(dependency).toHaveBeenCalledOnce()
    expect(service).toHaveBeenCalledOnce()
  })

  it('keeps instances isolated between containers', () => {
    const factories = { service: () => ({}) }

    expect(new Container(factories).resolve('service')).not.toBe(
      new Container(factories).resolve('service'),
    )
  })

  it('caches undefined service results', () => {
    const service = vi.fn(() => undefined)
    const container = new Container({ service })

    expect(container.resolve('service')).toBeUndefined()
    expect(container.resolve('service')).toBeUndefined()
    expect(service).toHaveBeenCalledOnce()
  })

  it('rejects missing factories', () => {
    const container = new Container<{ service?: string }>({})

    expect(() => container.resolve('service')).toThrow('Missing factory: service')
  })

  it('detects direct dependency cycles', () => {
    const container = new Container<{ service: string }>({
      service: (resolver) => resolver.resolve('service'),
    })

    expect(() => container.resolve('service')).toThrow('Circular dependency: service')
  })

  it('detects indirect cycles and clears resolution state after failure', () => {
    const container = new Container<{ first: string; second: string }>({
      first: (resolver) => resolver.resolve('second'),
      second: (resolver) => resolver.resolve('first'),
    })

    expect(() => container.resolve('first')).toThrow('Circular dependency: first')
    expect(() => container.resolve('second')).toThrow('Circular dependency: second')
  })

  it('retries a failed dependency factory and caches successful results', () => {
    const error = new Error('Temporary failure')
    const dependency = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw error
      })
      .mockReturnValue('ready')
    const container = new Container<{ service: string; dependency: string }>({
      dependency,
      service: (resolver) => resolver.resolve('dependency'),
    })

    expect(() => container.resolve('service')).toThrow(error)
    expect(container.resolve('service')).toBe('ready')
    expect(container.resolve('service')).toBe('ready')
    expect(dependency).toHaveBeenCalledTimes(2)
  })
})
