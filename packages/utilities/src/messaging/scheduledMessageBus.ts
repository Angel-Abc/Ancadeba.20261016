import type { ITaskScheduler } from '../timing.js'
import type {
  IMessageBus,
  MessageDeliveryPredicate,
  MessageHandler,
  MessageTopic,
  Unsubscribe,
} from './index.js'

/** Schedules one deferred snapshot batch at a time around a caller-owned raw bus. */
export class ScheduledMessageBus<Topics> implements IMessageBus<Topics> {
  private pending: { cancel?: Unsubscribe } | undefined
  private flushing = false
  private sealed = false

  constructor(
    private readonly source: IMessageBus<Topics>,
    private readonly scheduler: ITaskScheduler,
    private readonly onError: (error: unknown) => void,
    private readonly shouldDeliver: MessageDeliveryPredicate<Topics> = () => true,
  ) {}

  publish<Topic extends MessageTopic<Topics>>(topic: Topic, payload: Topics[Topic]): void {
    if (this.sealed) return
    this.source.publish(topic, payload)
    this.requestDelivery()
  }

  subscribe<Topic extends MessageTopic<Topics>>(
    topic: Topic,
    handler: MessageHandler<Topics[Topic]>,
  ): Unsubscribe {
    return this.source.subscribe(topic, handler)
  }

  flush(shouldDeliver?: MessageDeliveryPredicate<Topics>): void {
    if (this.flushing) return
    const pending = this.pending
    this.pending = undefined
    pending?.cancel?.()
    this.flushing = true
    try {
      this.source.flush(
        (topic, payload) =>
          this.shouldDeliver(topic, payload) && (shouldDeliver?.(topic, payload) ?? true),
      )
    } finally {
      this.flushing = false
    }
  }

  /** Reject future publications while preserving queued messages and their pending delivery. */
  seal(): void {
    this.sealed = true
  }

  private requestDelivery(): void {
    if (this.pending) return
    const task: { cancel?: Unsubscribe } = {}
    this.pending = task
    task.cancel = this.scheduler.schedule(() => {
      if (this.pending !== task) return
      this.pending = undefined
      try {
        this.flush()
      } catch (error) {
        this.onError(error)
      }
    }, 0)
  }
}
