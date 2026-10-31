import {
  buildSystemPayload,
  SYSTEM_EVENT_CONTRACTS,
  SYSTEM_EVENT_NAMES,
} from './system-events.engine';

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOOD_PAYLOADS: Record<string, Record<string, unknown>> = {
  'application.created': { applicationId: 'app-1', name: 'Orders Frontend' },
  'application.updated': { applicationId: 'app-1' },
  'application.archived': { applicationId: 'app-1' },
  'checkpoint.created': { applicationId: 'app-1', checkpointId: 'cp-1', label: 'before launch' },
  'checkpoint.restored': { applicationId: 'app-1', checkpointId: 'cp-1', changedFiles: 2 },
  'deployment.recorded': {
    applicationId: 'app-1',
    deploymentId: 'dep-1',
    environment: 'production',
    verdict: 'READY',
  },
  'verification.completed': {
    applicationId: 'app-1',
    runs: [{ id: 'run-1', kind: 'SECRET_SCAN', status: 'PASSED' }],
  },
  'reference.created': { applicationId: 'app-1', referenceId: 'ref-1', kind: 'SPEC', title: 'Requirements' },
};

function independentValid(field: string, value: unknown): boolean {
  if (field === 'changedFiles') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
  }
  if (field === 'runs') {
    if (!Array.isArray(value) || value.length === 0) return false;
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) return false;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== 'string') return false;
      if (typeof record.kind !== 'string') return false;
      if (typeof record.status !== 'string') return false;
    }
    return true;
  }
  return typeof value === 'string' && value.trim().length > 0;
}

describe('system event contracts engine', () => {
  it('accepts a correct payload for every contract', () => {
    for (const eventName of SYSTEM_EVENT_NAMES) {
      const check = buildSystemPayload(eventName, GOOD_PAYLOADS[eventName]);
      expect(check.ok).toBe(true);
      if (check.ok) {
        expect(Object.keys(check.value).sort()).toEqual(
          [...SYSTEM_EVENT_CONTRACTS[eventName]].sort(),
        );
      }
    }
  });

  it('refuses unknown events by name', () => {
    const check = buildSystemPayload('application.exploded', { applicationId: 'app-1' });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain('system-event-unknown');
      expect(check.reason).toContain('application.exploded');
    }
  });

  it('refuses payloads that are not plain objects', () => {
    for (const payload of [null, undefined, 'text', 42, [], [{ id: 'x' }]]) {
      const check = buildSystemPayload('application.updated', payload);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.reason).toBe('system-event-payload-not-an-object');
      }
    }
  });

  it('refuses every missing or empty string field by name', () => {
    for (const eventName of SYSTEM_EVENT_NAMES) {
      const contract = SYSTEM_EVENT_CONTRACTS[eventName];
      for (const field of contract) {
        if (field === 'changedFiles' || field === 'runs') continue;
        const base = { ...GOOD_PAYLOADS[eventName] } as Record<string, unknown>;
        delete base[field];
        const missing = buildSystemPayload(eventName, base);
        expect(missing.ok).toBe(false);
        if (!missing.ok) {
          expect(missing.reason).toBe('system-event-field-missing: ' + field);
        }
        const empty = { ...GOOD_PAYLOADS[eventName] } as Record<string, unknown>;
        empty[field] = '   ';
        const invalid = buildSystemPayload(eventName, empty);
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
          expect(invalid.reason).toBe('system-event-field-invalid: ' + field);
        }
      }
    }
  });

  it('accepts zero changed files but refuses negative, fractional, and string counts', () => {
    const zero = buildSystemPayload('checkpoint.restored', {
      applicationId: 'app-1',
      checkpointId: 'cp-1',
      changedFiles: 0,
    });
    expect(zero.ok).toBe(true);
    for (const bad of [-1, 1.5, '2', NaN, Infinity]) {
      const check = buildSystemPayload('checkpoint.restored', {
        applicationId: 'app-1',
        checkpointId: 'cp-1',
        changedFiles: bad,
      });
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.reason).toBe('system-event-field-invalid: changedFiles');
      }
    }
  });

  it('refuses run arrays that are empty, not arrays, or malformed', () => {
    for (const bad of [
      [],
      'runs',
      [42],
      [{ id: 'run-1', kind: 'SECRET_SCAN' }],
      [{ id: 'run-1', kind: 'SECRET_SCAN', status: '' }],
    ]) {
      const check = buildSystemPayload('verification.completed', {
        applicationId: 'app-1',
        runs: bad,
      });
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.reason).toBe('system-event-field-invalid: runs');
      }
    }
    // A null runs field is a MISSING field by engine semantics: null and
    // undefined both mean the producer never set the field, while a present
    // but malformed array is invalid. Both refusals are named and distinct.
    const nullRuns = buildSystemPayload('verification.completed', {
      applicationId: 'app-1',
      runs: null,
    });
    expect(nullRuns.ok).toBe(false);
    if (!nullRuns.ok) {
      expect(nullRuns.reason).toBe('system-event-field-missing: runs');
    }
  });

  it('drops fields that are not part of the contract', () => {
    const check = buildSystemPayload('application.created', {
      applicationId: 'app-1',
      name: 'Orders',
      sneaky: 'not in the contract',
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(Object.keys(check.value)).toEqual(['applicationId', 'name']);
    }
  });

  it('matches an independent validator across a 500-case seeded sweep', () => {
    const random = mulberry32(42);
    const candidates: unknown[] = [
      null,
      undefined,
      '',
      '   ',
      'valid text',
      42,
      0,
      -1,
      1.5,
      [],
      [{ id: 'run-1', kind: 'SECRET_SCAN', status: 'PASSED' }],
      'not-an-array',
    ];
    for (let i = 0; i < 500; i += 1) {
      const eventName = SYSTEM_EVENT_NAMES[Math.floor(random() * SYSTEM_EVENT_NAMES.length)];
      const contract = SYSTEM_EVENT_CONTRACTS[eventName];
      const payload: Record<string, unknown> = {};
      for (const field of contract) {
        payload[field] = candidates[Math.floor(random() * candidates.length)];
      }
      if (random() < 0.2 && contract.length > 0) {
        delete payload[contract[contract.length - 1]];
      }
      const check = buildSystemPayload(eventName, payload);
      let expected = true;
      for (const field of contract) {
        const value = payload[field];
        if (value === undefined || !independentValid(field, value)) {
          expected = false;
          break;
        }
      }
      expect({ event: eventName, i, ok: check.ok }).toEqual({ event: eventName, i, ok: expected });
      if (check.ok) {
        expect(Object.keys(check.value).sort()).toEqual([...contract].sort());
      } else if (!check.ok) {
        expect(check.reason.startsWith('system-event-')).toBe(true);
      }
    }
  });
});
