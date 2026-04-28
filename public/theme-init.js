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
    document.documentElement.dataset.theme = theme;

    // Keep the iOS / Android system status-bar colour locked to the
    // app-selected theme. Without this sync, a user in dark mode whose
    // device is in light mode sees a white status bar above an
    // otherwise-dark UI (the meta tag previously used
    // prefers-color-scheme media queries, which track the OS, not the
    // app theme). On Astro client-side navigation the meta node is
    // marked transition:persist so its content survives the swap.
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
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
