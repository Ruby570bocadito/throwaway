// Runs before the landing page paints (a classic script in <head>, served from this origin so the CSP needs no hash).
// Links shared before the landing page existed (/?demo, #truth=…) belong to the app. And if the page script never runs,
// show everything anyway: the motion is a layer, never a gate.
(function () {
  var s = location.search, h = location.hash, root = document.documentElement;
  if (/[?&]demo\b/.test(s) || /truth=/.test(h)) location.replace('/app/' + s + h);
  // A browser in Spanish gets the Spanish page, unless a language was picked: the switch remembers it, and ?lang=en or
  // ?lang=es in a link picks one. English stays the default for everyone else (22-nov).
  var pick = (s.match(/[?&]lang=(en|es)\b/) || [])[1] || null;
  try {
    if (pick) localStorage.setItem('lang', pick);
    else pick = localStorage.getItem('lang');
  } catch (e) {}
  var first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  if ((location.pathname === '/' || location.pathname === '/index.html') && (pick === 'es' || (!pick && /^es\b/i.test(first)))) {
    location.replace('/es/' + s + h);
    return;
  }
  root.classList.add('js');
  setTimeout(function () { if (!window.__landing) root.classList.remove('js'); }, 2500);
})();
