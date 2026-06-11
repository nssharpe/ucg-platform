/* UCG calculator bridge — appended to each NAIGC calculator without touching its logic.
 * Reads the calculator's score display elements and postMessages live D / E / Final
 * to the embedding UCG app, and presets apparatus / ruleset from URL params.
 *
 * Message shape: { type: 'ucg-calc', calc, d, e, final }  (any value may be null)
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);

  // Per-calculator config, chosen by which elements exist on the page.
  var CONFIGS = [
    {
      calc: 'mag',
      test: function () { return document.getElementById('start-value-total'); },
      d: 'start-value-total', e: null, final: null,
      preset: function () {
        setSelect('ruleset', params.get('ruleset'));
        setSelect('apparatus', params.get('apparatus'));
      },
    },
    {
      calc: 'wag-open',
      test: function () { return document.getElementById('naigc-wag-final-score'); },
      d: 'naigc-wag-d-score', e: 'naigc-wag-e-score', final: 'naigc-wag-final-score',
      preset: function () {
        var map = { UB: 'bars', BB: 'beam', FX: 'floor' };
        setSelect('naigc-wag-apparatus', map[params.get('apparatus')]);
      },
    },
    {
      calc: 'wag-vault',
      test: function () { return document.getElementById('naigc-wagv-final-score'); },
      d: 'naigc-wagv-d-score', e: 'naigc-wagv-e-score', final: 'naigc-wagv-final-score',
    },
    {
      // NAIGC T&T — produces D (difficulty), E (execution) and Final.
      calc: 'tnt',
      test: function () { return document.getElementById('naigc-tnt-final'); },
      d: 'naigc-tnt-d', e: 'naigc-tnt-e', final: 'naigc-tnt-final',
      preset: function () {
        setSelect('naigc-tnt-event', params.get('apparatus'));
        setSelect('naigc-tnt-level', params.get('level'));
      },
    },
    {
      // Xcel & Level 9 start-value builder — produces a start value only.
      calc: 'wag-sv',
      test: function () { return document.getElementById('naigc-wsv-sv'); },
      d: 'naigc-wsv-sv', e: null, final: null,
      preset: function () {
        setSelect('naigc-wsv-level', params.get('level'));
        var map = { UB: 'bars', BB: 'beam', FX: 'floor', VT: 'vault' };
        setSelect('naigc-wsv-event', map[params.get('apparatus')]);
      },
    },
    {
      calc: 'masters',
      test: function () { return document.getElementById('nm-final-score'); },
      // Read whichever block (non-vault or vault) is visible.
      d: ['nm-d-score', 'nm-vault-d-score'],
      e: ['nm-e-score', 'nm-vault-e-score'],
      final: ['nm-final-score', 'nm-vault-final-score'],
      preset: function () { setSelect('nm-apparatus', params.get('apparatus')); },
    },
  ];

  function setSelect(id, value) {
    if (!value) return;
    var el = document.getElementById(id);
    if (!el) return;
    // Match by value, else by visible text (case-insensitive).
    var opts = Array.prototype.slice.call(el.options);
    var match = opts.filter(function (o) { return o.value === value; })[0]
      || opts.filter(function (o) { return o.textContent.trim().toLowerCase() === String(value).toLowerCase(); })[0];
    if (match) {
      el.value = match.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function num(id) {
    if (!id) return null;
    var ids = Array.isArray(id) ? id : [id];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      // Skip elements hidden (e.g. the inactive vault/non-vault block).
      if (el && el.offsetParent !== null) {
        var v = parseFloat((el.textContent || '').replace(/[^0-9.\-]/g, ''));
        if (!isNaN(v)) return v;
      }
    }
    // Fall back to first parseable even if hidden.
    for (var j = 0; j < ids.length; j++) {
      var e2 = document.getElementById(ids[j]);
      if (e2) {
        var v2 = parseFloat((e2.textContent || '').replace(/[^0-9.\-]/g, ''));
        if (!isNaN(v2)) return v2;
      }
    }
    return null;
  }

  // ---- Generic state capture/restore -------------------------------------
  // Serializes every form control (by document-order index) plus any buttons
  // carrying a `.selected` class (the MAG calculator's skill/EG buttons), so a
  // posted score can store exactly how the calculator was filled in, and the
  // score-detail view can re-open it in that state for review or adjustment.
  function allFields() {
    return Array.prototype.slice.call(document.querySelectorAll('input, select, textarea'));
  }
  function allButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('button'));
  }
  function getState() {
    var fields = allFields().map(function (el) {
      return el.type === 'checkbox' || el.type === 'radio' ? { c: el.checked ? 1 : 0 } : { v: el.value };
    });
    var selected = [];
    var btns = allButtons();
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains('selected')) selected.push(i);
    }
    return { fields: fields, selected: selected };
  }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
  function setState(state) {
    if (!state) return;
    // Pass 1: selects first — they often rebuild dependent sections (MAG rows).
    var fields = allFields();
    for (var i = 0; i < fields.length && i < state.fields.length; i++) {
      var el = fields[i], s = state.fields[i];
      if (el.tagName === 'SELECT' && s.v != null && el.value !== s.v) { el.value = s.v; fire(el, 'change'); }
    }
    // Pass 2: replay selected buttons (fresh page has none selected).
    var btns = allButtons();
    (state.selected || []).forEach(function (idx) {
      var b = btns[idx];
      if (b && !b.classList.contains('selected')) b.click();
    });
    // Pass 3: remaining inputs/checkboxes (re-query — sections may have rebuilt).
    fields = allFields();
    for (var j = 0; j < fields.length && j < state.fields.length; j++) {
      var el2 = fields[j], s2 = state.fields[j];
      if (el2.tagName === 'SELECT') continue;
      if (s2.c != null) {
        if (el2.checked !== !!s2.c) { el2.checked = !!s2.c; fire(el2, 'change'); }
      } else if (s2.v != null && el2.value !== s2.v) {
        el2.value = s2.v; fire(el2, 'input'); fire(el2, 'change');
      }
    }
  }

  function start(cfg) {
    if (cfg.preset) { try { cfg.preset(); } catch (e) { /* preset best-effort */ } }

    var last = '';
    function emit() {
      var payload = { type: 'ucg-calc', calc: cfg.calc, d: num(cfg.d), e: num(cfg.e), final: num(cfg.final) };
      var sig = JSON.stringify(payload);
      if (sig === last) return;
      last = sig;
      try { parent.postMessage(payload, '*'); } catch (e) { /* not embedded */ }
    }

    // Observe the whole app subtree so any recompute triggers an emit.
    var root = document.body;
    new MutationObserver(emit).observe(root, { subtree: true, childList: true, characterData: true });
    document.addEventListener('change', emit, true);
    document.addEventListener('click', function () { setTimeout(emit, 0); }, true);
    // Initial + safety poll.
    emit();
    setInterval(emit, 600);

    // Parent messages: re-preset, state capture, state restore.
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (!d || !d.type) return;
      if (d.type === 'ucg-calc-preset' && cfg.preset) {
        params = new URLSearchParams(d.query || '');
        try { cfg.preset(); } catch (e) { /* ignore */ }
      } else if (d.type === 'ucg-calc-get-state') {
        try {
          parent.postMessage({ type: 'ucg-calc-state', calc: cfg.calc, reqId: d.reqId, state: getState() }, '*');
        } catch (e) { /* not embedded */ }
      } else if (d.type === 'ucg-calc-set-state') {
        try { setState(d.state); } catch (e) { /* best effort */ }
        setTimeout(emit, 50);
      }
    });
    try { parent.postMessage({ type: 'ucg-calc-ready', calc: cfg.calc }, '*'); } catch (e) { /* standalone */ }
  }

  function boot() {
    for (var i = 0; i < CONFIGS.length; i++) {
      if (CONFIGS[i].test()) { start(CONFIGS[i]); return; }
    }
    // Elements may render slightly after load; retry briefly.
    setTimeout(boot, 150);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
