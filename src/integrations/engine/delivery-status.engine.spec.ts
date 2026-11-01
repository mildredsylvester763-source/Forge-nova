import {
  DELIVERY_STATUS_VALUES,
  parseDeliveryStatusFilter,
} from './delivery-status.engine';

describe('delivery status filter engine', () => {
  it('treats absent, null, and empty as no filter', () => {
    expect(parseDeliveryStatusFilter(undefined)).toEqual({ ok: true, status: undefined });
    expect(parseDeliveryStatusFilter(null)).toEqual({ ok: true, status: undefined });
    expect(parseDeliveryStatusFilter('')).toEqual({ ok: true, status: undefined });
  });

  it('accepts every known persistent status exactly', () => {
    for (const status of DELIVERY_STATUS_VALUES) {
      expect(parseDeliveryStatusFilter(status)).toEqual({ ok: true, status });
    }
    expect(DELIVERY_STATUS_VALUES).toEqual(['PENDING', 'DELIVERED', 'EXHAUSTED']);
  });

  it('refuses unknown values by name', () => {
    expect(parseDeliveryStatusFilter('FAILED')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
    expect(parseDeliveryStatusFilter('IN_FLIGHT')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
    expect(parseDeliveryStatusFilter('bogus')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
  });

  it('refuses case-mangled values instead of guessing', () => {
    expect(parseDeliveryStatusFilter('delivered')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
    expect(parseDeliveryStatusFilter('Pending')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
  });

  it('refuses padded values instead of trimming them', () => {
    expect(parseDeliveryStatusFilter(' DELIVERED ')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
    expect(parseDeliveryStatusFilter('PENDING\t')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
  });

  it('refuses multi-value garbage exactly like the job filter', () => {
    expect(parseDeliveryStatusFilter('PENDING,DELIVERED')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
    expect(parseDeliveryStatusFilter('PENDING DELIVERED')).toEqual({
      ok: false,
      reason: 'webhook-delivery-status-unknown',
    });
  });
});
