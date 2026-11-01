/**
 * Connector catalog engine.
 *
 * The catalog is the OFFER: named connectors with named credential fields.
 * The platform never guesses a provider and never stores a credential it
 * cannot name. Listing connections echoes credential FIELD NAMES only -
 * values never leave the vault.
 */

export type ConnectorCategory =
  | 'SOURCE_IMPORT'
  | 'DEPLOYMENT'
  | 'DESIGN_REFERENCE'
  | 'DOCUMENTS_REFERENCE'
  | 'MESSAGING'
  | 'ISSUE_TRACKING'
  | 'PAYMENTS'
  | 'CUSTOM';

export interface ConnectorDefinition {
  id: string;
  label: string;
  category: ConnectorCategory;
  description: string;
  requiredCredentials: string[];
  optionalCredentials: string[];
  /** True when the connection can be tested with an outbound HTTP request. */
  testable: boolean;
}

export const CONNECTORS: ConnectorDefinition[] = [
  {
    id: 'github',
    label: 'GitHub',
    category: 'SOURCE_IMPORT',
    description: 'Import application sources from GitHub repositories.',
    requiredCredentials: ['accessToken'],
    optionalCredentials: ['organization'],
    testable: true,
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    category: 'SOURCE_IMPORT',
    description: 'Import application sources from GitLab repositories.',
    requiredCredentials: ['accessToken'],
    optionalCredentials: ['group'],
    testable: true,
  },
  {
    id: 'vercel',
    label: 'Vercel',
    category: 'DEPLOYMENT',
    description: 'Record deployments to Vercel projects.',
    requiredCredentials: ['apiToken'],
    optionalCredentials: ['teamId'],
    testable: true,
  },
  {
    id: 'netlify',
    label: 'Netlify',
    category: 'DEPLOYMENT',
    description: 'Record deployments to Netlify sites.',
    requiredCredentials: ['accessToken'],
    optionalCredentials: ['siteId'],
    testable: true,
  },
  {
    id: 'figma',
    label: 'Figma',
    category: 'DESIGN_REFERENCE',
    description: 'Ingest design references from Figma files.',
    requiredCredentials: ['accessToken', 'fileKey'],
    optionalCredentials: [],
    testable: true,
  },
  {
    id: 'notion',
    label: 'Notion',
    category: 'DOCUMENTS_REFERENCE',
    description: 'Ingest document references from Notion pages.',
    requiredCredentials: ['accessToken'],
    optionalCredentials: [],
    testable: true,
  },
  /**
   * Slack, Linear, and Stripe follow the market law for connection
   * verification. Slack pins identity with auth.test, which answers
   * HTTP 200 even when the token is bad, so the honest outcome must
   * weigh the body ok flag and not the status alone. Linear verifies
   * personal API keys with the raw key in the Authorization header,
   * no Bearer prefix, against the GraphQL viewer query. Stripe
   * accepts Bearer auth on the cheap GET /v1/account read.
   */
  {
    id: 'slack',
    label: 'Slack',
    category: 'MESSAGING',
    description: 'Send application event notifications to Slack channels.',
    requiredCredentials: ['accessToken'],
    optionalCredentials: ['channelId'],
    testable: true,
  },
  {
    id: 'linear',
    label: 'Linear',
    category: 'ISSUE_TRACKING',
    description: 'Sync build issues and project tracking from Linear.',
    requiredCredentials: ['apiKey'],
    optionalCredentials: [],
    testable: true,
  },
  {
    id: 'stripe',
    label: 'Stripe',
    category: 'PAYMENTS',
    description: 'Monitor product billing and payment activity from Stripe.',
    requiredCredentials: ['secretKey'],
    optionalCredentials: [],
    testable: true,
  },
  {
    id: 'custom',
    label: 'Custom',
    category: 'CUSTOM',
    description: 'Any external service with a base URL and a bearer token.',
    requiredCredentials: ['baseUrl'],
    optionalCredentials: ['bearerToken'],
    testable: true,
  },
];

export type CredentialRefusal =
  | 'connector-unknown'
  | 'connector-missing-credential'
  | 'connector-empty-credential'
  | 'connector-unknown-credential';

export function lookupConnector(connectorId: string):
  { ok: true; connector: ConnectorDefinition } | { ok: false; reason: CredentialRefusal; field?: string } {
  const connector = CONNECTORS.find((entry) => entry.id === connectorId);
  if (!connector) {
    return { ok: false, reason: 'connector-unknown' };
  }
  return { ok: true, connector };
}

/**
 * Validates provided credentials against the connector definition. Only
 * named fields are accepted: an unnamed credential is a refusal, never a
 * silent store. Empty-string values are refusals, not silent defaults.
 */
export function validateCredentials(
  connector: ConnectorDefinition,
  provided: Record<string, unknown>,
): { ok: true } | { ok: false; reason: CredentialRefusal; field?: string } {
  for (const field of connector.requiredCredentials) {
    if (!(field in provided)) {
      return { ok: false, reason: 'connector-missing-credential', field };
    }
    const value = provided[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, reason: 'connector-empty-credential', field };
    }
  }
  for (const field of Object.keys(provided)) {
    const known =
      connector.requiredCredentials.includes(field) ||
      connector.optionalCredentials.includes(field);
    if (!known) {
      return { ok: false, reason: 'connector-unknown-credential', field };
    }
    const value = provided[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, reason: 'connector-empty-credential', field };
    }
  }
  return { ok: true };
}

/** The only credential surface ever echoed back: field names and lengths. */
export function describeCredentials(
  connector: ConnectorDefinition,
  credentials: Record<string, unknown>,
): Record<string, number> {
  const described: Record<string, number> = {};
  for (const field of Object.keys(credentials)) {
    const value = credentials[field];
    described[field] = typeof value === 'string' ? value.length : 0;
  }
  return described;
}

/**
 * Builds the honest outbound test request for a connector. Returns null
 * for connectors with no testable surface. Providers whose identity
 * check requires a request body carry the method and the body here, so
 * the caller honors them instead of assuming GET.
 */
export function buildTestRequest(
  connector: ConnectorDefinition,
  credentials: Record<string, unknown>,
): { url: string; headers: Record<string, string>; method?: 'GET' | 'POST'; body?: string } | null {
  if (connector.id === 'custom') {
    const baseUrl = typeof credentials.baseUrl === 'string' ? credentials.baseUrl : '';
    if (baseUrl.length === 0) return null;
    const trimmed = baseUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    const token = typeof credentials.bearerToken === 'string' ? credentials.bearerToken : '';
    if (token.length > 0) {
      headers['authorization'] = 'Bearer ' + token;
    }
    return { url: trimmed + '/connection-test', headers };
  }
  if (connector.id === 'github') {
    const token = typeof credentials.accessToken === 'string' ? credentials.accessToken : '';
    if (token.length === 0) return null;
    return { url: 'https://api.github.com/user', headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' } };
  }
  if (connector.id === 'gitlab') {
    const token = typeof credentials.accessToken === 'string' ? credentials.accessToken : '';
    if (token.length === 0) return null;
    return { url: 'https://gitlab.com/api/v4/user', headers: { authorization: 'Bearer ' + token } };
  }
  if (connector.id === 'vercel') {
    const token = typeof credentials.apiToken === 'string' ? credentials.apiToken : '';
    if (token.length === 0) return null;
    return { url: 'https://api.vercel.com/v2/user', headers: { authorization: 'Bearer ' + token } };
  }
  if (connector.id === 'netlify') {
    const token = typeof credentials.accessToken === 'string' ? credentials.accessToken : '';
    if (token.length === 0) return null;
    return { url: 'https://api.netlify.com/api/v1/user', headers: { authorization: 'Bearer ' + token } };
  }
  if (connector.id === 'figma') {
    const token = typeof credentials.accessToken === 'string' ? credentials.accessToken : '';
    if (token.length === 0) return null;
    return { url: 'https://api.figma.com/v1/me', headers: { 'x-figma-token': token } };
  }
  if (connector.id === 'notion') {
    const token = typeof credentials.accessToken === 'string' ? credentials.accessToken : '';
    if (token.length === 0) return null;
    return { url: 'https://api.notion.com/v1/users/me', headers: { authorization: 'Bearer ' + token, 'notion-version': '2022-06-28' } };
  }
  if (connector.id === 'slack') {
    const token = typeof credentials.accessToken === 'string' ? credentials.accessToken : '';
    if (token.length === 0) return null;
    // Slack auth.test: the token rides the Authorization header.
    return {
      url: 'https://slack.com/api/auth.test',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      body: '',
    };
  }
  if (connector.id === 'linear') {
    const key = typeof credentials.apiKey === 'string' ? credentials.apiKey : '';
    if (key.length === 0) return null;
    // Linear: the raw personal API key, no Bearer prefix, on the viewer query.
    return {
      url: 'https://api.linear.app/graphql',
      headers: { authorization: key, 'content-type': 'application/json' },
      method: 'POST',
      body: '{"query":"query { viewer { id } }"}',
    };
  }
  if (connector.id === 'stripe') {
    const key = typeof credentials.secretKey === 'string' ? credentials.secretKey : '';
    if (key.length === 0) return null;
    // Stripe: Bearer auth on the cheap authenticated account read.
    return {
      url: 'https://api.stripe.com/v1/account',
      headers: { authorization: 'Bearer ' + key },
    };
  }
  return null;
}
