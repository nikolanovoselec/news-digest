// Scramble effect on the footer "Codeflare" wordmark.
// Mirrors the effect used on codeflare.ch and graymatter.ch.
//
// Served from /scramble.js (public/) so the site's CSP
// `script-src 'self'` clears it — inline scripts are blocked.
(function () {
  var activeInterval = null;

  function initFooterScramble() {
    var elements = document.querySelectorAll('.js-scramble-target');
    if (elements.length === 0) return;

    // Reset any previous ticker before starting a new one so
    // astro:page-load re-entries don't stack timers.
    if (activeInterval !== null) {
      clearInterval(activeInterval);
      activeInterval = null;
    }

    var CHARS =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>{}[]|/\\~';
    var TICK_MS = 50;
    var target = 'Codeflare';
    var current = target.split('');
    var phase = 'hold';
    // Start partway through the hold so the first scramble kicks in
    // ~0.75s after first paint instead of 3s.
    var frame = 45;

    function randomChar() {
      return CHARS.charAt(Math.floor(Math.random() * CHARS.length));
    }

    activeInterval = setInterval(function () {
      frame++;
      if (phase === 'hold') {
        if (frame > 60) {
          phase = 'scramble';
          frame = 0;
        }
        return;
      }
      if (phase === 'scramble') {
        current = current.map(function (_, i) {
          return Math.random() < 0.4 ? randomChar() : target.charAt(i);
        });
        if (frame > 30) {
          phase = 'decrypt';
          frame = 0;
        }
      } else if (phase === 'decrypt') {
        current = current.map(function (_, i) {
          return Math.random() < frame / 25 ? target.charAt(i) : randomChar();
        });
        if (frame > 25) {
          phase = 'swap';
          frame = 0;
          current = target.split('');
        }
      } else if (phase === 'swap') {
        var a = Math.floor(Math.random() * current.length);
        var b = Math.floor(Math.random() * current.length);
        var tmp = current[a];
        current[a] = current[b];
        current[b] = tmp;
        if (frame > 15) {
          phase = 'hold';
          frame = 0;
          current = target.split('');
        }
      }
      var scrambled = current.join('');
      elements.forEach(function (el) {
        el.textContent = scrambled;
      });
    }, TICK_MS);
  }

  document.addEventListener('astro:before-swap', function () {
    if (activeInterval !== null) {
      clearInterval(activeInterval);
      activeInterval = null;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFooterScramble);
  } else {
    initFooterScramble();
  }
  document.addEventListener('astro:page-load', initFooterScramble);
})();
