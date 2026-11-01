/**
 * Delivery status filter engine.
 *
 * The honest status vocabulary for delivery history: the three
 * persistent statuses the backoff engine can leave on a row.
 * IN_FLIGHT is deliberately not filterable because it is a transient
 * claim state that only exists while an attempt is running, so
 * filtering by it would be a racy lie about the past. Grounded in
 * the GitHub hook deliveries listing, where the redelivery filter is
 * a real predicate and unknown values are refused by name, never
 * silently ignored - the same law the job status filter follows.
 */

export const DELIVERY_STATUS_VALUES = ['PENDING', 'DELIVERED', 'EXHAUSTED'] as const;

export type DeliveryStatusValue = (typeof DELIVERY_STATUS_VALUES)[number];

export type DeliveryStatusFilter =
  | { ok: true; status: DeliveryStatusValue | undefined }
  | { ok: false; reason: 'webhook-delivery-status-unknown' };

/**
 * Parses the optional delivery status filter. Absent, null, and empty
 * mean no filter; every other value must match a known status exactly,
 * because case-mangled and padded values are refused, never guessed.
 */
export function parseDeliveryStatusFilter(raw: string | undefined | null): DeliveryStatusFilter {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, status: undefined };
  }
  for (const value of DELIVERY_STATUS_VALUES) {
    if (raw === value) {
      return { ok: true, status: value };
    }
  }
  return { ok: false, reason: 'webhook-delivery-status-unknown' };
}
