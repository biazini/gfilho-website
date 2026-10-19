// gfilho.net: footer year, section nav highlight and the "Latest project" pulse.
// The page works without this script; it only adds orientation cues.
(function () {
  'use strict';

  var yr = document.getElementById('yr');
  if (yr) yr.textContent = String(new Date().getFullYear());

  // Light/dark switch. Until the visitor picks one, the page follows the OS setting (CSS media
  // query); a click saves the opposite of the theme on screen, and theme.js restores it next time.
  var toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    var root = document.documentElement;
    var prefersLight = window.matchMedia('(prefers-color-scheme: light)');
    var bars = document.querySelectorAll('meta[name="theme-color"]');
    var shown = function () { return root.getAttribute('data-theme') || (prefersLight.matches ? 'light' : 'dark'); };
    var paint = function () {
      var mode = shown();
      var label = mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      toggle.setAttribute('data-mode', mode);
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      // keep the browser bar in step with an explicit choice
      if (root.hasAttribute('data-theme')) {
        for (var i = 0; i < bars.length; i++) bars[i].setAttribute('content', mode === 'dark' ? '#10172A' : '#F5F7FB');
      }
    };
    toggle.addEventListener('click', function () {
      var next = shown() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* not saved: applies to this page only */ }
      paint();
    });
    if (prefersLight.addEventListener) prefersLight.addEventListener('change', paint);
    paint();
    toggle.hidden = false;
  }

  var nav = document.querySelector('.nav');
  if (!nav) return;
  var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
  var sections = links
    .map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
    .filter(Boolean);

  // On narrow screens the nav scrolls sideways: fade the edge while more items are hidden,
  // and keep the current item in view without moving the page.
  function updateOverflow() {
    var more = nav.scrollWidth - nav.clientWidth - nav.scrollLeft > 4;
    nav.classList.toggle('has-more', more);
  }
  function keepVisible(a) {
    if (nav.scrollWidth <= nav.clientWidth) return;
    var left = a.offsetLeft, right = left + a.offsetWidth;
    if (left < nav.scrollLeft + 16) nav.scrollLeft = Math.max(0, left - 16);
    else if (right > nav.scrollLeft + nav.clientWidth - 16) nav.scrollLeft = right - nav.clientWidth + 48;
  }

  var currentId = null;
  function setCurrent(id) {
    if (id === currentId) return;
    currentId = id;
    links.forEach(function (a) {
      if (a.getAttribute('href') === '#' + id) {
        a.setAttribute('aria-current', 'true');
        keepVisible(a);
      } else {
        a.removeAttribute('aria-current');
      }
    });
    updateOverflow();
  }

  // After a nav click the target may sit near the bottom of the page and never reach the top,
  // so hold the clicked item for a moment instead of letting the scroll position decide.
  var lockUntil = 0;

  function update() {
    ticking = false;
    if (Date.now() < lockUntil) return;
    var line = Math.min(window.innerHeight * 0.35, 320);
    var current = sections[0];
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= line) current = sections[i];
    }
    var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atBottom && window.scrollY > 0) current = sections[sections.length - 1];
    setCurrent(current.id);
  }
  var ticking = false;
  function onScroll() {
    if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
  }

  function pulse(id) {
    var el = document.getElementById(id);
    if (!el || !el.classList.contains('card')) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    var target = document.getElementById(id);
    if (!target) return;
    var owner = target.closest('main section[id]');
    if (owner && sections.indexOf(owner) >= 0) {
      setCurrent(owner.id);
      lockUntil = Date.now() + 900;
    }
    pulse(id);
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () { updateOverflow(); onScroll(); });
  nav.addEventListener('scroll', updateOverflow, { passive: true });

  // The markup already marks "About" as current, so the first measurement can wait until the
  // page has loaded and painted instead of forcing an extra layout while fonts are still arriving.
  function start() {
    window.requestAnimationFrame(function () {
      if (location.hash) pulse(location.hash.slice(1));
      if (window.scrollY > 0 || location.hash) update();
      updateOverflow();
    });
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
