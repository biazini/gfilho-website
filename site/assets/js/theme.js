// Runs in <head> before the first paint: re-applies the light/dark choice saved by the header
// switch, so the page never flashes the other theme. Without a saved choice the CSS follows the OS.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable: follow the OS setting */ }
})();
