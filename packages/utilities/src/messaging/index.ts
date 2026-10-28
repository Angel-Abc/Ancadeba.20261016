export type MessageTopic<Topics> = Extract<keyof Topics, string>

export type MessageHandler<Payload> = (payload: Payload) => void

export type Unsubscribe = () => void

export type MessageDeliveryPredicate<Topics> = (
  topic: MessageTopic<Topics>,
  payload: Topics[MessageTopic<Topics>],
) => boolean

export interface IMessageBus<Topics> {
  /** Queue a payload by reference. Delivery is deferred. */
  publish<Topic extends MessageTopic<Topics>>(topic: Topic, payload: Topics[Topic]): void

  /** Register a synchronous handler. The returned cleanup function is idempotent. */
  subscribe<Topic extends MessageTopic<Topics>>(
    topic: Topic,
    handler: MessageHandler<Topics[Topic]>,
  ): Unsubscribe

  /**
   * Deliver the current batch in publish order to the subscribers present at delivery.
   * New messages wait for the next flush, and nested flush calls do nothing.
   * A predicate can discard messages before their subscribers run. It runs once per message.
   * Subscriber and predicate errors are collected in an AggregateError after the batch completes.
   */
  flush(shouldDeliver?: MessageDeliveryPredicate<Topics>): void
}
