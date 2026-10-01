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
   * Changes theme by blending: the browser takes a picture of the page in the
   * old theme and cross-fades it into the new one, so every pixel — text,
   * backgrounds, borders — moves evenly from one colour to the other at the
   * same pace. (Fading each element's own colours instead left inherited text
   * lagging behind and snapping at the end.) Browsers without that just
   * switch. Nothing moves for anyone who has asked their device for less
   * motion.
   */
  function switchTo(next) {
    function change() {
      apply(next);
      sync();
    }
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still || !document.startViewTransition) return change();
    document.startViewTransition(change);
  }
})();
