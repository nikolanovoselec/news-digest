# PWA icons

This directory holds the icon assets referenced by `public/manifest.webmanifest`
and the Apple touch icon link in `src/layouts/Base.astro`.

## Current assets

| File | Purpose | Referenced from |
|---|---|---|
| `app-icon.svg` | Single SVG used for every PWA icon size and the Apple touch icon. Safari 13+ accepts SVG via `apple-touch-icon`; older Safari falls back to the `<link rel="icon">` chain. | `public/manifest.webmanifest` (192×192 and 512×512 entries), `src/layouts/Base.astro:139` |
| `.gitkeep` | Preserves directory in git. | — |

There are no PNG fallbacks. The SVG is the source of truth for all sizes,
keeping the brand palette in one place. If a future deployment target
needs raster icons (e.g., a store listing that rejects SVG), generate
them from `app-icon.svg` at build time rather than committing them.

## Updating the icon

1. Edit `app-icon.svg` (or replace it).
2. Verify `theme_color` and `background_color` in `public/manifest.webmanifest`
   still agree with the SVG palette.
3. Verify `<meta name="theme-color">` in `src/layouts/Base.astro` agrees
   with the manifest.
