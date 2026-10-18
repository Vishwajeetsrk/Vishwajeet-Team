/**
 * Integrations registry — shared schema (Phase 2 foundation).
 *
 * A dependency-free, importable-by-both (main + renderer) module declaring the
 * integration record/template types, their validation, and the v1 reference
 * templates. Mirrors the posture of `src/shared/mcpCatalog.ts`: NO electron / node /
 * UI imports so it can be pulled into the main process, the preload bridge, and the
 * renderer alike.
 *
 * An *integration* is a labeled REST endpoint a user registers ("label it and it's
 * available"). The record carries METADATA ONLY — never the secret value, only a
 * `secretRef` handle into the encrypted secret store (see src/main/integrations.ts).
 * The loopback secret broker (src/main/integrationBroker.ts) is the ONLY place a real
 * secret is materialized, and only at forward-time inside the main process.
 *
 * Relationship to mcpCatalog.ts: that catalog declares STDIO MCP servers; this
 * registry declares HTTP REST endpoints reached through the loopback broker — a
 * complementary transport, not a competing catalog. Where a service overlaps
 * (github/db/email/search) the labels are kept aligned.
 *
 * Full contract: hive/docs/integrations-spec.md.
 */

export type IntegrationKind = 'github' | 'custom-rest';

/** How the broker injects credentials when forwarding to the integration's baseUrl.
 *  This is the ONLY auth-injection vocabulary; the secret is supplied by the broker
 *  at forward-time, never stored here. */
export type IntegrationAuthType =
  | 'none'    // public API — inject nothing
  | 'bearer'  // Authorization: Bearer <secret>
  | 'header'  // <authHeader>: <secret>   (authHeader required)
  | 'github'; // Authorization: Bearer <secret> + GitHub API headers

/** A registered integration. METADATA ONLY — carries NO secret value, only a
 *  `secretRef` handle. Safe to persist in config.json and cross IPC to the renderer. */
export interface IntegrationRecord {
  /** Stable slug, unique. See SLUG_RE. Also seeds the secretRef (`int:<id>`). */
  id: string;
  /** Human label for the UI (<= 60 chars). */
  label: string;
  /** Preset family — drives default headers and UI affordances. */
  kind: IntegrationKind;
  /** https origin (+ optional base path). The broker forwards <baseUrl>/<path>. A
   *  loopback http origin is allowed only for explicit local custom-rest targets. */
  baseUrl: string;
  /** How the broker injects auth when forwarding upstream. */
  authType: IntegrationAuthType;
  /** REQUIRED iff authType === 'header' — the header NAME to inject the secret under. */
  authHeader?: string;
  /** HANDLE into the encrypted secret store; NEVER the secret. Present iff
   *  authType !== 'none'. Convention: `int:<id>`. */
  secretRef?: string;
  /** Consent gate. A worker can reach an integration ONLY when enabled. */
  enabled: boolean;
  /** epoch ms. */
  createdAt: number;
  /** epoch ms. */
  updatedAt: number;
}

/** A preset that seeds an IntegrationRecord. Dwight extends the catalog by appending
 *  to INTEGRATION_TEMPLATES — no broker or registry changes needed. */
export interface IntegrationTemplate {
  kind: IntegrationKind;
  /** Default label (user-editable). */
  label: string;
  /** Default origin. Empty for custom-rest (the user supplies it). */
  baseUrl: string;
  authType: IntegrationAuthType;
  /** For authType 'header'. */
  authHeader?: string;
  /** UI prompt for the secret field, e.g. "GitHub personal access token". */
  secretLabel?: string;
  /** One line: where to get the secret / what scopes it needs. */
  secretHelp?: string;
  /** https link for the UI. */
  docsUrl?: string;
  /** Default slug seed. */
  idSuggestion: string;
  /**
   * Who pays for calls through this connector (the free-first contract):
   * - 'free': no key, no account, no cost, ever. Rate/quota documented in
   *   quotaNote. Workers may use these without spending anything.
   * - 'byok': the user's own key/plan pays (GitHub PAT, Linear key, …). No
   *   per-call cost to the app, but the credential is user-supplied and the
   *   calls count against THEIR quota — so key handling stays broker-only.
   * - 'paid': the call itself can move or spend real money (Stripe charges,
   *   paid metered APIs). ALWAYS requiresApproval, and the broker only
   *   forwards with a fresh operator approval (M1 approval desk one-shot).
   */
  cost: ConnectorCost;
  /** Free/quota wording shown in the UI, e.g. "60 req/hr, no key". REQUIRED
   *  for cost === 'free' (the operator must see the limit before relying on
   *  it); recommended for 'byok'. */
  quotaNote?: string;
  /** True ⇒ the broker must hold a fresh operator approval for every outbound
   *  call, not just policy-allow. Always true for 'paid' (enforced by
   *  validateConnectorTemplate). */
  requiresApproval: boolean;
}

/** Who pays for a connector's calls. See IntegrationTemplate.cost. */
export type ConnectorCost = 'free' | 'byok' | 'paid';

export const ALL_CONNECTOR_COSTS: readonly ConnectorCost[] = ['free', 'byok', 'paid'];

/** Integration id: lowercase slug, 2–40 chars, no leading/trailing hyphen. */
export const INTEGRATION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** A header name the broker may inject under (authType 'header'). */
export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
export const ALL_AUTH_TYPES: readonly IntegrationAuthType[] = ['none', 'bearer', 'header', 'github'];
export const ALL_KINDS: readonly IntegrationKind[] = ['github', 'custom-rest'];

/**
 * Template-level cost consistency (the free-first contract, enforced in tests
 * and at template-registration time):
 * - 'free' ⇒ authType 'none' (no credential exists to store), no
 *   secretLabel/secretHelp, and a quotaNote (the operator must see the limit).
 * - 'byok'/'paid' ⇒ secretLabel + secretHelp (the user must know what to paste).
 * - 'paid' ⇒ requiresApproval (money moves; broker holds a fresh approval).
 */
export function validateConnectorTemplate(
  t: IntegrationTemplate
): { ok: true } | { ok: false; error: string } {
  if (!ALL_CONNECTOR_COSTS.includes(t.cost)) {
    return { ok: false, error: `cost must be one of ${ALL_CONNECTOR_COSTS.join(', ')}` };
  }
  if (t.cost === 'free') {
    if (t.authType !== 'none') return { ok: false, error: `'free' connectors must use authType 'none'` };
    if (t.secretLabel || t.secretHelp) return { ok: false, error: `'free' connectors must not ask for a secret` };
    if (!t.quotaNote || !t.quotaNote.trim()) return { ok: false, error: `'free' connectors must document their quota` };
    if (!t.docsUrl) return { ok: false, error: `'free' connectors must link their docs` };
  } else {
    if (!t.secretLabel || !t.secretHelp) {
      return { ok: false, error: `'${t.cost}' connectors must explain the credential (secretLabel + secretHelp)` };
    }
    if (t.cost === 'paid' && !t.requiresApproval) {
      return { ok: false, error: `'paid' connectors must set requiresApproval` };
    }
  }
  return { ok: true };
}

/** Template ids whose calls can move real money — broker + approval desk treat
 *  these as approval-every-call, never policy-allow-alone. */
export function paidConnectorIds(templates: IntegrationTemplate[] = INTEGRATION_TEMPLATES): string[] {
  return templates.filter((t) => t.cost === 'paid').map((t) => t.idSuggestion);
}

/** Template ids callable with no key, no account, no cost. */
export function freeConnectorIds(templates: IntegrationTemplate[] = INTEGRATION_TEMPLATES): string[] {
  return templates.filter((t) => t.cost === 'free').map((t) => t.idSuggestion);
}

/** The secretRef handle for an integration id (1:1). */
export function secretRefFor(id: string): string {
  return `int:${id}`;
}

/** True iff this auth type needs a stored secret. */
export function authTypeNeedsSecret(t: IntegrationAuthType): boolean {
  return t !== 'none';
}

/**
 * Validate an integration record (the upsert gate). Mirrors validateHireManifest's
 * style: returns { ok:true } or { ok:false, error }. Fail closed — anything not
 * explicitly allowed is rejected. `createdAt`/`updatedAt` are stamped by the
 * registry, so they are not required on input.
 */
export function validateIntegrationRecord(
  rec: unknown
): { ok: true; value: Omit<IntegrationRecord, 'createdAt' | 'updatedAt'> } | { ok: false; error: string } {
  if (!rec || typeof rec !== 'object') return { ok: false, error: 'record must be an object' };
  const r = rec as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!INTEGRATION_SLUG_RE.test(id)) {
    return { ok: false, error: 'id must be a lowercase slug (2–40 chars, a–z 0–9 -, no leading/trailing hyphen)' };
  }
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label || label.length > 60) return { ok: false, error: 'label is required and must be <= 60 chars' };

  const kind = r.kind as IntegrationKind;
  if (!ALL_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${ALL_KINDS.join(', ')}` };

  const authType = r.authType as IntegrationAuthType;
  if (!ALL_AUTH_TYPES.includes(authType)) {
    return { ok: false, error: `authType must be one of ${ALL_AUTH_TYPES.join(', ')}` };
  }

  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  const urlCheck = validateBaseUrl(baseUrl);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };

  let authHeader: string | undefined;
  if (authType === 'header') {
    authHeader = typeof r.authHeader === 'string' ? r.authHeader.trim() : '';
    if (!authHeader || !HEADER_NAME_RE.test(authHeader)) {
      return { ok: false, error: "authType 'header' requires authHeader matching [A-Za-z0-9-]{1,64}" };
    }
  } else if (r.authHeader != null && String(r.authHeader).trim() !== '') {
    return { ok: false, error: "authHeader is only valid when authType === 'header'" };
  }

  const needsSecret = authTypeNeedsSecret(authType);
  const secretRef = needsSecret ? secretRefFor(id) : undefined;
  const enabled = r.enabled === true;

  return { ok: true, value: { id, label, kind, baseUrl, authType, authHeader, secretRef, enabled } };
}

/** Validate a baseUrl: https origin (+ optional path), no userinfo, no traversal.
 *  A loopback http origin (127.0.0.1 / [::1] / localhost) is permitted for explicit
 *  local custom-rest targets the user registers. */
export function validateBaseUrl(baseUrl: string): { ok: true; url: URL } | { ok: false; error: string } {
  if (!baseUrl) return { ok: false, error: 'baseUrl is required' };
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return { ok: false, error: 'baseUrl must be a valid URL' };
  }
  if (u.username || u.password) return { ok: false, error: 'baseUrl must not contain userinfo' };
  if (u.search || u.hash) return { ok: false, error: 'baseUrl must not contain a query or fragment' };
  if (baseUrl.includes('..')) return { ok: false, error: 'baseUrl must not contain ".."' };
  const isLoopbackHost =
    u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  if (u.protocol === 'https:') return { ok: true, url: u };
  if (u.protocol === 'http:' && isLoopbackHost) return { ok: true, url: u };
  return { ok: false, error: 'baseUrl must be https (http allowed only for 127.0.0.1/localhost)' };
}

/**
 * Build the upstream auth headers the broker injects when forwarding. Pure — the
 * caller (the broker, in main) passes the already-decrypted secret; this function
 * never reads any store and never logs. Returns the header map to merge into the
 * outbound request (lowercased keys).
 */
export function buildAuthHeaders(
  authType: IntegrationAuthType,
  authHeader: string | undefined,
  secret: string | undefined
): Record<string, string> {
  switch (authType) {
    case 'none':
      return {};
    case 'bearer':
      return secret ? { authorization: `Bearer ${secret}` } : {};
    case 'header':
      return secret && authHeader ? { [authHeader.toLowerCase()]: secret } : {};
    case 'github':
      return {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      };
    default:
      return {};
  }
}

/**
 * Join an integration baseUrl with a worker-supplied path, confining the result
 * under the baseUrl origin (NOT an open proxy). Returns null if the path would
 * escape the origin (absolute URL, host override, or traversal above the base path).
 * `pathAndQuery` is the part after `/i/<integrationId>/` including any query string.
 */
export function resolveUpstreamUrl(baseUrl: string, pathAndQuery: string): URL | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  // Reject anything that smells like an absolute target or traversal.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathAndQuery)) return null; // scheme://...
  if (pathAndQuery.startsWith('//')) return null; // protocol-relative host override
  // Decode the path before the traversal check so an encoded `%2e%2e` is caught too.
  const pathOnly = pathAndQuery.split(/[?#]/)[0];
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(pathOnly); } catch { return null; }
  if (decodedPath.split('/').some((seg) => seg === '..')) return null;

  // Normalize the base path to a directory prefix, then append the worker path.
  const basePath = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  const rel = pathAndQuery.replace(/^\/+/, '');
  let resolved: URL;
  try {
    resolved = new URL(basePath + rel, base.origin);
  } catch {
    return null;
  }
  // Confine: same origin AND the resolved path stays under the base path prefix.
  if (resolved.origin !== base.origin) return null;
  const confinePrefix = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  if (confinePrefix !== '/' && !(resolved.pathname + '/').startsWith(confinePrefix) && resolved.pathname !== base.pathname) {
    return null;
  }
  return resolved;
}

/** v1 reference templates — the two end-to-end references. Dwight appends more here. */
export const INTEGRATION_TEMPLATES: IntegrationTemplate[] = [
  {
    kind: 'github',
    label: 'GitHub',
    baseUrl: 'https://api.github.com',
    authType: 'github',
    secretLabel: 'GitHub personal access token',
    secretHelp: 'Create a fine-grained or classic PAT at github.com/settings/tokens with the scopes your workers need.',
    docsUrl: 'https://docs.github.com/rest',
    idSuggestion: 'github',
    cost: 'byok',
    quotaNote: 'Your token, your rate limit (5,000 req/hr authenticated).',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Custom REST API',
    baseUrl: '',
    authType: 'bearer',
    secretLabel: 'API key / token',
    secretHelp: 'Point baseUrl at any REST API. Choose how its credential is sent: Bearer token, a custom header, or none.',
    idSuggestion: 'my-api',
    cost: 'byok',
    requiresApproval: false
  },

  // ─── First-wave YC tools (Dwight, P2) ───────────────────────────────────────
  // Per-tool auth model + high-value endpoint catalog: hive/docs/integration-templates.md.
  // Gmail / Google Calendar / Salesforce are intentionally NOT registered yet: they
  // authenticate via OAuth, and IntegrationAuthType has no `oauth2` (OAuth refresh is a
  // v1 non-goal — spec §8). They are documented under "Pending: OAuth broker".
  {
    kind: 'custom-rest',
    label: 'Linear',
    baseUrl: 'https://api.linear.app/graphql',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Linear API key',
    secretHelp: 'Linear → Settings → Security & access → Personal API keys. Sent verbatim in Authorization (no "Bearer"). Every call POSTs to /graphql.',
    docsUrl: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    idSuggestion: 'linear',
    cost: 'byok',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Jira',
    baseUrl: 'https://your-domain.atlassian.net/rest/api/3',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Authorization header (Basic …)',
    secretHelp: 'Basic auth: paste "Basic " + base64("<email>:<api-token>"). Token at id.atlassian.com → Security → API tokens. Replace your-domain with your Atlassian site.',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
    idSuggestion: 'jira',
    cost: 'byok',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Notion',
    baseUrl: 'https://api.notion.com/v1',
    authType: 'bearer',
    secretLabel: 'Notion internal integration token',
    secretHelp: 'notion.so/my-integrations → Internal Integration Secret; share target pages/DBs with it. Every request also needs header "Notion-Version: 2022-06-28" (worker sends it per request).',
    docsUrl: 'https://developers.notion.com/reference/intro',
    idSuggestion: 'notion',
    cost: 'byok',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Stripe',
    baseUrl: 'https://api.stripe.com/v1',
    authType: 'bearer',
    secretLabel: 'Stripe secret key',
    secretHelp: 'dashboard.stripe.com → Developers → API keys → Secret key (sk_live_/sk_test_). Restricted keys recommended. Bodies are form-encoded, not JSON.',
    docsUrl: 'https://stripe.com/docs/api',
    idSuggestion: 'stripe',
    cost: 'paid',
    quotaNote: 'API calls are free; charges/refunds move real money — every mutating call needs a fresh operator approval.',
    requiresApproval: true
  },
  {
    kind: 'custom-rest',
    label: 'Confluence',
    baseUrl: 'https://your-domain.atlassian.net/wiki/api/v2',
    authType: 'header',
    authHeader: 'Authorization',
    secretLabel: 'Authorization header (Basic …)',
    secretHelp: 'Basic auth: paste "Basic " + base64("<email>:<api-token>") (same Atlassian token as Jira). Replace your-domain with your site.',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v2/intro/',
    idSuggestion: 'confluence',
    cost: 'byok',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Sentry',
    baseUrl: 'https://sentry.io/api/0',
    authType: 'bearer',
    secretLabel: 'Sentry auth token',
    secretHelp: 'sentry.io → Settings → Auth Tokens. Org-scoped routes carry your org slug in the path, e.g. /organizations/<org>/issues/.',
    docsUrl: 'https://docs.sentry.io/api/',
    idSuggestion: 'sentry',
    cost: 'byok',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'HubSpot',
    baseUrl: 'https://api.hubapi.com',
    authType: 'bearer',
    secretLabel: 'HubSpot private app token',
    secretHelp: 'HubSpot → Settings → Integrations → Private Apps → create app → Access token (scopes crm.objects.*).',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    idSuggestion: 'hubspot',
    cost: 'byok',
    requiresApproval: false
  },

  // ─── Free tier (Dwight, cost-tiers lane) ───────────────────────────────────
  // No key, no account, no cost, ever. Each documents its public quota so the
  // operator sees the limit before relying on it. Workers prefer these; paid
  // and metered APIs stay behind explicit approval (see cost above).
  {
    kind: 'custom-rest',
    label: 'GitHub Public (no key)',
    baseUrl: 'https://api.github.com',
    authType: 'none',
    docsUrl: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
    idSuggestion: 'github-public',
    cost: 'free',
    quotaNote: '60 req/hr per IP, no key. Same shape as the GitHub template, minus auth.',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Open-Meteo Weather',
    baseUrl: 'https://api.open-meteo.com/v1',
    authType: 'none',
    docsUrl: 'https://open-meteo.com/en/docs',
    idSuggestion: 'open-meteo',
    cost: 'free',
    quotaNote: 'Free for non-commercial use, 10,000 req/day. No key. e.g. /forecast?latitude=..&longitude=..&current=temperature_2m.',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'npm Registry',
    baseUrl: 'https://registry.npmjs.org',
    authType: 'none',
    docsUrl: 'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md',
    idSuggestion: 'npm-registry',
    cost: 'free',
    quotaNote: 'No key. CDN-cached metadata, e.g. /<pkg>/latest. Be polite: cache version lookups.',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'PyPI JSON API',
    baseUrl: 'https://pypi.org/pypi',
    authType: 'none',
    docsUrl: 'https://warehouse.pypa.io/api-reference/json.html',
    idSuggestion: 'pypi',
    cost: 'free',
    quotaNote: 'No key. e.g. /<project>/json for releases and metadata.',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Open Library',
    baseUrl: 'https://openlibrary.org',
    authType: 'none',
    docsUrl: 'https://openlibrary.org/dev/docs/api/search',
    idSuggestion: 'open-library',
    cost: 'free',
    quotaNote: 'No key. e.g. /search.json?q=.. Rate-limit kindly (~100 req/5min).',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'Hacker News API',
    baseUrl: 'https://hacker-news.firebaseio.com/v0',
    authType: 'none',
    docsUrl: 'https://github.com/HackerNews/API',
    idSuggestion: 'hacker-news',
    cost: 'free',
    quotaNote: 'No key. Near-real-time mirror, e.g. /topstories.json then /item/<id>.json.',
    requiresApproval: false
  },
  {
    kind: 'custom-rest',
    label: 'REST Countries',
    baseUrl: 'https://restcountries.com/v3.1',
    authType: 'none',
    docsUrl: 'https://restcountries.com/',
    idSuggestion: 'rest-countries',
    cost: 'free',
    quotaNote: 'No key. e.g. /name/{name}, /alpha/{code}. Country facts without a geocoding bill.',
    requiresApproval: false
  },

  // ─── Social publishing (LinkedIn via Publora) ────────────────────────────
  // Workers get a publish path for LinkedIn through the broker WITHOUT any
  // credential ever touching a prompt, a file, or a log: the key lives in the
  // encrypted secret store and is injected as `x-publora-key` at forward time.
  // Verified against the live API surface (publora_client.py): base
  // https://api.publora.com/api/v1, endpoints /create-post (draft unless
  // scheduledTime set), /get-post/<id>, DELETE /delete-post/<id>,
  // /platform-connections, /platform-limits, /linkedin-comments,
  // /linkedin-reactions, /linkedin-reshare. Publishing moves reputation, so
  // this template is approval-every-call even though the key is BYOK: drafts
  // are the default (omit scheduledTime), and nothing posts without a fresh
  // operator approval through the M1 desk. Free 15 posts/month on Publora.
  {
    kind: 'custom-rest',
    label: 'LinkedIn via Publora',
    baseUrl: 'https://api.publora.com/api/v1',
    authType: 'header',
    authHeader: 'x-publora-key',
    secretLabel: 'Publora API key',
    secretHelp: 'app.publora.com → signup (free) → Channels → Add Channel → LinkedIn → copy the platform ID (linkedin-…); Settings → API → Create Key (sk_…). Free 15 posts/month.',
    docsUrl: 'https://docs.publora.com',
    idSuggestion: 'linkedin-publora',
    cost: 'byok',
    quotaNote: 'Free 15 posts/month on Publora; LinkedIn account required. Drafts by default — publishing always needs a fresh operator approval.',
    requiresApproval: true
  }
];
