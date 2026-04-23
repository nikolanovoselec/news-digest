// Tests for public/manifest.webmanifest — REQ-PWA-001.
// The manifest is the PWA install contract: name, icons, start_url, display,
// theme/background colors. This test asserts the shape so a future refactor
// can't silently drop required fields.

import { describe, it, expect } from 'vitest';
import manifestSource from '../../public/manifest.webmanifest?raw';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface WebManifest {
  name?: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ManifestIcon[];
}

const manifest = JSON.parse(manifestSource) as WebManifest;

/** A PNG icon at a specific size qualifies for AC2's raster lane. */
function hasPngIcon(m: WebManifest, size: string, purpose: string): boolean {
  return (m.icons ?? []).some(
    (i) =>
      i.sizes === size &&
      (i.purpose ?? 'any').split(/\s+/).includes(purpose) &&
      i.type === 'image/png' &&
      i.src.endsWith('.png'),
  );
}

/** A scalable SVG icon qualifies for AC2's vector lane. */
function hasSvgIcon(m: WebManifest, purpose: string): boolean {
  return (m.icons ?? []).some(
    (i) =>
      i.type === 'image/svg+xml' &&
      i.sizes === 'any' &&
      (i.purpose ?? 'any').split(/\s+/).includes(purpose) &&
      i.src.endsWith('.svg'),
  );
}

describe('manifest.webmanifest', () => {
  it('REQ-PWA-001: parses as valid JSON', () => {
    expect(manifest).toBeTypeOf('object');
    expect(manifest).not.toBeNull();
  });

  it('REQ-PWA-001: declares required string fields per AC 1', () => {
    expect(manifest.name).toBe('News Digest');
    expect(manifest.short_name).toBe('Digest');
    expect(typeof manifest.description).toBe('string');
    expect(manifest.description?.length).toBeGreaterThan(0);
    expect(manifest.start_url).toBe('/digest');
    expect(manifest.display).toBe('standalone');
  });

  it('REQ-PWA-001: declares theme_color and background_color as hex strings', () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(manifest.theme_color).toBe('#ffffff');
    expect(manifest.background_color).toBe('#ffffff');
  });

  it('REQ-PWA-001: ships at least one any-purpose icon (SVG or 192+512 PNG) per AC 2', () => {
    const svgAny = hasSvgIcon(manifest, 'any');
    const pngAny =
      hasPngIcon(manifest, '192x192', 'any') && hasPngIcon(manifest, '512x512', 'any');
    expect(
      svgAny || pngAny,
      'manifest must ship either a scalable SVG any-icon or PNG icons at both 192 and 512',
    ).toBe(true);
  });

  it('REQ-PWA-001: ships at least one maskable icon (SVG or 512 PNG) per AC 2', () => {
    const svgMaskable = hasSvgIcon(manifest, 'maskable');
    const pngMaskable = hasPngIcon(manifest, '512x512', 'maskable');
    expect(
      svgMaskable || pngMaskable,
      'manifest must ship either a scalable SVG maskable icon or a 512x512 PNG maskable',
    ).toBe(true);
  });

  it('REQ-PWA-001: every icon src is absolute and matches its declared type', () => {
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons!.length).toBeGreaterThanOrEqual(1);
    for (const icon of manifest.icons!) {
      expect(icon.src.startsWith('/')).toBe(true);
      if (icon.type === 'image/png') {
        expect(icon.src.endsWith('.png')).toBe(true);
      } else if (icon.type === 'image/svg+xml') {
        expect(icon.src.endsWith('.svg')).toBe(true);
      } else {
        throw new Error(`Unexpected icon type: ${icon.type}`);
      }
    }
  });
});
