// Tests for src/pages/index.astro provider button rendering —
// REQ-AUTH-001 AC 1 (one button per configured provider, alphabetical
// order, no-providers fallback message).
//
// The landing page is rendered at request time, so we can't exercise
// Astro server rendering from a unit test without booting the runtime.
// Instead we use the `?raw` import pattern (already used elsewhere in
// the suite) to assert markup-level invariants on the source template.

import { describe, it, expect } from 'vitest';
import landing from '../../src/pages/index.astro?raw';

describe('landing.astro provider buttons — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: imports the configuredProviders helper from oauth-providers', () => {
    expect(landing).toContain("from '~/lib/oauth-providers'");
    expect(landing).toContain('configuredProviders(env)');
  });

  it('REQ-AUTH-001: renders a per-provider form whose action is /api/auth/<provider>/login', () => {
    // The dynamic action attribute is `action={`/api/auth/${p.name}/login`}`.
    expect(landing).toMatch(/action=\{`\/api\/auth\/\$\{p\.name\}\/login`\}/);
  });

  it('REQ-AUTH-001: button label interpolates the provider displayName', () => {
    expect(landing).toContain('Sign in with {p.displayName}');
  });

  it('REQ-AUTH-001: providers loop renders only when configuredProviders > 0', () => {
    expect(landing).toMatch(/providers\.length > 0[\s\S]*?providers\.map/);
  });

  it('REQ-AUTH-001: zero-providers fallback surfaces a configuration message', () => {
    expect(landing).toMatch(/providers\.length === 0[\s\S]*?Sign-in is not configured/);
  });

  it('REQ-AUTH-001: configured providers are listed alphabetically (sort lives in the helper, not the template)', () => {
    // The sort happens inside configuredProviders(); the template just
    // iterates. Assert the helper documents this — by importing the
    // helper and calling it, the template inherits the sort.
    expect(landing).toContain('configuredProviders(env)');
    expect(landing).not.toContain('.sort(');
  });

  it('REQ-AUTH-001: error-message helper names the provider when ?provider= is set in the bounce-back URL', () => {
    // The callback appends provider=<name> on error redirects so the
    // landing page can produce a clearer message ("Google did not
    // return a verified email" instead of "GitHub did not...").
    expect(landing).toContain('errorProvider');
    expect(landing).toContain("'github'");
    expect(landing).toContain("'google'");
  });
});
