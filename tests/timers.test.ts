import { MessageBus, type ITaskScheduler } from '@ancadeba/utilities'
import { TimerService, type EngineMessages } from '@ancadeba/game-runtime'
import { describe, expect, it, vi } from 'vite-plus/test'

function setup() {
  let now = 100
  const tasks: { run: () => void; delay: number; cancelled: boolean }[] = []
  const scheduler: ITaskScheduler = {
    schedule(run, delay) {
      const task = { run, delay, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
  }
  const messages = new MessageBus<EngineMessages>()
  const handler = vi.fn()
  messages.subscribe('timer.wakeup', handler)
  return {
    timers: new TimerService(messages, scheduler, { now: () => now }),
    messages,
    handler,
    tasks,
    setTime: (value: number) => {
      now = value
    },
  }
}

describe('one-shot timer service', () => {
  it('publishes a zero-delay wakeup once, with monotonic timestamps, through the bus', () => {
    const { timers, tasks, messages, handler } = setup()
    const id = timers.schedule(0)
    expect(handler).not.toHaveBeenCalled()
    expect(tasks[0]!.delay).toBe(0)
    tasks[0]!.run()
    tasks[0]!.run()
    expect(timers.cancel(id!)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    messages.flush()
    expect(handler).toHaveBeenCalledExactlyOnceWith({ timerId: id, dueAt: 100, observedAt: 100 })
  })

  it('rearms early callbacks and ignores stale callbacks from prior arms', () => {
    const { timers, tasks, messages, handler, setTime } = setup()
    const id = timers.schedule(50)
    setTime(120)
    tasks[0]!.run()
    expect(tasks[1]!.delay).toBe(30)
    tasks[0]!.run()
    expect(tasks).toHaveLength(2)
    setTime(150)
    tasks[1]!.run()
    messages.flush()
    expect(handler).toHaveBeenCalledExactlyOnceWith({ timerId: id, dueAt: 150, observedAt: 150 })
  })

  it('publishes one late wakeup without replaying missed time', () => {
    const { timers, tasks, messages, handler, setTime } = setup()
    const id = timers.schedule(5)
    setTime(5000)
    tasks[0]!.run()
    messages.flush()
    expect(handler).toHaveBeenCalledExactlyOnceWith({ timerId: id, dueAt: 105, observedAt: 5000 })
    expect(tasks).toHaveLength(1)
  })

  it('cancels only pending timers and ignores stale cancelled callbacks', () => {
    const { timers, tasks, messages, handler } = setup()
    const first = timers.schedule(10)!
    const second = timers.schedule(0)!
    expect(first).not.toBe(second)
    expect(timers.cancel(first)).toBe(true)
    expect(timers.cancel(first)).toBe(false)
    expect(tasks[0]!.cancelled).toBe(true)
    tasks[0]!.run()
    tasks[1]!.run()
    expect(timers.cancel(second)).toBe(false)
    messages.flush()
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      timerId: second,
      dueAt: 100,
      observedAt: 100,
    })
  })

  it.each([-1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648])(
    'rejects invalid delay %s',
    (delay) => {
      const { timers, tasks } = setup()
      expect(() => timers.schedule(delay)).toThrow(RangeError)
      expect(tasks).toHaveLength(0)
    },
  )

  it('accepts the maximum supported delay', () => {
    const { timers, tasks } = setup()
    timers.schedule(2_147_483_647)
    expect(tasks[0]!.delay).toBe(2_147_483_647)
  })

  it('disposes idempotently, cancels all timers, and disables retained references', () => {
    const { timers, tasks, messages, handler } = setup()
    const id = timers.schedule(0)!
    timers.schedule(10)
    timers.dispose()
    timers.dispose()
    expect(tasks.every((task) => task.cancelled)).toBe(true)
    for (const task of tasks) task.run()
    expect(timers.schedule(0)).toBeUndefined()
    expect(timers.schedule(-1)).toBeUndefined()
    expect(timers.cancel(id)).toBe(false)
    messages.flush()
    expect(handler).not.toHaveBeenCalled()
  })
})
