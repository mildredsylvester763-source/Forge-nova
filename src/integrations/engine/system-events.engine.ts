/**
 * System event contracts: the only events GENESIS emits automatically,
 * and the exact payload fields each one guarantees. An emission with a
 * payload that violates its contract is refused by name instead of
 * silently shipping garbage to customer endpoints.
 */

export const SYSTEM_EVENT_CONTRACTS: Record<string, string[]> = {
  'application.created': ['applicationId', 'name'],
  'application.updated': ['applicationId'],
  'application.archived': ['applicationId'],
  'checkpoint.created': ['applicationId', 'checkpointId', 'label'],
  'checkpoint.restored': ['applicationId', 'checkpointId', 'changedFiles'],
  'deployment.recorded': ['applicationId', 'deploymentId', 'environment', 'verdict'],
  'verification.completed': ['applicationId', 'runs'],
  'reference.created': ['applicationId', 'referenceId', 'kind', 'title'],
};

export const SYSTEM_EVENT_NAMES = Object.keys(SYSTEM_EVENT_CONTRACTS);

export type SystemPayloadCheck =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRunArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Record<string, unknown>;
    return (
      isNonEmptyString(record.id) &&
      isNonEmptyString(record.kind) &&
      isNonEmptyString(record.status)
    );
  });
}

const FIELD_VALIDATORS: Record<string, (value: unknown) => boolean> = {
  applicationId: isNonEmptyString,
  checkpointId: isNonEmptyString,
  deploymentId: isNonEmptyString,
  referenceId: isNonEmptyString,
  label: isNonEmptyString,
  name: isNonEmptyString,
  title: isNonEmptyString,
  kind: isNonEmptyString,
  environment: isNonEmptyString,
  verdict: isNonEmptyString,
  changedFiles: isNonNegativeInteger,
  runs: isRunArray,
};

/**
 * Validates a system event emission against its contract. Unknown events
 * and payloads that are not objects are refused by name; every contract
 * field must be present and valid. The returned value carries exactly the
 * contract fields - never a partially filled or padded object.
 */
export function buildSystemPayload(
  eventName: string,
  payload: unknown,
): SystemPayloadCheck {
  const contract = SYSTEM_EVENT_CONTRACTS[eventName];
  if (!contract) {
    return { ok: false, reason: 'system-event-unknown: ' + eventName };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'system-event-payload-not-an-object' };
  }
  const record = payload as Record<string, unknown>;
  for (const field of contract) {
    const value = record[field];
    if (value === undefined || value === null) {
      return { ok: false, reason: 'system-event-field-missing: ' + field };
    }
    const validator = FIELD_VALIDATORS[field];
    if (!validator || !validator(value)) {
      return { ok: false, reason: 'system-event-field-invalid: ' + field };
    }
  }
  const value: Record<string, unknown> = {};
  for (const field of contract) {
    value[field] = record[field];
  }
  return { ok: true, value };
}
