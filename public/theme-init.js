// Implements REQ-DES-002. External script loaded with defer in <head> before CSS.
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored || (prefersDark ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;

    // Logout cache clear hook (REQ-PWA-002 logout cache handling)
    if (window.location.search.indexOf('logged_out=1') !== -1) {
      if ('caches' in window) {
        caches.delete('digest-cache-v1').catch(function () {});
      }
    }
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
