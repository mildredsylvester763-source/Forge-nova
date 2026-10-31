/**
 * Event subscription engine.
 *
 * Event names follow a strict two-part grammar (entity.verb, lowercase,
 * hyphen-separated words), mirroring Stripe event names like
 * payment_intent.succeeded and GitHub hook events. Subscriptions may be
 * an exact event name, an entity wildcard (deployment.*), or "all".
 */

export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** The honest catalog: dispatch refuses event names outside this list. */
export const KNOWN_EVENTS = [
  'application.created',
  'application.updated',
  'application.archived',
  'deployment.recorded',
  'verification.completed',
  'checkpoint.created',
  'checkpoint.restored',
  'reference.created',
] as const;

export type EventName = (typeof KNOWN_EVENTS)[number];

export type SubscriptionRefusal =
  | 'webhook-invalid-event-name'
  | 'webhook-unknown-event';

/** Validates an event name against the grammar and the known-events catalog. */
export function validateEventName(eventName: string): { ok: true } | { ok: false; reason: SubscriptionRefusal } {
  if (!EVENT_NAME_PATTERN.test(eventName)) {
    return { ok: false, reason: 'webhook-invalid-event-name' };
  }
  if (!(KNOWN_EVENTS as readonly string[]).includes(eventName)) {
    return { ok: false, reason: 'webhook-unknown-event' };
  }
  return { ok: true };
}

/** Validates a subscription entry: exact known event, entity wildcard, or all. */
export function validateSubscription(subscription: string): { ok: true } | { ok: false; reason: SubscriptionRefusal } {
  if (subscription === 'all') {
    return { ok: true };
  }
  if (subscription.endsWith('.*')) {
    const entity = subscription.slice(0, -2);
    const hasEntityEvents = (KNOWN_EVENTS as readonly string[]).some((event) =>
      event.startsWith(entity + '.'),
    );
    if (hasEntityEvents) return { ok: true };
  }
  return validateEventName(subscription);
}

/** True when a subscription list matches a concrete event occurrence. */
export function matchesSubscriptions(subscriptions: string[], eventName: string): boolean {
  return subscriptions.some((subscription) => {
    if (subscription === 'all') return true;
    if (subscription.endsWith('.*')) {
      return eventName.startsWith(subscription.slice(0, -1));
    }
    return subscription === eventName;
  });
}
