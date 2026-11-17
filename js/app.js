/*
 * Interface : état, liaisons formulaire ↔ état (attribut data-bind), rendu des onglets.
 * L'état est sauvegardé dans le localStorage du navigateur ; les calculs viennent de SpinModel.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'spinlab.v1';
  var THEME_KEY = 'spinlab.theme';
  var MAX_TOTAL_GAMES = 2e10;
  var MAX_CHECKPOINT_VALUES = 2e7;
  var GRID_STALE_DAYS = 183; /* grille officielle à revérifier au-delà (≈ 6 mois) */

  var state;
  var lastSim = null;
  var running = null;

  /* ================= Utilitaires ================= */

  function $(id) { return document.getElementById(id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var num = SpinModel.num;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtNum(v, d) {
    if (!isFinite(v)) return '—';
    if (Math.abs(v) < 0.5 * Math.pow(10, -d)) v = 0; /* évite « -0,00 » */
    return v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtEur(v, d) {
    if (!isFinite(v)) return '—';
    if (d == null) d = Math.abs(v) >= 1000 ? 0 : 2;
    return fmtNum(v, d) + ' €';
  }
  function fmtSignedEur(v, d) { return isFinite(v) && v > 0 ? '+' + fmtEur(v, d) : fmtEur(v, d); }
  function fmtPct(x, d) {
    if (!isFinite(x)) return '—';
    if (d == null) {
      var a = Math.abs(x * 100);
      d = a === 0 ? 0 : a < 0.0001 ? 7 : a < 0.01 ? 5 : a < 1 ? 3 : 2;
    }
    return fmtNum(x * 100, d) + ' %';
  }
  function fmtSignedPct(x, d) { return isFinite(x) && x > 0 ? '+' + fmtPct(x, d) : fmtPct(x, d); }
  function fmtInt(v) { return isFinite(v) ? Math.round(v).toLocaleString('fr-FR') : '—'; }
  function fmtOneIn(p) { return p > 0 ? '1 / ' + fmtInt(1 / p) : '—'; }
  function fmtMult(m) { return '×' + fmtNum(m, m % 1 === 0 ? 0 : 2); }
  function signClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }

  /* adv : indicateur masqué en mode simple */
  function kpi(label, value, sub, cls, adv) {
    return '<div class="kpi' + (cls && cls.indexOf('hero') >= 0 ? ' hero' : '') + (adv ? ' adv-only' : '') + '">' +
      '<div class="k-label">' + label + '</div>' +
      '<div class="k-value ' + (cls || '').replace('hero', '') + '">' + value + '</div>' +
      (sub ? '<div class="k-sub">' + sub + '</div>' : '') + '</div>';
  }

  function download(name, content, type) {
    var blob = new Blob([content], { type: type || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function readFile(input, cb) {
    var f = input.files && input.files[0];
    if (!f) return;
    var r = new FileReader();
    /* le champ est vidé même si le traitement échoue, pour pouvoir re-choisir le même fichier */
    r.onload = function () {
      try { cb(String(r.result), f.name); } finally { input.value = ''; }
    };
    r.readAsText(f);
  }

  /* ================= État ================= */

  /* Un null sauvegardé est conservé (champ vidé volontairement), sauf à la place d'un objet. */
  function mergeDeep(base, extra) {
    if (Array.isArray(base) || Array.isArray(extra)) return Array.isArray(extra) ? extra : base;
    if (base && typeof base === 'object') {
      if (extra !== undefined && (extra === null || typeof extra !== 'object')) return base;
      var out = {};
      Object.keys(base).forEach(function (k) { out[k] = mergeDeep(base[k], extra ? extra[k] : undefined); });
      if (extra && typeof extra === 'object') {
        Object.keys(extra).forEach(function (k) { if (!(k in out)) out[k] = extra[k]; });
      }
      return out;
    }
    return extra !== undefined ? extra : base;
  }

  function gridFromPreset(p) {
    return { name: p.name, buyIn: p.buyIn, stack: p.stack, feePct: p.feePct, rows: clone(p.rows) };
  }

  function allPresets() { return SPIN_PRESETS.concat(state.userPresets || []); }
  function findPresetIn(list, id) { return list.filter(function (p) { return p.id === id; })[0]; }
  function findPreset(id) { return findPresetIn(allPresets(), id); }
  function defaultPreset() { return findPreset(SPIN_DEFAULT_STATE.presetId) || SPIN_PRESETS[0]; }

  function loadState() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    state = mergeDeep(clone(SPIN_DEFAULT_STATE), saved || {});
    /* état d'avant les grilles officielles : on démarre sur une vraie grille plutôt que l'exemple */
    if (saved && !saved.ui && saved.presetId === 'exemple-generique') {
      state.presetId = SPIN_DEFAULT_STATE.presetId;
      state.grid = null;
    }
    if (!state.grid || !Array.isArray(state.grid.rows)) {
      state.grid = gridFromPreset(findPreset(state.presetId) || defaultPreset());
    }
  }

  /* ================= Mode simple / expert ================= */

  function isSimple() { return state.ui.mode !== 'expert'; }

  /* Réglages réellement utilisés : en mode simple, valeurs standard pour tout ce qui est masqué. */
  function effProfile() {
    if (!isSimple()) return state.profile;
    return {
      cevMode: 'global', cev: state.profile.cev, tranches: [], finishModel: 'harville', share2: 50,
      uncertainty: { enabled: true, nSample: state.profile.uncertainty.nSample, sdMode: 'auto', sd: 0 }
    };
  }
  function effRb() {
    return isSimple() ? { mode: 'pct', pct: state.rb.pct, feeMode: 'grid', extraEur: 0 } : state.rb;
  }
  function effSim() {
    return isSimple() ? Object.assign({}, state.sim, SPIN_SIMPLE_SIM) : state.sim;
  }

  function applyMode() {
    var simple = isSimple();
    document.body.classList.toggle('mode-simple', simple);
    document.querySelectorAll('.mode-switch button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.mode === state.ui.mode || (simple && b.dataset.mode === 'simple')));
    });
    var active = document.querySelector('.tabs button.active');
    if (!active || active.offsetParent === null) showTab('analysis');
  }

  var saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* stockage indisponible */ }
  }
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 200);
  }
  /* fermeture ou rechargement pendant le délai : on écrit tout de suite pour ne rien perdre */
  function flushSave() { if (saveTimer) saveNow(); }

  function getPath(path) {
    var parts = path.split('.');
    var o = state;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }

  function setPath(path, value) {
    var parts = path.split('.');
    var o = state;
    for (var i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }

  /* ================= Liaisons ================= */

  function fillOne(el) {
    var v = getPath(el.dataset.bind);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else el.value = v == null || (typeof v === 'number' && !isFinite(v)) ? '' : v;
  }

  function fillBindings(root) {
    (root || document).querySelectorAll('[data-bind]').forEach(fillOne);
  }

  function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') {
      if (el.value.trim() === '') return null;
      var n = parseFloat(el.value);
      return isFinite(n) ? n : null;
    }
    return el.value;
  }

  function onBoundInput(e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.bind) return;
    if (el.type === 'radio' && !el.checked) return;
    setPath(el.dataset.bind, readInput(el));
    var path = el.dataset.bind;
    /* un même réglage peut avoir un champ en mode simple et un autre en mode expert */
    document.querySelectorAll('[data-bind="' + path + '"]').forEach(function (other) {
      if (other !== el && other.type !== 'radio') fillOne(other);
    });
    if (path === 'profile.cevMode' || path === 'profile.finishModel' || path.indexOf('profile.uncertainty') === 0 ||
        path.indexOf('rb.') === 0) updateVisibility();
    refreshAll();
  }

  function updateVisibility() {
    var p = effProfile(), rb = state.rb;
    $('tranches-box').hidden = p.cevMode !== 'tranches';
    $('lbl-cev').textContent = p.cevMode === 'tranches'
      ? 'cEV de référence (incertitude, tranches manquantes)'
      : 'cEV moyen (jetons / partie)';
    $('share2-field').hidden = p.finishModel !== 'manual';
    $('unc-fields').hidden = !p.uncertainty.enabled;
    $('sd-field').hidden = p.uncertainty.sdMode !== 'manual';
    $('feeEur-field').hidden = rb.feeMode !== 'eur';
    $('rbPct-field').hidden = rb.mode !== 'pct';
    $('rbFixed-field').hidden = rb.mode !== 'fixed';
    $('tiers-box').hidden = rb.mode !== 'tiers';
  }

  /* ================= Config & validation ================= */

  function rbInfo() {
    return SpinModel.rakebackPerGame(effRb(), num(state.grid.buyIn, 0), num(state.grid.feePct, 0));
  }

  function buildCfg() {
    var g = state.grid;
    var stack = num(g.stack, 0);
    var profile = effProfile();
    var sim = effSim();
    /* copies : la config d'une simulation ne doit pas suivre les éditions faites ensuite */
    return {
      rows: clone(g.rows),
      buyIn: num(g.buyIn, 0),
      stack: stack,
      profile: clone(profile),
      rbPerGame: rbInfo().total,
      games: Math.floor(num(sim.games, 0)),
      checkpoints: Math.floor(num(sim.checkpoints, 200)),
      jackpotMult: num(sim.jackpotMult, Infinity),
      smoothJackpots: !!sim.smoothJackpots,
      cevSe: SpinModel.cevStdError(profile, stack)
    };
  }

  function validate() {
    var errs = [];
    var g = state.grid;
    if (!(num(g.buyIn, 0) > 0)) errs.push('Le buy-in doit être > 0.');
    if (!(num(g.stack, 0) > 0)) errs.push('Le tapis de départ doit être > 0.');
    if (num(g.buyIn, 0) > 0 && !SpinModel.normalizeRows(g.rows, num(g.buyIn, 0)).rows.length) {
      errs.push('La grille ne contient aucune ligne valide (fréquence > 0 et prize pool > 0).');
    }
    return errs;
  }

  function validateSim() {
    var errs = [];
    var sim = effSim();
    var games = num(sim.games, 0), sims = num(sim.sims, 0);
    var K = num(sim.checkpoints, 200);
    if (!(games >= 1)) errs.push('Nombre de parties par trajectoire ≥ 1.');
    if (games > 1e9) errs.push('Nombre de parties par trajectoire ≤ 1 milliard.');
    if (!(sims >= 1)) errs.push('Nombre de simulations ≥ 1.');
    if (!(K >= 10)) errs.push('Points par courbe ≥ 10.');
    var paths = num(sim.paths, 0);
    if (!(paths >= 0 && paths <= 200)) errs.push('Trajectoires affichées : entre 0 et 200.');
    if (games * sims > MAX_TOTAL_GAMES) {
      /* en mode simple le nombre de simulations est caché : on parle du seul réglage visible */
      errs.push(isSimple()
        ? 'Trop de parties prévues : maximum ' + fmtInt(Math.floor(MAX_TOTAL_GAMES / sims)) + ' (l\'outil simule ' + fmtInt(sims) + ' trajectoires).'
        : 'Trop de parties au total (' + fmtInt(games * sims) + ' > ' + fmtInt(MAX_TOTAL_GAMES) + ') : réduis les parties ou les simulations.');
    }
    if (sims * Math.min(K, games) > MAX_CHECKPOINT_VALUES) errs.push('Trop de simulations × points par courbe (mémoire) : réduis l\'un des deux.');
    return errs;
  }

  /* ================= Rendu : barre latérale ================= */

  function renderSidebarDerived() {
    var stack = num(state.grid.stack, 0);
    var profile = effProfile();
    if (stack > 0) {
      var p1 = SpinModel.winProb(num(profile.cev, 0), stack);
      var pr = SpinModel.placeProbs(p1, profile.finishModel, profile.share2);
      $('derived-p1').innerHTML = 'Avec ce cEV' + (profile.cevMode === 'tranches' ? ' de référence' : '') +
        ', tu gagnes <b>' + fmtPct(pr[0], 2) + '</b> des parties (joueur neutre : 33,33 %).' +
        (isSimple() ? '' : ' P(2e) = ' + fmtPct(pr[1], 2) + ' · P(3e) = ' + fmtPct(pr[2], 2));
      var se = SpinModel.cevStdError(profile, stack);
      var c = num(profile.cev, 0);
      $('derived-se').innerHTML = profile.uncertainty.enabled && se > 0
        ? 'Sur cet échantillon, ton vrai cEV est très probablement (95 %) entre <b>' + fmtNum(c - 1.96 * se, 0) +
          '</b> et <b>' + fmtNum(c + 1.96 * se, 0) + '</b> jetons (±' + fmtNum(1.96 * se, 0) + '). ' +
          'Il faut 4× plus de parties pour diviser cette marge par 2. La simulation en tient compte.'
        : '';
    } else {
      $('derived-p1').textContent = '';
      $('derived-se').textContent = '';
    }
    var rb = rbInfo();
    var b = num(state.grid.buyIn, 0);
    var rbMode = effRb().mode;
    $('derived-rb').innerHTML = 'Rake payé : ' + fmtEur(rb.fee, 3) +
      (rbMode !== 'none' && rbMode !== 'fixed' ? ' · taux : ' + fmtNum(rb.pct, 1) + ' %' : '') +
      ' · rakeback : ' + fmtEur(rb.rakeback, 3) + ' · <b>total : ' + fmtEur(rb.total, 3) + ' / partie</b>' +
      (b > 0 ? ' (' + fmtPct(rb.total / b, 2) + ' du buy-in)' : '');
  }

  function buildTranches() {
    var body = $('tranches-body');
    body.innerHTML = state.profile.tranches.map(function (t, i) {
      return '<tr><td><input type="number" min="0" step="any" data-bind="profile.tranches.' + i + '.from"></td>' +
        '<td><input type="number" step="any" data-bind="profile.tranches.' + i + '.cev"></td>' +
        '<td><button type="button" class="btn icon ghost" data-del-tranche="' + i + '" title="Supprimer">✕</button></td></tr>';
    }).join('');
    fillBindings(body);
  }

  function buildTiers() {
    var body = $('tiers-body');
    body.innerHTML = state.rb.tiers.map(function (t, i) {
      return '<tr><td><input type="number" min="0" step="1" data-bind="rb.tiers.' + i + '.minGames"></td>' +
        '<td><input type="number" min="0" step="any" data-bind="rb.tiers.' + i + '.pct"></td>' +
        '<td><button type="button" class="btn icon ghost" data-del-tier="' + i + '" title="Supprimer">✕</button></td></tr>';
    }).join('');
    fillBindings(body);
  }

  /* ================= Rendu : grille ================= */

  /* ---------- Sélecteur room / buy-in ---------- */

  function roomOf(p) { return p.builtin ? p.room : 'user'; }

  function presetsForRoom(roomId) {
    return roomId === 'user' ? state.userPresets : SPIN_PRESETS.filter(function (p) { return p.room === roomId; });
  }

  function buyInLabel(p) {
    return p.builtin && p.room !== 'exemples' ? fmtNum(p.buyIn, p.buyIn % 1 === 0 ? 0 : 2) + ' €' : p.name;
  }

  function gridMatchesPreset(p) {
    var g = state.grid;
    return num(g.buyIn, 0) === p.buyIn && num(g.stack, 0) === p.stack && num(g.feePct, 0) === p.feePct &&
      JSON.stringify(g.rows) === JSON.stringify(p.rows);
  }

  function renderPresetPicker() {
    var current = findPreset(state.presetId);
    var room = current ? roomOf(current) : '';
    var rooms = SPIN_ROOMS.filter(function (r) { return r.id !== 'user' || state.userPresets.length; });
    $('room-select').innerHTML = (current ? '' : '<option value="">Grille importée / personnalisée</option>') +
      rooms.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + '</option>'; }).join('');
    $('room-select').value = room;
    var list = current ? presetsForRoom(room) : [];
    $('buyin-select').innerHTML = list.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(buyInLabel(p)) + '</option>';
    }).join('');
    $('buyin-select').disabled = !list.length;
    if (current) $('buyin-select').value = current.id;
    renderPresetInfo();
  }

  /* Statistiques de la grille, calculées une fois et partagées par les rendus d'un même rafraîchissement. */
  function gridContext() {
    var b = num(state.grid.buyIn, 0);
    if (!(b > 0)) return { b: b, stats: null };
    var jm = num(effSim().jackpotMult, Infinity);
    var top = 0;
    SpinModel.normalizeRows(state.grid.rows, b).rows.forEach(function (r) { if (r.effMult > top) top = r.effMult; });
    return { b: b, jm: jm, top: top, stats: SpinModel.tableStats(state.grid.rows, b, jm) };
  }

  function renderPresetInfo(gc) {
    gc = gc || gridContext();
    var p = findPreset(state.presetId);
    var parts = [];
    if (gc.stats) {
      parts.push('Rake réel <b>' + fmtNum(gc.stats.hiddenRakePct, 2) + ' %</b> · effectif hors jackpots <b>' + fmtNum(gc.stats.effectiveRakePct, 2) + ' %</b>');
      parts.push('Jackpot max ' + fmtMult(gc.top) + ' (' + fmtEur(gc.top * gc.b, 0) + ')');
    }
    /* source affichée seulement pour les grilles intégrées : un preset importé ne doit pas injecter de lien */
    if (p && p.builtin && /^https:\/\//.test(p.source || '')) {
      var host = p.source.replace(/^https:\/\/(www\.)?/, '').split('/')[0];
      parts.push('Grille officielle : <a href="' + esc(p.source) + '" target="_blank" rel="noopener">' + esc(host) + '</a>' +
        (p.checked ? ', relevée le ' + p.checked.split('-').reverse().join('/') : ''));
      /* les rooms changent leurs grilles sans préavis : au-delà de 6 mois, on invite à revérifier */
      var age = p.checked ? (Date.now() - new Date(p.checked + 'T00:00:00').getTime()) / 864e5 : NaN;
      if (age > GRID_STALE_DAYS) {
        parts.push('<b>Relevée il y a plus de 6 mois</b> : la room a pu changer sa grille, revérifie sur la page source.');
      }
    } else if (p && p.builtin) {
      parts.push('Grille non officielle.');
    }
    if (p && p.note) parts.push(esc(p.note));
    if (p && !gridMatchesPreset(p)) parts.push('<b>Grille modifiée</b> par rapport à l\'original.');
    $('preset-info').innerHTML = parts.join('<br>');
  }

  function onRoomChange() {
    var list = presetsForRoom($('room-select').value);
    if (!list.length) return;
    /* garde le même buy-in si la nouvelle room le propose */
    var b = num(state.grid.buyIn, 0);
    var same = list.filter(function (p) { return p.buyIn === b; })[0];
    loadPreset((same || list[0]).id);
  }

  function buildGridTable() {
    var body = $('grid-body');
    body.innerHTML = state.grid.rows.map(function (r, i) {
      var pre = 'grid.rows.' + i + '.';
      return '<tr data-row="' + i + '">' +
        '<td><input class="w-sm" type="number" min="0" step="any" data-bind="' + pre + 'mult"></td>' +
        '<td><input type="number" min="0" step="any" data-bind="' + pre + 'prize" placeholder="—"></td>' +
        '<td><input type="number" min="0" step="any" data-bind="' + pre + 'weight"></td>' +
        '<td data-d="p"></td><td data-d="one"></td><td data-d="pool"></td>' +
        '<td><input class="w-sm" type="number" min="0" max="100" step="any" data-bind="' + pre + 's1"></td>' +
        '<td><input class="w-sm" type="number" min="0" max="100" step="any" data-bind="' + pre + 's2"></td>' +
        '<td><input class="w-sm" type="number" min="0" max="100" step="any" data-bind="' + pre + 's3"></td>' +
        '<td data-d="sum"></td>' +
        '<td><button type="button" class="btn icon ghost" data-del-row="' + i + '" title="Supprimer la ligne">✕</button></td></tr>';
    }).join('');
    fillBindings(body);
  }

  function updateGridDerived() {
    var b = num(state.grid.buyIn, 0);
    var norm = SpinModel.normalizeRows(state.grid.rows, b);
    var byIdx = {};
    norm.rows.forEach(function (r) { byIdx[r.index] = r; });
    $('grid-body').querySelectorAll('tr').forEach(function (tr) {
      var i = +tr.dataset.row;
      var r = byIdx[i];
      var raw = state.grid.rows[i] || {};
      var sum = num(raw.s1, 0) + num(raw.s2, 0) + num(raw.s3, 0);
      tr.querySelector('[data-d="p"]').textContent = r ? fmtPct(r.p) : 'ignorée';
      tr.querySelector('[data-d="one"]').textContent = r ? fmtOneIn(r.p) : '—';
      tr.querySelector('[data-d="pool"]').textContent = r ? fmtEur(r.pool) : '—';
      var sc = tr.querySelector('[data-d="sum"]');
      sc.textContent = fmtNum(sum, sum % 1 === 0 ? 0 : 2) + ' %';
      sc.className = Math.abs(sum - 100) > 1e-6 ? 'neg' : '';
    });
  }

  function renderGridSummary(gc) {
    var g = state.grid;
    var b = gc.b;
    if (!gc.stats) { $('grid-kpis').innerHTML = ''; $('grid-warnings').innerHTML = ''; return; }
    var jm = gc.jm;
    var st = gc.stats;
    var feeNominal = b * num(g.feePct, 0) / 100;
    $('grid-kpis').innerHTML =
      kpi('Rake réel (jackpots compris)', fmtPct(st.hiddenRakePct / 100, 2), fmtEur(st.hiddenRakePerPlayer, 3) + ' par joueur et par partie', 'hero') +
      kpi('Rake effectif hors jackpots ≥ ' + fmtMult(jm), fmtPct(st.effectiveRakePct / 100, 2),
        fmtEur(st.effectiveRakePerPlayer, 3) + ' par partie tant qu\'aucun jackpot ne tombe') +
      kpi('Multiplicateur moyen', fmtMult(st.expectedMult), 'neutre sans rake : ×3') +
      kpi('Prize pool moyen', fmtEur(st.expectedPool), 'pour ' + fmtEur(3 * b) + ' payés par les 3 joueurs') +
      kpi('Fee nominale (base RB)', fmtEur(feeNominal, 3), fmtNum(num(g.feePct, 0), 2) + ' % du buy-in') +
      kpi('Lignes valides', fmtInt(st.rowCount) + ' / ' + g.rows.length, 'Σ fréquences : ' + fmtInt(st.totalWeight));

    var warns = [];
    st.splitIssues.forEach(function (s) {
      warns.push('Ligne ' + (s.index + 1) + ' : la répartition 1er + 2e + 3e fait ' + fmtNum(s.sum, 2) + ' % au lieu de 100 %.');
    });
    var ignored = g.rows.length - st.rowCount;
    if (ignored > 0) warns.push(ignored + ' ligne(s) ignorée(s) : fréquence ou prize pool nul.');
    if (st.hiddenRakePct < 0) warns.push('Le rake caché est négatif : la grille redistribue plus que les buy-ins payés. Vérifie les fréquences.');
    if (num(g.feePct, 0) > 0 && Math.abs(st.hiddenRakePct - num(g.feePct, 0)) > 1) {
      warns.push('La fee nominale (' + fmtNum(num(g.feePct, 0), 2) + ' %) diffère de plus d\'un point du rake caché (' +
        fmtNum(st.hiddenRakePct, 2) + ' %). Normal si la room calcule le rakeback sur une fee différente ; sinon vérifie la grille.');
    }
    $('grid-warnings').innerHTML = warns.length
      ? '<div class="alert warn"><b>À vérifier</b><ul>' + warns.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>'
      : '';
  }

  /* ================= Rendu : analyse ================= */

  function renderAnalysis(errs, cfg, gc) {
    if (errs.length) {
      $('analysis-kpis').innerHTML = '';
      $('analysis-body').innerHTML = '';
      return;
    }
    var a = SpinModel.analyze(cfg);
    var b = cfg.buyIn;
    var N = cfg.games;
    var rb = cfg.rbPerGame;
    var gph = num(effSim().gamesPerHour, 0);
    var gross = a.grossPrize;
    var jm = gc.jm;
    var st = gc.stats;
    var be = a.breakEvenDelta;
    var beText;
    if (be === null) beText = 'introuvable';
    else if (cfg.profile.cevMode === 'tranches') beText = (be >= 0 ? '+' : '') + fmtNum(be, 1) + ' sur chaque tranche';
    else beText = fmtNum(num(cfg.profile.cev, 0) + be, 1) + ' jetons';

    /* « sans jackpot » = espérance sachant qu'aucun multiplicateur ≥ seuil ne tombe, donc au rake effectif */
    var noJack = a.evNoJackpot;
    var noJackLabel = 'sans jackpot : ';
    $('analysis-kpis').innerHTML =
      kpi('EV par partie', fmtSignedEur(a.ev, 3),
        'au rake réel (' + fmtPct(st.hiddenRakePct / 100, 2) + ', jackpots compris) · rakeback inclus', 'hero ' + signClass(a.ev)) +
      kpi('EV par partie sans jackpot', fmtSignedEur(noJack, 3),
        'au rake effectif (' + fmtPct(st.effectiveRakePct / 100, 2) + ') · ce que tu gagnes tant qu\'aucun jackpot ≥ ' + fmtMult(jm) + ' ne tombe',
        'hero ' + signClass(noJack)) +
      kpi('ROI', fmtSignedPct(a.roi, 2),
        noJackLabel + fmtSignedPct(a.roiNoJackpot, 2) + ' · hors rakeback : ' + fmtSignedPct(a.roiWithoutRb, 2), signClass(a.roi)) +
      kpi('Rake effectif', fmtPct(st.effectiveRakePct / 100, 2),
        'réel : ' + fmtPct(st.hiddenRakePct / 100, 2) +
        (rb > 0 ? ' · net de rakeback : ' + fmtPct(st.effectiveRakePct / 100 - rb / b, 2) : '')) +
      kpi('Rakeback + bonus', fmtEur(rb, 3) + ' / partie', fmtPct(rb / b, 2) + ' du buy-in') +
      kpi('EV par heure', fmtSignedEur(a.ev * gph, 2),
        noJackLabel + fmtSignedEur(noJack * gph, 2) + ' · ' + fmtNum(gph, 0) + ' parties / heure', signClass(a.ev)) +
      kpi('EV sur ' + SpinCharts.fmtGames(N) + ' parties', fmtSignedEur(a.totalEv),
        noJackLabel + fmtSignedEur(noJack * N) + ' · ' + fmtNum(a.totalEv / b, 0) + ' buy-ins', signClass(a.totalEv)) +
      kpi('Poids des jackpots', fmtEur(a.jackpotShareOfEv, 3) + ' / partie', (gross > 0 ? fmtPct(a.jackpotShareOfEv / gross, 2) : '—') + ' des gains bruts espérés', '', true) +
      kpi('P(≥ 1 jackpot sur N)', fmtPct(a.pAtLeastOneJackpot, 2), 'un jackpot toutes les ' + (a.pJackpotPerGame > 0 ? fmtInt(1 / a.pJackpotPerGame) : '—') + ' parties', '', true) +
      kpi('Écart-type par partie', fmtEur(a.sd, 2), fmtNum(a.sd / b, 2) + ' buy-ins · sur N (approx. normale) : ±' + fmtEur(a.totalSdNormal), '', true) +
      kpi('cEV minimum pour gagner', beText, 'EV nulle, rakeback inclus');

    $('analysis-body').innerHTML = a.detail.map(function (d) {
      var share = d.shareOfReturn;
      return '<tr class="' + (d.isJackpot ? 'jackpot' : '') + '">' +
        '<td>' + fmtMult(d.effMult) + '</td>' +
        '<td>' + fmtEur(d.pool) + '</td>' +
        '<td>' + fmtPct(d.p) + '</td>' +
        '<td>' + fmtOneIn(d.p) + '</td>' +
        '<td class="adv-only">' + fmtNum(d.cev, 1) + '</td>' +
        '<td>' + fmtPct(d.probs[0], 2) + '</td>' +
        '<td class="adv-only">' + fmtPct(d.probs[1], 2) + '</td>' +
        '<td class="adv-only">' + fmtPct(d.probs[2], 2) + '</td>' +
        '<td><div class="bar-cell">' + fmtPct(share, 2) + '<span class="bar-track"><span class="bar" style="width:' + Math.max(1, share * 90).toFixed(1) + 'px"></span></span></div></td>' +
        '<td class="adv-only">' + fmtNum(d.expectedCount, d.expectedCount < 10 ? 2 : 0) + '</td>' +
        '<td>' + fmtPct(d.pAtLeastOne, 2) + '</td></tr>';
    }).join('');
  }

  /* ================= Simulation ================= */

  /* Le profil réduit aux réglages qui influent sur le calcul (une tranche éditée en mode global ne compte pas). */
  function relevantProfile(p) {
    var u = p.uncertainty || {};
    return {
      cevMode: p.cevMode,
      cev: p.cev,
      tranches: p.cevMode === 'tranches' ? p.tranches : null,
      finishModel: p.finishModel,
      share2: p.finishModel === 'manual' ? p.share2 : null,
      uncertainty: u.enabled ? { nSample: u.nSample, sdMode: u.sdMode, sd: u.sdMode === 'manual' ? u.sd : null } : null
    };
  }

  /*
   * Tout ce qui influe sur un résultat de simulation affiché, pour détecter un résultat périmé.
   * Construit depuis la config réellement simulée (pas depuis l'état) : renommer la grille ne compte pas.
   */
  function simKey(cfg) {
    cfg = cfg || buildCfg();
    var sim = effSim();
    return JSON.stringify([cfg.rows, cfg.buyIn, cfg.stack, relevantProfile(cfg.profile), cfg.rbPerGame, cfg.games,
      cfg.checkpoints, cfg.jackpotMult, cfg.smoothJackpots, cfg.cevSe, sim.sims, sim.bankroll, sim.paths, sim.seed]);
  }

  function renderSimCost() {
    var games = num(effSim().games, 0), sims = Math.floor(num(effSim().sims, 0));
    var workers = SpinSim.workerCount(sims);
    $('sim-cost').textContent = games > 0 && sims > 0
      ? fmtInt(games * sims) + ' parties simulées au total, réparties sur ' + workers + ' worker' + (workers > 1 ? 's' : '') + '.'
      : '';
  }

  function parseSeed() {
    var seedValue = effSim().seed;
    var s = String(seedValue == null ? '' : seedValue).trim();
    if (s === '') return (Math.random() * 4294967296) >>> 0;
    var n = parseInt(s, 10);
    if (isFinite(n) && String(n) === s) return n >>> 0;
    /* graine texte : hachage FNV-1a */
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  function runSimulation() {
    if (running) return;
    var errs = validate().concat(validateSim());
    if (errs.length) { showErrors(errs); return; }
    /* tout ce que la simulation utilise est figé au lancement : les éditions faites pendant le calcul ne s'y mélangent pas */
    var cfg = buildCfg();
    var sim = effSim();
    var sims = Math.floor(num(sim.sims, 1));
    var bankroll = num(sim.bankroll, 0);
    var paths = Math.floor(num(sim.paths, 0));
    var gridName = state.grid.name;
    var seed = parseSeed();
    var key = simKey(cfg);
    var analysis = SpinModel.analyze(cfg);
    var t0 = performance.now();
    $('btn-run').disabled = true;
    $('btn-cancel').disabled = false;
    $('sim-status').textContent = 'Simulation en cours…';
    $('progress-bar').style.width = '0%';
    running = SpinSim.run(cfg, sims, seed, function (f) {
      $('progress-bar').style.width = (f * 100).toFixed(1) + '%';
    });
    running.promise.then(function (res) {
      /* le calcul est fini : l'agrégation ne peut plus être annulée */
      $('btn-cancel').disabled = true;
      $('sim-status').textContent = 'Agrégation…';
      return new Promise(function (resolve) { setTimeout(function () { resolve(res); }, 0); });
    }).then(function (res) {
      var summary = SpinModel.summarize(res.merged, {
        buyIn: cfg.buyIn, bankroll: bankroll, paths: paths, games: cfg.games
      });
      var dt = (performance.now() - t0) / 1000;
      lastSim = { summary: summary, analysis: analysis, cfg: cfg, key: key, seed: seed, seconds: dt, gridName: gridName, bankroll: bankroll };
      $('sim-status').textContent = 'Terminé en ' + fmtNum(dt, 1) + ' s · graine ' + seed +
        (res.workers ? ' · ' + res.workers + ' workers' : ' · thread principal' + (res.usedFallback ? ' (workers indisponibles)' : ''));
      $('progress-bar').style.width = '100%';
      renderSimResults();
    }).catch(function (err) {
      $('sim-status').textContent = err.message;
      $('progress-bar').style.width = '0%';
    }).then(function () {
      running = null;
      $('btn-run').disabled = false;
      $('btn-cancel').disabled = true;
    });
  }

  /* Oublie la dernière simulation : résultats et bandeau « périmé » disparaissent ensemble. */
  function clearSim() {
    lastSim = null;
    $('sim-results').hidden = true;
    $('sim-stale').hidden = true;
  }

  function renderSimResults() {
    if (!lastSim) { clearSim(); return; }
    var s = lastSim.summary;
    var a = lastSim.analysis;
    var cfg = lastSim.cfg;
    var b = cfg.buyIn;
    var N = cfg.games;
    var evTotal = a.ev * N;
    var br = lastSim.bankroll;
    $('sim-results').hidden = false;
    $('sim-stale').hidden = lastSim.key === simKey();

    var gap = evTotal !== 0 ? (s.meanFinal - evTotal) / Math.abs(evTotal) : 0;
    var html =
      kpi('Moyenne simulée', fmtSignedEur(s.meanFinal), 'EV théorique : ' + fmtSignedEur(evTotal) + ' (écart ' + fmtSignedPct(gap, 1) + ')', 'hero ' + signClass(s.meanFinal), true) +
      kpi('Résultat le plus probable (médiane)', fmtSignedEur(s.finals.p50), fmtNum(s.finals.p50 / b, 0) + ' buy-ins · 5 % : ' + fmtEur(s.finals.p5) + ' · 95 % : ' + fmtEur(s.finals.p95), signClass(s.finals.p50)) +
      kpi('P(finir perdant)', fmtPct(s.pLosing, 2), 'après ' + SpinCharts.fmtGames(N) + ' parties', s.pLosing > 0.2 ? 'neg' : '') +
      kpi('Pire downswing (médiane)', fmtEur(s.maxDD.p50), fmtNum(s.maxDD.p50 / b, 0) + ' BI · 95 % : ' + fmtEur(s.maxDD.p95) + ' (' + fmtNum(s.maxDD.p95 / b, 0) + ' BI)') +
      kpi('Breakeven stretch (médiane)', fmtInt(s.stretch.p50) + ' parties', '95 % : ' + fmtInt(s.stretch.p95) + ' parties sans nouveau record') +
      kpi('Risque de ruine', fmtPct(s.rorAtBankroll, 2), 'avec ' + fmtEur(br) + ' (' + fmtNum(br / b, 0) + ' BI), sans changer de limite', s.rorAtBankroll > 0.05 ? 'neg' : '') +
      kpi('Bankroll pour 5 % de ruine', fmtEur(s.bankrollFor.r5), fmtNum(s.bankrollFor.r5 / b, 0) + ' BI · 10 % : ' + fmtNum(s.bankrollFor.r10 / b, 0) + ' BI') +
      kpi('Bankroll pour 1 % de ruine', fmtEur(s.bankrollFor.r1), fmtNum(s.bankrollFor.r1 / b, 0) + ' BI') +
      kpi('Trajectoires avec ≥ 1 jackpot', fmtPct(s.pSimsWithJackpot, 2), 'théorique : ' + fmtPct(a.pAtLeastOneJackpot, 2) + (cfg.smoothJackpots ? ' · jackpots lissés' : ''), '', true);
    if (cfg.cevSe > 0) {
      html += kpi('Incertitude cEV', '±' + fmtNum(cfg.cevSe, 1) + ' jetons', 'écart-type des cEV tirés : ' + fmtNum(s.deltaSd, 1), '', true);
    }
    $('sim-kpis').innerHTML = html;

    var rows = [['1 %', 'p1'], ['5 %', 'p5'], ['10 %', 'p10'], ['25 %', 'p25'], ['50 %', 'p50'], ['75 %', 'p75'], ['90 %', 'p90'], ['95 %', 'p95'], ['99 %', 'p99']];
    $('sim-percentiles').innerHTML = '<thead><tr><th>Percentile</th><th>Résultat final</th><th>Pire downswing</th><th>Breakeven stretch</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + r[0] + '</td><td class="' + signClass(s.finals[r[1]]) + '">' + fmtSignedEur(s.finals[r[1]]) + '</td><td>' +
          fmtEur(s.maxDD[r[1]]) + ' <span class="muted">(' + fmtNum(s.maxDD[r[1]] / b, 0) + ' BI)</span></td><td>' + fmtInt(s.stretch[r[1]]) + '</td></tr>';
      }).join('') + '</tbody>';
    drawSimCharts();
  }

  function drawSimCharts() {
    if (!lastSim || $('sim-results').hidden || document.querySelector('[data-panel="sim"]').hidden) return;
    var s = lastSim.summary;
    var cfg = lastSim.cfg;
    var b = cfg.buyIn;
    var fy = function (v) { return fmtEur(v, Math.abs(v) >= 100 ? 0 : 2); };
    SpinCharts.bands('chart-bands', {
      xs: s.cpGames, bands: s.bands, meanPath: s.meanPath, evPerGame: lastSim.analysis.ev, paths: s.paths, fmtY: fy
    });
    SpinCharts.histogram('chart-finals', {
      sorted: s.finalsSorted, bins: 50, fmt: fy,
      markers: [{ value: lastSim.analysis.ev * cfg.games, label: 'EV' }, { value: 0, label: '0' }]
    });
    SpinCharts.histogram('chart-dd', {
      sorted: s.maxDDSorted, bins: 50, clipLo: 0, clipHi: 0.995, fmt: function (v) { return fmtNum(v / b, 0) + ' BI'; },
      markers: [{ value: s.maxDD.p95, label: '95 %' }]
    });
    var br = lastSim.bankroll;
    SpinCharts.curve('chart-ror', {
      points: s.rorCurve,
      fmtX: function (v) { return fmtEur(v, 0) + ' (' + fmtNum(v / b, 0) + ' BI)'; },
      fmtTickX: function (v) { return fmtNum(v / b, 0) + ' BI'; },
      fmtY: function (v) { return fmtPct(v, v < 0.1 ? 1 : 0); },
      yMax: 1,
      markers: [{ x: br, label: 'Ma bankroll' }]
    });
  }

  /* ================= Comparatif ================= */

  var COMPARE_COLS = [
    ['name', 'Scénario', function (s) { return esc(s.name); }],
    ['grid', 'Grille', function (s) { return esc(s.grid) + ' · ' + fmtEur(s.buyIn); }],
    ['cev', 'cEV', function (s) { return esc(s.cev); }],
    ['ev', 'EV / partie', function (s) { return fmtSignedEur(s.ev, 3); }],
    ['roi', 'ROI', function (s) { return fmtSignedPct(s.roi, 2); }],
    ['roiNoRb', 'ROI hors RB', function (s) { return fmtSignedPct(s.roiNoRb, 2); }],
    ['roiNoJackpot', 'ROI hors jackpots', function (s) { return fmtSignedPct(s.roiNoJackpot, 2); }],
    ['rake', 'Rake caché', function (s) { return fmtNum(s.rake, 2) + ' %'; }],
    ['games', 'Parties', function (s) { return fmtInt(s.games); }],
    ['pLosing', 'P(perdant)', function (s) { return fmtPct(s.pLosing, 1); }],
    ['median', 'Médiane', function (s) { return fmtSignedEur(s.median); }],
    ['dd50', 'DD médian (BI)', function (s) { return fmtNum(s.dd50, 0); }],
    ['dd95', 'DD 95 % (BI)', function (s) { return fmtNum(s.dd95, 0); }],
    ['stretch95', 'Stretch 95 %', function (s) { return fmtInt(s.stretch95); }],
    ['br5', 'BR 5 % (BI)', function (s) { return fmtNum(s.br5, 0); }],
    ['br1', 'BR 1 % (BI)', function (s) { return fmtNum(s.br1, 0); }]
  ];

  function addScenario() {
    if (!lastSim) return;
    var s = lastSim.summary, a = lastSim.analysis, cfg = lastSim.cfg, b = cfg.buyIn;
    var name = $('scenario-name').value.trim() || ('Scénario ' + (state.scenarios.length + 1));
    var cevDesc = cfg.profile.cevMode === 'tranches'
      /* même repli que le modèle : une tranche sans cEV prend le cEV de référence */
      ? cfg.profile.tranches.map(function (t) { return '≥×' + num(t.from, 0) + ' : ' + num(t.cev, num(cfg.profile.cev, 0)); }).join(' / ')
      : String(num(cfg.profile.cev, 0));
    state.scenarios.push({
      name: name,
      grid: lastSim.gridName,
      buyIn: b,
      cev: cevDesc,
      ev: a.ev,
      roi: a.roi,
      roiNoRb: a.roiWithoutRb,
      roiNoJackpot: a.roiNoJackpot,
      rake: SpinModel.tableStats(cfg.rows, b).hiddenRakePct,
      games: cfg.games,
      pLosing: s.pLosing,
      median: s.finals.p50,
      dd50: s.maxDD.p50 / b,
      dd95: s.maxDD.p95 / b,
      stretch95: s.stretch.p95,
      br5: s.bankrollFor.r5 / b,
      br1: s.bankrollFor.r1 / b
    });
    $('scenario-name').value = '';
    saveState();
    renderCompare();
    $('sim-status').textContent = 'Scénario « ' + name + ' » ajouté au comparatif.';
  }

  function renderCompare() {
    var list = state.scenarios;
    $('compare-empty').hidden = list.length > 0;
    $('compare-table').innerHTML = list.length
      ? '<thead><tr>' + COMPARE_COLS.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' +
        list.map(function (s, i) {
          return '<tr>' + COMPARE_COLS.map(function (c, j) { return '<td' + (j < 3 ? ' class="text"' : '') + '>' + c[2](s) + '</td>'; }).join('') +
            '<td><button type="button" class="btn icon ghost" data-del-scenario="' + i + '" title="Retirer">✕</button></td></tr>';
        }).join('') + '</tbody>'
      : '';
  }

  /* colonnes stockées en fraction, exportées en % comme le reste (rake) */
  var COMPARE_FRACTION_KEYS = { roi: 1, roiNoRb: 1, roiNoJackpot: 1, pLosing: 1 };

  /* Nombre pour Excel FR : 6 décimales max, sans bruit flottant ni notation 1e-7, virgule décimale. */
  function csvNumber(v) {
    if (!isFinite(v)) return '';
    var s = v.toFixed(6).replace(/\.?0+$/, '');
    if (s === '-0') s = '0';
    return s.replace('.', ',');
  }

  function csvText(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }

  function exportCompareCsv() {
    var head = COMPARE_COLS.map(function (c) { return c[1] + (COMPARE_FRACTION_KEYS[c[0]] || c[0] === 'rake' ? ' (%)' : ''); });
    /* le buy-in a sa propre colonne (l'écran l'affiche avec le nom de la grille) */
    head.splice(2, 0, 'Buy-in (€)');
    var lines = state.scenarios.map(function (s) {
      var cells = COMPARE_COLS.map(function (c) {
        var v = s[c[0]];
        if (typeof v === 'number') return csvNumber(COMPARE_FRACTION_KEYS[c[0]] ? v * 100 : v);
        return csvText(v);
      });
      cells.splice(2, 0, csvNumber(s.buyIn));
      return cells.join(';');
    });
    head = head.join(';');
    download('comparatif-spins.csv', '﻿' + [head].concat(lines).join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ================= Analyse de chance ================= */

  /* Ce qu'affiche la structure du tableau de chance : lignes valides, multiplicateur et prize pool. */
  var luckSignature = null;
  function luckRows() {
    var b = num(state.grid.buyIn, 0);
    return b > 0 ? SpinModel.normalizeRows(state.grid.rows, b).rows : [];
  }
  function signatureOf(rows) {
    return rows.map(function (r) { return r.index + ':' + r.pool + ':' + r.effMult; }).join('|');
  }

  function buildLuckTable() {
    var body = $('luck-body');
    var rows = luckRows();
    luckSignature = signatureOf(rows);
    body.innerHTML = rows.map(function (r) {
      return '<tr data-luck="' + r.index + '"><td>' + fmtMult(r.effMult) + '</td><td>' + fmtEur(r.pool) + '</td>' +
        '<td><input type="number" min="0" step="1" data-bind="luck.counts.' + r.index + '"></td>' +
        '<td data-d="exp"></td><td data-d="diff"></td><td data-d="tail"></td><td data-d="luck"></td></tr>';
    }).join('');
    fillBindings(body);
  }

  function updateLuck(errs, cfg) {
    if (errs.length) { $('luck-kpis').innerHTML = ''; return; }
    var res = SpinModel.luckAnalysis(cfg, state.luck.counts || {}, num(state.luck.actualNet, 0));
    var byIdx = {};
    res.detail.forEach(function (d) { byIdx[d.index] = d; });
    $('luck-body').querySelectorAll('tr').forEach(function (tr) {
      var d = byIdx[tr.dataset.luck];
      if (!d) return;
      var diff = d.actual - d.expected;
      tr.querySelector('[data-d="exp"]').textContent = fmtNum(d.expected, d.expected < 10 ? 2 : 0);
      var dc = tr.querySelector('[data-d="diff"]');
      dc.textContent = (diff > 0 ? '+' : '') + fmtNum(diff, Math.abs(diff) < 10 ? 2 : 0);
      tr.querySelector('[data-d="tail"]').textContent = res.games > 0 ? (diff >= 0 ? 'P(≥) ' : 'P(≤) ') + fmtPct(d.tail, 2) : '—';
      var lc = tr.querySelector('[data-d="luck"]');
      lc.textContent = fmtSignedEur(d.luck);
      lc.className = signClass(d.luck);
    });
    if (!res.games) { $('luck-kpis').innerHTML = ''; return; }
    var b = cfg.buyIn;
    $('luck-kpis').innerHTML =
      kpi('Parties saisies', fmtInt(res.games), '') +
      kpi('EV théorique (hors RB)', fmtSignedEur(res.evTheo), 'avec ton cEV, multiplicateurs moyens', signClass(res.evTheo)) +
      kpi('EV sachant tes multiplicateurs', fmtSignedEur(res.evGivenMultipliers), 'avec ton cEV, multiplicateurs réellement tirés', signClass(res.evGivenMultipliers)) +
      kpi('Résultat réel', fmtSignedEur(res.actual), '', signClass(res.actual)) +
      kpi('Chance multiplicateurs', fmtSignedEur(res.multiplierLuck), fmtNum(res.multiplierLuck / b, 1) + ' BI · z = ' + fmtNum(res.zMultiplier, 2) + ' (indicatif, distribution asymétrique)', 'hero ' + signClass(res.multiplierLuck)) +
      kpi('Chance places / all-in', fmtSignedEur(res.placeLuck), fmtNum(res.placeLuck / b, 1) + ' BI', signClass(res.placeLuck)) +
      kpi('Chance totale', fmtSignedEur(res.totalLuck), fmtNum(res.totalLuck / b, 1) + ' BI', signClass(res.totalLuck));
  }

  /* ================= Orchestration ================= */

  function showErrors(errs) {
    var box = $('global-errors');
    box.hidden = !errs.length;
    box.innerHTML = errs.length ? '<b>Paramètres invalides</b><ul>' + errs.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' : '';
  }

  function refreshAll() {
    var errs = validate();
    showErrors(errs);
    var gc = gridContext();
    var cfg = errs.length ? null : buildCfg();
    renderSidebarDerived();
    renderPresetInfo(gc);
    updateGridDerived();
    renderGridSummary(gc);
    renderAnalysis(errs, cfg, gc);
    /* structure du tableau de chance : reconstruite seulement si ses lignes changent */
    if (signatureOf(luckRows()) !== luckSignature) buildLuckTable();
    updateLuck(errs, cfg);
    renderSimCost();
    /* réutilise la config déjà construite pour ce rafraîchissement */
    $('sim-stale').hidden = !lastSim || lastSim.key === simKey(cfg || undefined);
    saveState();
  }

  function rebuildAll() {
    applyMode();
    renderPresetPicker();
    fillBindings(document);
    buildTranches();
    buildTiers();
    buildGridTable();
    buildLuckTable();
    updateVisibility();
    renderCompare();
    refreshAll();
  }

  function isObject(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }

  /* Fusionne une config importée avec les défauts et écarte tout ce qui casserait le rendu. Lève une erreur si inexploitable. */
  function sanitizeImportedState(data) {
    if (!isObject(data)) throw new Error('config invalide');
    var next = mergeDeep(clone(SPIN_DEFAULT_STATE), data);
    ['ui', 'profile', 'rb', 'sim', 'luck'].forEach(function (k) {
      if (!isObject(next[k])) next[k] = clone(SPIN_DEFAULT_STATE[k]);
    });
    if (next.ui.mode !== 'expert') next.ui.mode = 'simple';
    if (!isObject(next.luck.counts)) next.luck.counts = {};
    if (!Array.isArray(next.profile.tranches)) next.profile.tranches = clone(SPIN_DEFAULT_STATE.profile.tranches);
    if (!isObject(next.profile.uncertainty)) next.profile.uncertainty = clone(SPIN_DEFAULT_STATE.profile.uncertainty);
    if (!Array.isArray(next.rb.tiers)) next.rb.tiers = clone(SPIN_DEFAULT_STATE.rb.tiers);
    next.profile.tranches = next.profile.tranches.filter(isObject);
    next.rb.tiers = next.rb.tiers.filter(isObject);
    next.scenarios = Array.isArray(next.scenarios) ? next.scenarios.filter(isObject) : [];
    /*
     * Les presets importés sont toujours des grilles perso : jamais de statut « intégré » ni de source affichée.
     * Un id déjà pris (grille intégrée ou doublon) est renommé, sinon findPreset renverrait la mauvaise grille.
     */
    var taken = {};
    SPIN_PRESETS.forEach(function (p) { taken[p.id] = true; });
    var renamed = {};
    next.userPresets = (Array.isArray(next.userPresets) ? next.userPresets : []).filter(function (p) {
      return isObject(p) && typeof p.id === 'string' && Array.isArray(p.rows);
    }).map(function (p, i) {
      var id = p.id;
      if (taken[id] || id.indexOf('u-') !== 0) {
        id = 'u-import-' + Date.now() + '-' + i;
        if (!(p.id in renamed)) renamed[p.id] = id;
      }
      taken[id] = true;
      return { id: id, name: String(p.name || 'Grille'), builtin: false, buyIn: p.buyIn, stack: p.stack, feePct: p.feePct,
        rows: p.rows.filter(isObject) };
    });
    /* la grille sélectionnée suit son preset renommé, sauf si l'id désignait une grille intégrée */
    if (next.presetId in renamed && !findPresetIn(SPIN_PRESETS, next.presetId)) next.presetId = renamed[next.presetId];
    if (!isObject(next.grid) || !Array.isArray(next.grid.rows)) {
      /* pas de grille : celle du preset désigné par la config importée (comme au chargement), sinon le défaut */
      var wanted = findPresetIn(SPIN_PRESETS.concat(next.userPresets), next.presetId);
      if (!wanted) next.presetId = SPIN_DEFAULT_STATE.presetId;
      next.grid = gridFromPreset(wanted || findPresetIn(SPIN_PRESETS, SPIN_DEFAULT_STATE.presetId) || SPIN_PRESETS[0]);
    }
    next.grid.rows = next.grid.rows.filter(isObject);
    next.grid.name = String(next.grid.name == null ? 'Grille' : next.grid.name);
    return next;
  }

  /* Ré-indexe les comptages de l'analyse de chance après un déplacement de lignes (map : ancien → nouvel index, −1 = supprimé). */
  function remapLuckCounts(map) {
    var next = {};
    Object.keys(state.luck.counts || {}).forEach(function (k) {
      var to = map(+k);
      if (to != null && to >= 0) next[to] = state.luck.counts[k];
    });
    state.luck.counts = next;
  }

  function loadPreset(id) {
    var p = findPreset(id);
    if (!p) return;
    state.presetId = id;
    state.grid = gridFromPreset(p);
    state.luck.counts = {};
    rebuildAll();
  }

  function saveAsPreset() {
    var name = prompt('Nom de la grille :', state.grid.name || 'Ma grille');
    if (!name) return;
    var existing = state.userPresets.filter(function (p) { return p.name === name; })[0];
    if (existing && !confirm('Une grille « ' + name + ' » existe déjà dans « Mes grilles ». La remplacer ?')) return;
    var data = { id: existing ? existing.id : 'u-' + Date.now(), name: name, builtin: false,
      buyIn: state.grid.buyIn, stack: state.grid.stack, feePct: state.grid.feePct, rows: clone(state.grid.rows) };
    if (existing) state.userPresets[state.userPresets.indexOf(existing)] = data;
    else state.userPresets.push(data);
    state.grid.name = name;
    state.presetId = data.id;
    rebuildAll();
  }

  function deletePreset() {
    var id = state.presetId;
    var p = findPreset(id);
    if (!p || p.builtin) { alert('Sélectionne d\'abord une grille de « Mes grilles » : les grilles intégrées ne peuvent pas être supprimées.'); return; }
    if (!confirm('Supprimer la grille « ' + p.name + ' » de « Mes grilles » ?')) return;
    state.userPresets = state.userPresets.filter(function (x) { return x.id !== id; });
    /* la grille reste chargée, simplement détachée de tout preset */
    state.presetId = null;
    renderPresetPicker();
    saveState();
  }

  /*
   * Nombre écrit à la française ou à l'anglaise : « 1 000 000 », « 1.000.000 », « 1,000,000 », « 0,5 », « 1.234,5 ».
   * Un séparateur répété est un séparateur de milliers ; avec « . » et « , » mêlés, le dernier est la décimale.
   * thousandsFirst (colonnes entières : fréquence, prix) : un séparateur unique suivi de 3 chiffres
   * est un séparateur de milliers (« 482,874 » → 482874).
   */
  function parseLocaleNumber(s, thousandsFirst) {
    s = String(s).replace(/[×x€%\s  ]/gi, '');
    var dots = (s.match(/\./g) || []).length;
    var commas = (s.match(/,/g) || []).length;
    if (dots && commas) {
      var dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
    } else if (commas > 1) {
      s = s.split(',').join('');
    } else if (dots > 1) {
      s = s.split('.').join('');
    } else if (thousandsFirst && /^-?[1-9]\d{0,2}[.,]\d{3}$/.test(s)) {
      s = s.replace(/[.,]/, '');
    } else {
      s = s.replace(',', '.');
    }
    return s === '' ? NaN : Number(s);
  }

  /* Champ numérique d'un JSON importé : nombre tel quel, ou texte lu comme dans le CSV (« 750 000 », « 1,5 »). */
  function jsonNumber(v, fallback, thousandsFirst) {
    if (typeof v === 'number') return isFinite(v) ? v : fallback;
    if (v == null || v === '') return fallback;
    var n = parseLocaleNumber(v, thousandsFirst);
    return isFinite(n) ? n : fallback;
  }

  /* CSV : multiplicateur;fréquence;%1er;%2e;%3e;prix_fixe — séparé par « ; » ou tabulation (« , » seulement sinon). */
  function parseCsv(text) {
    var rows = [];
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var sep = line.indexOf(';') >= 0 ? ';' : line.indexOf('\t') >= 0 ? '\t' : ',';
      /* colonnes multiplicateur, fréquence et prix fixe : « 1,000 » = mille ; les % gardent « 2,5 » = 2,5 */
      var parts = line.split(sep).map(function (s, col) { return parseLocaleNumber(s, col <= 1 || col === 5); });
      var mult = parts[0];
      var weight = parts[1];
      if (!isFinite(mult) || !isFinite(weight)) return;
      rows.push({
        mult: mult,
        weight: weight,
        s1: num(parts[2], 100),
        s2: num(parts[3], 0),
        s3: num(parts[4], 0),
        prize: num(parts[5], 0)
      });
    });
    return rows;
  }

  function importGrid(text, filename) {
    var rows = null, meta = {};
    try {
      var data = JSON.parse(text);
      if (Array.isArray(data)) rows = data;
      else if (data && Array.isArray(data.rows)) { rows = data.rows; meta = data; }
    } catch (e) {
      rows = parseCsv(text);
    }
    /* seules les lignes objets avec une fréquence sont gardées (un JSON [2, 3] ou [null] n'est pas une grille) */
    rows = (rows || []).filter(function (r) { return isObject(r) && isFinite(jsonNumber(r.weight, NaN, true)); });
    if (!rows.length) { alert('Aucune ligne reconnue dans ' + filename + '.'); return; }
    state.grid = {
      name: meta.name != null && meta.name !== '' ? String(meta.name) : filename.replace(/\.[^.]+$/, ''),
      buyIn: meta.buyIn != null ? meta.buyIn : state.grid.buyIn,
      stack: meta.stack != null ? meta.stack : state.grid.stack,
      feePct: meta.feePct != null ? meta.feePct : state.grid.feePct,
      rows: rows.map(function (r) {
        return {
          mult: jsonNumber(r.mult, 0, true), prize: jsonNumber(r.prize, 0, true), weight: jsonNumber(r.weight, 0, true),
          s1: jsonNumber(r.s1, 100), s2: jsonNumber(r.s2, 0), s3: jsonNumber(r.s3, 0)
        };
      })
    };
    state.presetId = null;
    state.luck.counts = {};
    rebuildAll();
  }

  function applyTheme() {
    var t;
    try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { t = 'auto'; }
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('btn-theme').textContent = 'Thème : ' + { auto: 'auto', light: 'clair', dark: 'sombre' }[t];
    SpinCharts.redrawAll();
  }

  function cycleTheme() {
    var t;
    try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { t = 'auto'; }
    try { localStorage.setItem(THEME_KEY, { auto: 'light', light: 'dark', dark: 'auto' }[t] || 'auto'); } catch (e) { /* ignoré */ }
    applyTheme();
  }

  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    if (name === 'sim') drawSimCharts();
  }

  function onClick(e) {
    var t = e.target.closest('button');
    if (!t) return;
    var d = t.dataset;
    if (d.tab) { showTab(d.tab); return; }
    if (d.mode) {
      if (state.ui.mode === d.mode) return;
      state.ui.mode = d.mode;
      applyMode();
      updateVisibility();
      refreshAll();
      if (lastSim) renderSimResults();
      return;
    }
    if (d.delRow != null) {
      var del = +d.delRow;
      state.grid.rows.splice(del, 1);
      /* les comptages de chance suivent leurs lignes : on retire celui de la ligne supprimée et on décale les suivants */
      remapLuckCounts(function (i) { return i === del ? -1 : (i > del ? i - 1 : i); });
      buildGridTable(); buildLuckTable(); refreshAll(); return;
    }
    if (d.delTranche != null) { state.profile.tranches.splice(+d.delTranche, 1); buildTranches(); refreshAll(); return; }
    if (d.delTier != null) { state.rb.tiers.splice(+d.delTier, 1); buildTiers(); refreshAll(); return; }
    if (d.delScenario != null) { state.scenarios.splice(+d.delScenario, 1); renderCompare(); saveState(); return; }

    switch (t.id) {
      case 'btn-add-row':
        state.grid.rows.push({ mult: 2, prize: 0, weight: 0, s1: 100, s2: 0, s3: 0 });
        buildGridTable(); refreshAll(); break;
      case 'btn-sort-rows':
        var b = num(state.grid.buyIn, 1) || 1;
        var order = state.grid.rows.map(function (r, i) { return i; });
        order.sort(function (x, y) { return SpinModel.rowMult(state.grid.rows[x], b) - SpinModel.rowMult(state.grid.rows[y], b); });
        var newIndex = [];
        order.forEach(function (oldIdx, newIdx) { newIndex[oldIdx] = newIdx; });
        state.grid.rows = order.map(function (i) { return state.grid.rows[i]; });
        remapLuckCounts(function (i) { return newIndex[i]; });
        buildGridTable(); buildLuckTable(); refreshAll(); break;
      case 'btn-add-tranche':
        var last = state.profile.tranches[state.profile.tranches.length - 1];
        state.profile.tranches.push({ from: last ? num(last.from, 0) * 10 || 10 : 0, cev: num(state.profile.cev, 0) });
        buildTranches(); refreshAll(); break;
      case 'btn-add-tier':
        var lt = state.rb.tiers[state.rb.tiers.length - 1];
        state.rb.tiers.push({ minGames: lt ? num(lt.minGames, 0) + 1000 : 0, pct: lt ? num(lt.pct, 0) + 5 : 10 });
        buildTiers(); refreshAll(); break;
      case 'btn-save-preset': saveAsPreset(); break;
      case 'btn-delete-preset': deletePreset(); break;
      case 'btn-export-grid':
        download(String(state.grid.name || 'grille').replace(/[^\w\-]+/g, '_') + '.json', JSON.stringify(state.grid, null, 2));
        break;
      case 'btn-paste-csv': $('csv-box').hidden = false; $('csv-text').focus(); break;
      case 'btn-cancel-csv': $('csv-box').hidden = true; break;
      case 'btn-apply-csv':
        var rows = parseCsv($('csv-text').value);
        if (!rows.length) { alert('Aucune ligne reconnue.'); break; }
        state.grid.rows = rows;
        state.presetId = null;
        state.luck.counts = {};
        $('csv-box').hidden = true;
        rebuildAll(); break;
      case 'btn-run': runSimulation(); break;
      case 'btn-cancel': if (running) running.cancel(); break;
      case 'btn-add-scenario': addScenario(); break;
      case 'btn-export-compare': if (state.scenarios.length) exportCompareCsv(); break;
      case 'btn-clear-compare':
        if (state.scenarios.length && confirm('Effacer tous les scénarios ?')) { state.scenarios = []; renderCompare(); saveState(); }
        break;
      case 'btn-export-all': download('spin-variance-lab-config.json', JSON.stringify(state, null, 2)); break;
      case 'btn-reset':
        if (confirm('Revenir aux réglages par défaut ? « Mes grilles » et ton comparatif sont conservés.')) {
          var keep = { userPresets: state.userPresets, scenarios: state.scenarios, ui: state.ui };
          state = clone(SPIN_DEFAULT_STATE);
          state.userPresets = keep.userPresets;
          state.scenarios = keep.scenarios;
          state.ui = keep.ui;
          state.grid = gridFromPreset(defaultPreset());
          clearSim();
          rebuildAll();
        }
        break;
      case 'btn-theme': cycleTheme(); break;
    }
  }

  function init() {
    loadState();
    applyTheme();
    /* 'input' est aussi émis par les cases à cocher, radios et selects */
    document.addEventListener('input', onBoundInput);
    document.addEventListener('click', onClick);
    window.addEventListener('pagehide', flushSave);
    window.addEventListener('beforeunload', flushSave);
    $('room-select').addEventListener('change', onRoomChange);
    $('buyin-select').addEventListener('change', function () { loadPreset(this.value); });
    $('file-import-grid').addEventListener('change', function () { readFile(this, importGrid); });
    $('file-import-all').addEventListener('change', function () {
      readFile(this, function (text) {
        var previous = state;
        try {
          state = sanitizeImportedState(JSON.parse(text));
          rebuildAll();
          /* l'ancienne simulation n'est oubliée qu'une fois la nouvelle config affichée sans erreur */
          clearSim();
        } catch (e) {
          /* fichier rejeté : on revient exactement à l'état d'avant */
          state = previous;
          rebuildAll();
          alert('Fichier de configuration invalide : rien n\'a été modifié.');
        }
      });
    });
    rebuildAll();
  }

  init();
})();
