// Runs before the landing page paints (a classic script in <head>, served from this origin so the CSP needs no hash).
// Links shared before the landing page existed (/?demo, #truth=…) belong to the app. And if the page script never runs,
// show everything anyway: the motion is a layer, never a gate.
(function () {
  var s = location.search, h = location.hash, root = document.documentElement;
  if (/[?&]demo\b/.test(s) || /truth=/.test(h)) location.replace('/app/' + s + h);
  root.classList.add('js');
  setTimeout(function () { if (!window.__landing) root.classList.remove('js'); }, 2500);
})();
