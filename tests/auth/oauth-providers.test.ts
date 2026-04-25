// Tests for src/lib/oauth-providers.ts — REQ-AUTH-001 (provider
// registry, alphabetical iteration, per-provider env-var lookup,
// canonical user-id namespacing).

import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  configuredProviders,
  envKeyClientId,
  envKeyClientSecret,
  providerByName,
  providerCredentials,
  userIdFor,
} from '~/lib/oauth-providers';

function envWith(overrides: Partial<Env>): Env {
  return overrides as unknown as Env;
}

describe('PROVIDERS registry — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: registry contains exactly github + google', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(['github', 'google']);
  });

  it('REQ-AUTH-001: every provider exposes the required config fields', () => {
    for (const cfg of Object.values(PROVIDERS)) {
      expect(typeof cfg.name).toBe('string');
      expect(typeof cfg.displayName).toBe('string');
      expect(cfg.authorizeUrl.startsWith('https://')).toBe(true);
      expect(cfg.tokenUrl.startsWith('https://')).toBe(true);
      expect(typeof cfg.scope).toBe('string');
      expect(typeof cfg.fetchProfile).toBe('function');
    }
  });

  it('REQ-AUTH-001: GitHub keeps userIdPrefix=null so existing rows do not migrate', () => {
    expect(PROVIDERS.github.userIdPrefix).toBeNull();
  });

  it('REQ-AUTH-001: Google has userIdPrefix="google:" so its ids namespace away from GitHub', () => {
    expect(PROVIDERS.google.userIdPrefix).toBe('google:');
  });
});

describe('providerByName — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: returns the matching config for known names', () => {
    expect(providerByName('github')?.name).toBe('github');
    expect(providerByName('google')?.name).toBe('google');
  });

  it('REQ-AUTH-001: returns null for unknown names', () => {
    expect(providerByName('apple')).toBeNull();
    expect(providerByName('')).toBeNull();
    expect(providerByName('GITHUB')).toBeNull(); // case-sensitive
  });
});

describe('userIdFor — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: GitHub returns the bare numeric id (legacy compatibility)', () => {
    expect(userIdFor(PROVIDERS.github, '12345')).toBe('12345');
  });

  it('REQ-AUTH-001: Google prefixes with "google:" so its ids cannot collide', () => {
    expect(userIdFor(PROVIDERS.google, '987654321')).toBe('google:987654321');
  });
});

describe('envKeyClientId / envKeyClientSecret — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: GitHub maps to GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET', () => {
    expect(envKeyClientId('github')).toBe('GITHUB_OAUTH_CLIENT_ID');
    expect(envKeyClientSecret('github')).toBe('GITHUB_OAUTH_CLIENT_SECRET');
  });

  it('REQ-AUTH-001: Google maps to GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET', () => {
    expect(envKeyClientId('google')).toBe('GOOGLE_OAUTH_CLIENT_ID');
    expect(envKeyClientSecret('google')).toBe('GOOGLE_OAUTH_CLIENT_SECRET');
  });
});

describe('providerCredentials — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: returns null when only the id is set', () => {
    expect(
      providerCredentials(envWith({ GITHUB_OAUTH_CLIENT_ID: 'x' }), 'github'),
    ).toBeNull();
  });

  it('REQ-AUTH-001: returns null when only the secret is set', () => {
    expect(
      providerCredentials(envWith({ GITHUB_OAUTH_CLIENT_SECRET: 's' }), 'github'),
    ).toBeNull();
  });

  it('REQ-AUTH-001: returns null when both are empty strings', () => {
    expect(
      providerCredentials(
        envWith({ GITHUB_OAUTH_CLIENT_ID: '', GITHUB_OAUTH_CLIENT_SECRET: '' }),
        'github',
      ),
    ).toBeNull();
  });

  it('REQ-AUTH-001: returns the pair when both are set', () => {
    const creds = providerCredentials(
      envWith({
        GITHUB_OAUTH_CLIENT_ID: 'gh-id',
        GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
      }),
      'github',
    );
    expect(creds).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
  });
});

describe('configuredProviders — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: returns [] when no provider has credentials', () => {
    expect(configuredProviders(envWith({}))).toEqual([]);
  });

  it('REQ-AUTH-001: returns only the providers whose credentials are set', () => {
    const out = configuredProviders(
      envWith({
        GITHUB_OAUTH_CLIENT_ID: 'gh-id',
        GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
      }),
    );
    expect(out.map((p) => p.name)).toEqual(['github']);
  });

  it('REQ-AUTH-001: sorts results alphabetically by displayName (GitHub before Google)', () => {
    const out = configuredProviders(
      envWith({
        GITHUB_OAUTH_CLIENT_ID: 'gh-id',
        GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
        GOOGLE_OAUTH_CLIENT_ID: 'g-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret',
      }),
    );
    expect(out.map((p) => p.displayName)).toEqual(['GitHub', 'Google']);
  });

  it('REQ-AUTH-001: alphabetical order is independent of registry insertion order', () => {
    // Even if a future provider lands earlier alphabetically (e.g.
    // "Apple" or "Bitbucket"), configuredProviders re-sorts. Today's
    // registry already orders github → google so the sort is a no-op,
    // but the contract is "sorted by displayName" not "registry order".
    const out = configuredProviders(
      envWith({
        GITHUB_OAUTH_CLIENT_ID: 'gh-id',
        GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
        GOOGLE_OAUTH_CLIENT_ID: 'g-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret',
      }),
    );
    const names = out.map((p) => p.displayName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});
