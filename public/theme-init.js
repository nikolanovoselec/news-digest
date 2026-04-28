// Implements REQ-DES-002. External script loaded with defer in <head> before CSS.
//
// Reconciles the server-rendered data-theme with the user's stored
// preference (localStorage first, then prefers-color-scheme). On the first
// visit, writes a `theme` cookie so the server can set data-theme correctly
// on subsequent page loads — eliminating the light→dark flash.
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored || (prefersDark ? 'dark' : 'light');
    var bg = theme === 'dark' ? '#0a0a0a' : '#ffffff';
    document.documentElement.dataset.theme = theme;

    // Hardcode the html element's background-color via the inline style
    // attribute so the document bg paints as a literal hex value, not via
    // var(--bg) lookup. iOS PWA standalone mode has a distinct rendering
    // pipeline where any microsecond gap in CSS-variable resolution during
    // an Astro ClientRouter swap exposes the WebView's underlying default
    // (white) through the transparent status bar overlay
    // (apple-mobile-web-app-status-bar-style: black-translucent).
    document.documentElement.style.backgroundColor = bg;

    // Mirror the theme into the system status-bar meta tag so the iOS /
    // Android system bar follows the app-selected theme rather than the
    // OS prefers-color-scheme. transition:persist on the tag keeps the
    // node alive through Astro page swaps.
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', bg);
    }

    // Mirror into the `theme` cookie so Base.astro can emit data-theme on
    // the very first byte of the next navigation. Only write if the
    // cookie doesn't already match what we resolved — avoids churn.
    var cookieMatch = document.cookie.match(/(?:^|;\s*)theme=(light|dark)/);
    var cookieTheme = cookieMatch ? cookieMatch[1] : null;
    if (cookieTheme !== theme) {
      var oneYear = 60 * 60 * 24 * 365;
      document.cookie =
        'theme=' + theme + '; Path=/; Max-Age=' + oneYear + '; SameSite=Lax';
    }

    // Logout cache clear hook (originally tied to a PWA offline-reading
    // REQ that was retired; the cache-clear is kept because it still
    // matches the logout UX expectation).
    // Iterate every cache name and purge anything under the
    // `digest-cache-` prefix so a runtime-cache version bump never
    // leaves a stale copy of the prior user's content behind.
    if (window.location.search.indexOf('logged_out=1') !== -1) {
      if ('caches' in window) {
        caches.keys().then(function (names) {
          names.forEach(function (n) {
            if (n.indexOf('digest-cache-') === 0) {
              caches.delete(n).catch(function () {});
            }
          });
        }).catch(function () {});
      }
    }
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
