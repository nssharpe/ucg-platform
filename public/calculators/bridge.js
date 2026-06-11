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

    // Let the parent request a reset or re-preset.
    window.addEventListener('message', function (ev) {
      if (ev.data && ev.data.type === 'ucg-calc-preset' && cfg.preset) {
        params = new URLSearchParams(ev.data.query || '');
        try { cfg.preset(); } catch (e) { /* ignore */ }
      }
    });
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
