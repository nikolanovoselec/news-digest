# PWA icons

This directory holds the icon assets referenced by `public/manifest.webmanifest`
and the Apple touch icon link in `src/layouts/Base.astro`.

## Current assets

| File | Purpose | Referenced from |
|---|---|---|
| `app-icon.svg` | Source SVG used as the vector icon and the Apple touch icon. Safari 13+ accepts SVG via `apple-touch-icon`; older Safari falls back to the `<link rel="icon">` chain. | `public/manifest.webmanifest`, `src/layouts/Base.astro` |
| `app-icon-192.png` | 192×192 raster icon. Generated at build time from `app-icon.svg`. Required by Samsung Internet's "Install app" dialog and older Android Chrome installers, which refuse the install prompt when the manifest only ships SVG icons. | `public/manifest.webmanifest` (any-purpose) |
| `app-icon-512.png` | 512×512 raster icon. Generated at build time from `app-icon.svg`. Used for the Android launcher icon and the maskable lane (Android 8+ adaptive-icon mask). | `public/manifest.webmanifest` (any + maskable purposes) |
| `.gitkeep` | Preserves directory in git. | — |

The PNGs are **not committed**. They are reproducible from the SVG and
regenerated on every `npm run build`, `npm run deploy`, or `npm run icons`
via `scripts/generate-pwa-icons.mjs` (powered by `@resvg/resvg-js`).

## Updating the icon

1. Edit `app-icon.svg` (or replace it).
2. Run `npm run icons` to regenerate the PNGs locally if you want to
   inspect them; otherwise the next build will regenerate them.
3. Verify `theme_color` and `background_color` in `public/manifest.webmanifest`
   still agree with the SVG palette.
4. Verify `<meta name="theme-color">` in `src/layouts/Base.astro` agrees
   with the manifest.
