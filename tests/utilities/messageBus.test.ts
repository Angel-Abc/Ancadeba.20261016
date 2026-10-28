import { MessageBus, type IMessageBus, type Unsubscribe } from '@ancadeba/utilities'
import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'

interface Messages {
  'entity.destroyed': { entityId: string }
  'scene.loaded': { sceneId: string }
  tick: number
  ready: undefined
}

describe('MessageBus delivery filters', () => {
  it('evaluates once per message, discards rejected messages, and finishes current subscribers', () => {
    const bus = new MessageBus<Messages>()
    let active = true
    const filter = vi.fn(() => active)
    const calls: string[] = []
    bus.subscribe('tick', (value) => {
      calls.push(`first:${value}`)
      active = false
    })
    bus.subscribe('tick', (value) => calls.push(`second:${value}`))
    bus.publish('tick', 1)
    bus.publish('tick', 2)
    bus.flush(filter)
    expect(calls).toEqual(['first:1', 'second:1'])
    expect(filter).toHaveBeenCalledTimes(2)
    bus.flush(() => true)
    expect(calls).toHaveLength(2)
  })

  it('aggregates predicate and subscriber failures while continuing the batch', () => {
    const bus = new MessageBus<Messages>()
    const calls: number[] = []
    const predicateFailure = new Error('Filter failed')
    const subscriberFailure = new Error('Subscriber failed')
    bus.subscribe('tick', (value) => {
      calls.push(value)
      if (value === 2) throw subscriberFailure
    })
    for (const value of [1, 2, 3]) bus.publish('tick', value)
    let aggregate: unknown
    try {
      bus.flush((_topic, payload) => {
        if (payload === 1) throw predicateFailure
        return true
      })
    } catch (error) {
      aggregate = error
    }
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([predicateFailure, subscriberFailure])
    expect(calls).toEqual([2, 3])
    expect(() => bus.flush()).not.toThrow()
  })
})

describe('MessageBus', () => {
  it('infers payloads and checks topics and payload types through its interface', () => {
    const bus: IMessageBus<Messages> = new MessageBus<Messages>()
    const unsubscribe = bus.subscribe('entity.destroyed', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<{ entityId: string }>()
    })
    expectTypeOf(unsubscribe).toEqualTypeOf<Unsubscribe>()

    bus.publish('entity.destroyed', { entityId: 'enemy-42' })
    bus.publish('tick', 1)
    bus.publish('ready', undefined)

    // @ts-expect-error Unknown topics are rejected.
    bus.publish('missing', {})
    // @ts-expect-error Payloads must match the selected topic.
    bus.publish('entity.destroyed', { sceneId: 'level-1' })
    // @ts-expect-error Required payload fields cannot be omitted.
    bus.publish('scene.loaded', {})
    // @ts-expect-error Payload arguments cannot be omitted.
    bus.publish('tick')
    // @ts-expect-error Subscription topics must exist in the message map.
    bus.subscribe('missing', () => {})
    // @ts-expect-error Handlers must accept the selected topic's payload.
    bus.subscribe('tick', (payload: string) => payload.toUpperCase())
  })

  it('queues messages and delivers across topics in publish and subscription order', () => {
    const bus = new MessageBus<Messages>()
    const deliveries: string[] = []
    bus.subscribe('tick', (value) => deliveries.push(`first:${value}`))
    bus.subscribe('tick', (value) => deliveries.push(`second:${value}`))
    bus.subscribe('scene.loaded', ({ sceneId }) => deliveries.push(sceneId))

    bus.publish('tick', 1)
    bus.publish('scene.loaded', { sceneId: 'level-1' })
    bus.publish('tick', 2)
    expect(deliveries).toEqual([])

    bus.flush()

    expect(deliveries).toEqual(['first:1', 'second:1', 'level-1', 'first:2', 'second:2'])
    bus.flush()
    expect(deliveries).toHaveLength(5)
  })

  it('passes the original payload and supports undefined payloads', () => {
    const bus = new MessageBus<Messages>()
    const destroyed = vi.fn()
    const ready = vi.fn()
    const payload = { entityId: 'enemy-42' }
    bus.subscribe('entity.destroyed', destroyed)
    bus.subscribe('ready', ready)

    bus.publish('entity.destroyed', payload)
    bus.publish('ready', undefined)
    bus.flush()

    expect(destroyed).toHaveBeenCalledExactlyOnceWith(payload)
    expect(destroyed.mock.calls[0]?.[0]).toBe(payload)
    expect(ready).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('uses subscriptions present at delivery rather than at publish time', () => {
    const bus = new MessageBus<Messages>()
    const handler = vi.fn()

    bus.publish('tick', 1)
    bus.subscribe('tick', handler)
    bus.flush()

    expect(handler).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('drops messages with no subscribers without retaining them for later subscribers', () => {
    const bus = new MessageBus<Messages>()
    const handler = vi.fn()

    bus.publish('tick', 1)
    bus.flush()
    bus.subscribe('tick', handler)
    bus.flush()

    expect(handler).not.toHaveBeenCalled()
    bus.publish('tick', 2)
    bus.flush()
    expect(handler).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('unsubscribes before delivery and allows repeated cleanup after resubscribing', () => {
    const bus = new MessageBus<Messages>()
    const removed = vi.fn()
    const active = vi.fn()
    const unsubscribe = bus.subscribe('tick', removed)
    bus.publish('tick', 1)
    unsubscribe()
    bus.subscribe('tick', active)
    unsubscribe()

    bus.flush()

    expect(removed).not.toHaveBeenCalled()
    expect(active).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('treats registrations of the same handler as independent subscriptions', () => {
    const bus = new MessageBus<Messages>()
    const handler = vi.fn()
    const first = bus.subscribe('tick', handler)
    const second = bus.subscribe('tick', handler)
    bus.publish('tick', 1)
    bus.flush()
    expect(handler).toHaveBeenCalledTimes(2)

    first()
    bus.publish('tick', 2)
    bus.flush()
    expect(handler).toHaveBeenCalledTimes(3)

    second()
    bus.publish('tick', 3)
    bus.flush()
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('defers messages published by handlers even if they request a nested flush', () => {
    const bus = new MessageBus<Messages>()
    const deliveries: string[] = []
    bus.subscribe('tick', (value) => {
      deliveries.push(`tick:${value}`)
      bus.publish('scene.loaded', { sceneId: 'next' })
      bus.flush()
    })
    bus.subscribe('scene.loaded', ({ sceneId }) => deliveries.push(sceneId))
    bus.publish('tick', 1)
    bus.publish('tick', 2)

    bus.flush()
    expect(deliveries).toEqual(['tick:1', 'tick:2'])

    bus.flush()
    expect(deliveries).toEqual(['tick:1', 'tick:2', 'next', 'next'])
  })

  it('bounds a flush when a handler republishes to its own topic', () => {
    const bus = new MessageBus<Messages>()
    const handler = vi.fn((value: number) => bus.publish('tick', value + 1))
    bus.subscribe('tick', handler)
    bus.publish('tick', 1)

    bus.flush()
    expect(handler).toHaveBeenCalledExactlyOnceWith(1)
    bus.flush()
    expect(handler.mock.calls).toEqual([[1], [2]])
  })

  it('applies unsubscription immediately during delivery', () => {
    const bus = new MessageBus<Messages>()
    const skipped = vi.fn()
    const first = bus.subscribe('tick', () => {
      first()
      second()
    })
    const second = bus.subscribe('tick', skipped)
    bus.publish('tick', 1)
    bus.publish('tick', 2)

    bus.flush()

    expect(skipped).not.toHaveBeenCalled()
  })

  it('applies subscriptions added during delivery starting with the next message', () => {
    const bus = new MessageBus<Messages>()
    const added = vi.fn()
    const unsubscribe = bus.subscribe('tick', () => {
      unsubscribe()
      bus.subscribe('tick', added)
    })
    bus.publish('tick', 1)
    bus.publish('tick', 2)

    bus.flush()

    expect(added).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('finishes the batch before reporting all handler errors and remains usable', () => {
    const bus = new MessageBus<Messages>()
    const failure = new Error('Subscriber failed')
    const handler = vi.fn()
    const failing = bus.subscribe('tick', (value) => {
      bus.publish('scene.loaded', { sceneId: `level-${value}` })
      throw failure
    })
    bus.subscribe('tick', () => {
      throw 'non-Error failure'
    })
    bus.subscribe('tick', handler)
    const scene = vi.fn()
    bus.subscribe('scene.loaded', scene)
    bus.publish('tick', 1)
    bus.publish('tick', 2)

    let caught: unknown
    try {
      bus.flush()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([
      failure,
      'non-Error failure',
      failure,
      'non-Error failure',
    ])
    expect(handler.mock.calls).toEqual([[1], [2]])
    expect(scene).not.toHaveBeenCalled()

    failing()
    expect(() => bus.flush()).not.toThrow()
    expect(scene.mock.calls).toEqual([[{ sceneId: 'level-1' }], [{ sceneId: 'level-2' }]])
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('keeps queues and subscriptions isolated between bus instances', () => {
    const first = new MessageBus<Messages>()
    const second = new MessageBus<Messages>()
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    first.subscribe('tick', firstHandler)
    second.subscribe('tick', secondHandler)
    first.publish('tick', 1)
    second.publish('tick', 2)

    first.flush()
    expect(firstHandler).toHaveBeenCalledExactlyOnceWith(1)
    expect(secondHandler).not.toHaveBeenCalled()

    second.flush()
    expect(secondHandler).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('supports topic names that also exist on Object.prototype', () => {
    const bus = new MessageBus<{ toString: number; __proto__: string }>()
    const handler = vi.fn()
    bus.subscribe('toString', handler)
    bus.subscribe('__proto__', handler)
    bus.publish('toString', 1)
    bus.publish('__proto__', 'value')

    bus.flush()

    expect(handler.mock.calls).toEqual([[1], ['value']])
  })
})
