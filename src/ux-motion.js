/* DayPay — Know what your work is worth.
   Copyright © 2026 Akaninyene. All rights reserved.
   Unauthorized copying, modification, or distribution is prohibited. */

/* ============================================================
   DayPay ux-motion.js — VISUAL ONLY enhancement layer
   - Mirrors the current month/year name into hero panels
     (rendered by CSS via attr(), no DOM text injected)
   - Adds a subtle bump animation when hero figures change
   - Re-triggers a subtle view-enter animation on Month/Year switch
   Does NOT change data, logic, auth, routes or calculations.
   React remains the sole source of truth. This script NEVER writes
   text content — it only touches data-* attributes and CSS classes,
   which its own observer does not watch (no feedback loops).
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function toNum(text) {
    var d = String(text == null ? '' : text).replace(/[^0-9]/g, '');
    return d === '' ? NaN : parseInt(d, 10);
  }

  /* ---- 1. Mirror month/year label for hero panels (CSS attr) ---- */
  function syncLabels() {
    var m = document.querySelector('.month-name');
    if (!m) return;
    var t = (m.textContent || '').trim();
    if (!t) return;
    var st = document.querySelector('.summary-top');
    if (st && st.getAttribute('data-month') !== t) st.setAttribute('data-month', t);
    var ym = document.querySelector('.yt-main');
    if (ym && ym.getAttribute('data-year') !== t) ym.setAttribute('data-year', t);
  }

  /* ---- 2. Bump animation when hero figures change (class only) ---- */
  function bump(el) {
    if (reduceMotion) return;
    el.classList.remove('dp-bump');
    /* force reflow so re-adding restarts the animation */
    void el.offsetWidth;
    el.classList.add('dp-bump');
  }

  function checkAmounts(scope) {
    var root = scope || document;
    var els = root.querySelectorAll
      ? root.querySelectorAll('.summary-amount, .yt-amount, .fsb-amount')
      : [];
    for (var i = 0; i < els.length; i++) track(els[i]);
    if (root !== document && root.classList &&
        (root.classList.contains('summary-amount') ||
         root.classList.contains('yt-amount') ||
         root.classList.contains('fsb-amount'))) {
      track(root);
    }
  }

  function track(el) {
    var v = toNum(el.textContent);
    if (isNaN(v)) return;
    if (typeof el.__dpValue !== 'number') { el.__dpValue = v; return; } // adopt silently
    if (el.__dpValue !== v) { el.__dpValue = v; bump(el); }
  }

  /* ---- 3. One-shot enter animation for swapped views ---- */
  function enterify(node) {
    if (reduceMotion || !node || !node.classList) return;
    if (node.classList.contains('calendar-grid') ||
        node.classList.contains('summary-card') ||
        node.classList.contains('year-totals') ||
        node.classList.contains('months-list')) {
      node.classList.remove('dp-enter');
      void node.offsetWidth;
      node.classList.add('dp-enter');
    }
  }

  document.addEventListener('animationend', function (e) {
    if (e.target && e.target.classList &&
        (e.target.classList.contains('dp-enter') || e.target.classList.contains('dp-bump'))) {
      e.target.classList.remove('dp-enter');
      e.target.classList.remove('dp-bump');
    }
  });

  /* ---- observe React renders (childList + text only; never attributes) ---- */
  var root = document.getElementById('root');
  if (root && window.MutationObserver) {
    var mo = new MutationObserver(function (muts) {
      var needLabels = false, needAmounts = false;
      for (var i = 0; i < muts.length; i++) {
        var mu = muts[i];
        if (mu.type === 'childList') {
          for (var a = 0; a < mu.addedNodes.length; a++) {
            var n = mu.addedNodes[a];
            if (n.nodeType !== 1) continue;
            enterify(n);
            if (n.querySelectorAll) {
              var grids = n.querySelectorAll('.calendar-grid, .summary-card, .year-totals, .months-list');
              for (var g = 0; g < grids.length; g++) enterify(grids[g]);
            }
          }
          needLabels = true; needAmounts = true;
        } else if (mu.type === 'characterData') {
          var t = mu.target.parentNode;
          if (t && t.classList &&
              (t.classList.contains('month-name') || t.classList.contains('year-name'))) {
            needLabels = true;
          } else {
            needAmounts = true;
          }
        }
      }
      if (needLabels) syncLabels();
      if (needAmounts) checkAmounts(document);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
  }

  /* initial pass (after first render) */
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    syncLabels();
    checkAmounts(document);
    if (document.querySelector('.month-name') || tries > 40) clearInterval(iv);
  }, 150);
})();
