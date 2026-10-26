import type { IMessageBus, MessageHandler, MessageTopic, Unsubscribe } from './index.js'

interface QueuedMessage<Topics> {
  topic: MessageTopic<Topics>
  payload: unknown
}

export class MessageBus<Topics> implements IMessageBus<Topics> {
  private readonly subscriptions = new Map<MessageTopic<Topics>, Set<MessageHandler<unknown>>>()
  private queue: QueuedMessage<Topics>[] = []
  private flushing = false

  publish<Topic extends MessageTopic<Topics>>(topic: Topic, payload: Topics[Topic]): void {
    this.queue.push({ topic, payload })
  }

  subscribe<Topic extends MessageTopic<Topics>>(
    topic: Topic,
    handler: MessageHandler<Topics[Topic]>,
  ): Unsubscribe {
    let subscriptions = this.subscriptions.get(topic)
    if (!subscriptions) {
      subscriptions = new Set()
      this.subscriptions.set(topic, subscriptions)
    }

    // Erase the payload type only inside the topic-indexed storage. Publish and
    // subscribe enforce the same topic/payload relationship at the public boundary.
    const subscription: MessageHandler<unknown> = (payload) => handler(payload as Topics[Topic])
    const topicSubscriptions = subscriptions
    topicSubscriptions.add(subscription)

    return () => {
      if (!topicSubscriptions.delete(subscription)) return
      if (topicSubscriptions.size === 0) this.subscriptions.delete(topic)
    }
  }

  flush(): void {
    if (this.flushing) return

    this.flushing = true
    const batch = this.queue
    this.queue = []
    const errors: unknown[] = []

    try {
      for (const { topic, payload } of batch) {
        const subscriptions = this.subscriptions.get(topic)
        if (!subscriptions) continue

        // Additions wait until the next message; removals take effect immediately.
        for (const subscription of [...subscriptions]) {
          if (!subscriptions.has(subscription)) continue
          try {
            subscription(payload)
          } catch (error) {
            errors.push(error)
          }
        }
      }
    } finally {
      this.flushing = false
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Message bus subscribers failed')
    }
  }
}
