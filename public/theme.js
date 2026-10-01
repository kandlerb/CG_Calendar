// Light or dark. Loaded as a plain script in <head>, before the stylesheet
// paints anything, so a saved choice never flashes the other theme first.
// With no choice saved the page follows the device.
(function () {
  var KEY = 'cg_theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try {
      var value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) {
      return null; // private browsing: follow the device
    }
  }

  function current() {
    return saved() || (media && media.matches ? 'dark' : 'light');
  }

  function apply(theme) {
    if (theme) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  /** The button is a toggle for dark mode; its icon shows what a tap switches to. */
  function sync() {
    var button = document.getElementById('theme-btn');
    if (!button) return;
    var dark = current() === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  apply(saved());
  document.addEventListener('DOMContentLoaded', sync);
  if (media && media.addEventListener) media.addEventListener('change', sync);

  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('#theme-btn');
    if (!button) return;
    var next = current() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch (e) {
      /* the choice lasts until the page is reloaded */
    }
    switchTo(next);
  });

  /**
   * Changes theme by blending: every colour on the page eases from the old
   * theme to the new one over most of a second. Nothing moves for anyone who
   * has asked their device for less motion.
   */
  var BLEND_MS = 700;
  var blendTimer = null;
  function switchTo(next) {
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still) {
      root.classList.add('theme-blending');
      clearTimeout(blendTimer);
      blendTimer = setTimeout(function () {
        root.classList.remove('theme-blending');
      }, BLEND_MS + 50);
    }
    apply(next);
    sync();
  }
})();
