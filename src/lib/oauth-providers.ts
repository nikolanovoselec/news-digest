// Implements REQ-AUTH-001
//
// Provider registry for federated sign-in. Each entry pins the provider's
// OAuth/OIDC endpoints, scope string, env-var pair for credentials, and
// a `fetchProfile` adapter that turns the provider's token response into
// a uniform `{providerUserId, email, displayName}` shape the callback
// route can persist without caring which provider it came from.
//
// `userIdFor()` produces the canonical `users.id` value: GitHub keeps
// its bare numeric form (legacy compatibility — existing rows do not
// migrate), every other provider is namespaced as `<provider>:<sub>`
// so two providers can never collide on the same primary key even if
// their numeric ids overlap.
//
// Adding a new provider is one entry in `PROVIDERS` plus one
// `fetchProfile` implementation. The login + callback routes are
// parameterised on `[provider]` and need no per-provider branching.

export type ProviderName = 'github' | 'google';

/** Uniform identity shape extracted from any provider's token exchange. */
export interface ProviderProfile {
  /** Stable, provider-issued user id. Numeric or opaque string. */
  providerUserId: string;
  /** Verified primary email address. Null when the provider refuses to
   *  release one — the caller surfaces `no_verified_email`. */
  email: string | null;
  /** Human-readable handle for log breadcrumbs. */
  displayName: string;
}

/** Fetch the user's profile for the given access token + ID token (when
 *  the provider issued one). Implementations live in this file so the
 *  registry below can hold function references directly. `clientId` is
 *  threaded through so OIDC providers can validate the id_token's
 *  `aud` claim against the configured client without the registry
 *  needing to re-resolve env vars. */
export type ProfileFetcher = (args: {
  accessToken: string;
  idToken: string | null;
  clientId: string;
}) => Promise<ProviderProfile>;

export interface ProviderConfig {
  name: ProviderName;
  /** UI-facing label, used in button text ("Sign in with X"). */
  displayName: string;
  /** Provider's OAuth 2.0 authorize endpoint. */
  authorizeUrl: string;
  /** Provider's OAuth 2.0 token endpoint. */
  tokenUrl: string;
  /** Space-separated scope string. */
  scope: string;
  /** When the user-id should be namespaced (`google:`), the prefix string;
   *  null for providers that keep bare ids (GitHub — legacy). */
  userIdPrefix: string | null;
  fetchProfile: ProfileFetcher;
}

/** All known providers. Keys are alphabetical so iteration order matches
 *  the UI's required alphabetical button order — but `configuredProviders`
 *  re-sorts defensively in case a future entry lands out of order. */
export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  github: {
    name: 'github',
    displayName: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'user:email',
    userIdPrefix: null,
    fetchProfile: fetchGitHubProfile,
  },
  google: {
    name: 'google',
    displayName: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    userIdPrefix: 'google:',
    fetchProfile: fetchGoogleProfile,
  },
};

/** Look up a provider by URL-segment name. Returns null for unknown names
 *  (the dynamic `[provider]` route uses this to 404 unknown providers
 *  before any further work). */
export function providerByName(name: string): ProviderConfig | null {
  if (name === 'github' || name === 'google') return PROVIDERS[name];
  return null;
}

/** Per-provider env-var lookup. Centralised so the workflow + runtime +
 *  type defs all reference the same names. */
export function providerCredentials(
  env: Env,
  provider: ProviderName,
): { clientId: string; clientSecret: string } | null {
  const id = env[envKeyClientId(provider)];
  const secret = env[envKeyClientSecret(provider)];
  if (typeof id !== 'string' || id === '') return null;
  if (typeof secret !== 'string' || secret === '') return null;
  return { clientId: id, clientSecret: secret };
}

/** Map provider name → env var name for the client id. Exposed so the
 *  deploy workflow / docs can reference a single source of truth. */
export function envKeyClientId(provider: ProviderName): keyof Env {
  return provider === 'github' ? 'GH_OAUTH_CLIENT_ID' : 'GOOGLE_OAUTH_CLIENT_ID';
}

export function envKeyClientSecret(provider: ProviderName): keyof Env {
  return provider === 'github'
    ? 'GH_OAUTH_CLIENT_SECRET'
    : 'GOOGLE_OAUTH_CLIENT_SECRET';
}

/** Return providers with credentials configured, sorted alphabetically
 *  by `displayName` so the landing page renders them in a deterministic
 *  order regardless of registry insertion order. Implements REQ-AUTH-001
 *  AC 1 (omit unconfigured providers entirely; sort what remains). */
export function configuredProviders(env: Env): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const cfg of Object.values(PROVIDERS)) {
    if (providerCredentials(env, cfg.name) !== null) out.push(cfg);
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Compose the canonical `users.id` value for a provider profile.
 *  GitHub keeps the bare numeric form (`12345`) so existing rows are
 *  unchanged. Every other provider is prefixed (`google:abc123`) so a
 *  numeric collision between two providers can never overwrite an
 *  existing account. */
export function userIdFor(provider: ProviderConfig, providerUserId: string): string {
  if (provider.userIdPrefix === null) return providerUserId;
  return `${provider.userIdPrefix}${providerUserId}`;
}

// ---------------------------------------------------------------- providers

interface GitHubUser {
  id: number;
  login: string;
}
interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** GitHub OIDC-ish flow: access_token → /user (profile) + /user/emails
 *  (only the primary+verified one is accepted). The `Accept:
 *  application/vnd.github+json` header pins the response to the
 *  documented stable schema. `clientId` is unused here — GitHub
 *  doesn't issue an id_token to validate. */
async function fetchGitHubProfile(args: {
  accessToken: string;
  idToken: string | null;
  clientId: string;
}): Promise<ProviderProfile> {
  const headers = {
    Authorization: `Bearer ${args.accessToken}`,
    'User-Agent': 'news-digest',
    Accept: 'application/vnd.github+json',
  } as const;
  const [userRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
    fetch('https://api.github.com/user/emails', {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
  ]);
  if (!userRes.ok) throw new Error(`github_user_http_${userRes.status}`);
  if (!emailsRes.ok) throw new Error(`github_emails_http_${emailsRes.status}`);

  const user = (await userRes.json()) as GitHubUser;
  const emails = (await emailsRes.json()) as GitHubEmail[];
  const primary = emails.find((e) => e.primary === true && e.verified === true);
  return {
    providerUserId: String(user.id),
    email: primary === undefined ? null : primary.email.toLowerCase().trim(),
    displayName: user.login,
  };
}

interface GoogleIdTokenClaims {
  sub: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  /** Not-before — OIDC Core 5.1; reject when set and in the future. */
  nbf?: number;
  /** Authorized Party — OIDC Core 5.1; required when `aud` is array
   *  with length > 1, must equal the configured client id. */
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
}

/** Maximum forward clock skew tolerated for `nbf` and similar
 *  timestamp claims. 60 seconds is the OIDC implementer's-guide
 *  norm and absorbs typical NTP drift. */
const OIDC_CLOCK_SKEW_SECONDS = 60;

/** Acceptable `iss` values for a Google-issued id_token. Google's spec
 *  permits both forms; clients must accept either. */
const GOOGLE_ISS_VALUES = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

/** Google OIDC flow: token exchange returns an `id_token` (JWT) whose
 *  payload carries `sub`, `email`, `email_verified`. Decoding without
 *  signature verification is safe here because the token came directly
 *  from Google's HTTPS token endpoint over a TLS-authenticated channel
 *  — the standard OIDC client guidance (Core 3.1.3.7 step 6). The
 *  iss/aud/exp claims are still validated per spec to defend against
 *  a misconfigured deployment that points `tokenUrl` at the wrong
 *  endpoint.
 *
 *  Falls back to the userinfo endpoint with the access token only when
 *  the id_token is missing (defensive — Google always issues one when
 *  the `openid` scope is requested). The userinfo path doesn't carry
 *  iss/aud/exp so it skips those checks. */
async function fetchGoogleProfile(args: {
  accessToken: string;
  idToken: string | null;
  clientId: string;
}): Promise<ProviderProfile> {
  let claims: GoogleIdTokenClaims | null = null;
  let fromIdToken = false;
  if (args.idToken !== null && args.idToken !== '') {
    claims = decodeJwtClaims<GoogleIdTokenClaims>(args.idToken);
    fromIdToken = claims !== null;
  }
  if (claims === null) {
    // Fallback to userinfo endpoint.
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${args.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`google_userinfo_http_${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    claims = {
      sub: typeof body.sub === 'string' ? body.sub : '',
      ...(typeof body.email === 'string' ? { email: body.email } : {}),
      ...(typeof body.email_verified === 'boolean'
        ? { email_verified: body.email_verified }
        : {}),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.given_name === 'string'
        ? { given_name: body.given_name }
        : {}),
    };
  }

  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new Error('google_missing_sub');
  }

  // OIDC Core 3.1.3.7 — iss/aud/exp/nbf/azp validation. Only enforced
  // when claims came from an id_token; the userinfo fallback path has
  // already proven the token was Google's by binding to its TLS
  // endpoint and bearer-token-authenticated session.
  if (fromIdToken) {
    if (
      typeof claims.iss !== 'string' ||
      !GOOGLE_ISS_VALUES.has(claims.iss)
    ) {
      throw new Error('google_bad_iss');
    }
    const audIsArray = Array.isArray(claims.aud);
    const audMatches =
      typeof claims.aud === 'string'
        ? claims.aud === args.clientId
        : audIsArray && (claims.aud as string[]).includes(args.clientId);
    if (!audMatches) {
      throw new Error('google_bad_aud');
    }
    // OIDC Core 5.1 — `azp` is REQUIRED when `aud` is an array with
    // more than one value. The Authorized Party MUST equal our
    // configured clientId. Defends against a token issued for one
    // client being accepted by a different client (CF-030).
    const multiAud = audIsArray && (claims.aud as string[]).length > 1;
    if (multiAud && claims.azp !== args.clientId) {
      throw new Error('google_bad_azp');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= nowSec) {
      throw new Error('google_expired_id_token');
    }
    // OIDC Core 5.1 — `nbf` is OPTIONAL but must be respected when
    // present. Reject tokens that are not yet valid (CF-030).
    if (
      typeof claims.nbf === 'number' &&
      claims.nbf > nowSec + OIDC_CLOCK_SKEW_SECONDS
    ) {
      throw new Error('google_not_yet_valid');
    }
  }

  // Only accept verified emails. An unverified email at Google means the
  // account was created with that address but the user never clicked the
  // confirmation link — treating it as identity would let an attacker
  // create an account with someone else's email.
  const emailVerified = claims.email_verified === true;
  const rawEmail = typeof claims.email === 'string' ? claims.email : '';
  const email = emailVerified && rawEmail !== ''
    ? rawEmail.toLowerCase().trim()
    : null;

  // Display-name fallback ladder: Google profile name → given name →
  // verified email → generic 'Google user'. Falling back to the raw
  // `sub` (a long opaque numeric string) leaks bad UX into log lines,
  // the JWT `ghl` claim, the UserMenu aria-label, and email greetings.
  const displayName =
    typeof claims.name === 'string' && claims.name !== ''
      ? claims.name
      : typeof claims.given_name === 'string' && claims.given_name !== ''
        ? claims.given_name
        : email !== null
          ? email
          : 'Google user';

  return {
    providerUserId: claims.sub,
    email,
    displayName,
  };
}

/** Decode the payload segment of a JWT without verifying its signature.
 *  Safe ONLY when the JWT arrived over a TLS-authenticated direct
 *  channel from the issuing party (e.g., the OIDC token-exchange
 *  response). Returns null on any structural defect so the caller can
 *  fall back to the userinfo endpoint. */
function decodeJwtClaims<T>(jwt: string): T | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1] ?? '';
  if (payload === '') return null;
  // Convert base64url → base64, pad to multiple of 4, then atob → JSON.parse.
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  let json: string;
  try {
    json = atob(padded);
  } catch {
    return null;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
