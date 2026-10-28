import { MessageBus, ScheduledMessageBus, type ITaskScheduler } from '@ancadeba/utilities'
import { describe, expect, it, vi } from 'vite-plus/test'

interface Topics {
  work: number
  result: string
}

function setup(
  shouldDeliver: (topic: keyof Topics, payload: number | string) => boolean = () => true,
) {
  const tasks: { run: () => void; cancelled: boolean; delay: number }[] = []
  const scheduler: ITaskScheduler = {
    schedule(run, delay) {
      const task = { run, cancelled: false, delay }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
  }
  const onError = vi.fn()
  const bus = new ScheduledMessageBus(new MessageBus<Topics>(), scheduler, onError, shouldDeliver)
  return { bus, tasks, onError }
}

describe('scheduled message bus', () => {
  it('defers delivery, coalesces publications, and stays idle after one snapshot batch', () => {
    const { bus, tasks } = setup()
    const calls: (number | string)[] = []
    bus.subscribe('work', (value) => calls.push(value))
    bus.subscribe('result', (value) => calls.push(value))
    expect(tasks).toHaveLength(0)
    bus.publish('work', 1)
    bus.publish('result', 'ready')
    bus.publish('work', 2)
    expect(calls).toEqual([])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.delay).toBe(0)
    tasks[0]!.run()
    expect(calls).toEqual([1, 'ready', 2])
    expect(tasks).toHaveLength(1)
  })

  it('yields between handler-generated batches and ignores nested flushes', () => {
    const { bus, tasks } = setup()
    const calls: number[] = []
    bus.subscribe('work', (value) => {
      calls.push(value)
      if (value < 3) bus.publish('work', value + 1)
      bus.flush()
    })
    bus.publish('work', 1)
    tasks[0]!.run()
    expect(calls).toEqual([1])
    expect(tasks).toHaveLength(2)
    tasks[1]!.run()
    expect(calls).toEqual([1, 2])
    tasks[2]!.run()
    expect(calls).toEqual([1, 2, 3])
    expect(tasks).toHaveLength(3)
  })

  it('invalidates automatic delivery when explicitly flushed without losing followup work', () => {
    const { bus, tasks } = setup()
    const calls: number[] = []
    bus.subscribe('work', (value) => {
      calls.push(value)
      if (value === 1) bus.publish('work', 2)
    })
    bus.publish('work', 1)
    bus.flush()
    expect(tasks[0]!.cancelled).toBe(true)
    expect(calls).toEqual([1])
    tasks[0]!.run() // A stale callback cannot flush the newer task's batch.
    expect(calls).toEqual([1])
    tasks[1]!.run()
    expect(calls).toEqual([1, 2])
  })

  it('always applies the session predicate and permits additional explicit filtering', () => {
    const { bus, tasks } = setup((topic) => topic !== 'result')
    const result = vi.fn()
    const work = vi.fn()
    bus.subscribe('result', result)
    bus.subscribe('work', work)
    bus.publish('result', 'blocked')
    bus.publish('work', 1)
    bus.publish('work', 2)
    bus.flush((_topic, payload) => payload !== 1)
    expect(result).not.toHaveBeenCalled()
    expect(work).toHaveBeenCalledExactlyOnceWith(2)
    tasks[0]!.run()
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('logs automatic failures, finishes the batch, and continues later deliveries without retry', () => {
    const { bus, tasks, onError } = setup()
    const failure = new Error('Handler failed')
    const calls: number[] = []
    const unsubscribe = bus.subscribe('work', () => {
      throw failure
    })
    bus.subscribe('work', (value) => {
      calls.push(value)
      if (value === 1) bus.publish('work', 3)
    })
    bus.publish('work', 1)
    bus.publish('work', 2)
    tasks[0]!.run()
    expect(calls).toEqual([1, 2])
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]![0] as AggregateError).errors).toEqual([failure, failure])
    unsubscribe()
    tasks[1]!.run()
    expect(calls).toEqual([1, 2, 3])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('propagates explicit flush errors without logging and preserves later work', () => {
    const { bus, tasks, onError } = setup()
    const unsubscribe = bus.subscribe('work', () => {
      bus.publish('result', 'next')
      throw new Error('Failed')
    })
    const result = vi.fn()
    bus.subscribe('result', result)
    bus.publish('work', 1)
    expect(() => bus.flush()).toThrow(AggregateError)
    expect(onError).not.toHaveBeenCalled()
    unsubscribe()
    tasks[1]!.run()
    expect(result).toHaveBeenCalledExactlyOnceWith('next')
  })

  it('seals idempotently, delivers queued messages, and permits late subscriptions and flushing', () => {
    const { bus, tasks } = setup()
    bus.publish('result', 'final')
    bus.seal()
    bus.seal()
    bus.publish('result', 'ignored')
    const result = vi.fn(() => bus.publish('work', 1))
    bus.subscribe('result', result)
    tasks[0]!.run()
    bus.flush()
    expect(result).toHaveBeenCalledExactlyOnceWith('final')
    expect(tasks).toHaveLength(1)
  })
})
