/* Tests du moteur : node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SpinModel: M } = require('../js/model.js');

const EXAMPLE = [
  { mult: 2, weight: 750000, s1: 100, s2: 0, s3: 0 },
  { mult: 3, weight: 180000, s1: 100, s2: 0, s3: 0 },
  { mult: 5, weight: 50000, s1: 100, s2: 0, s3: 0 },
  { mult: 10, weight: 15000, s1: 100, s2: 0, s3: 0 },
  { mult: 25, weight: 4000, s1: 100, s2: 0, s3: 0 },
  { mult: 100, weight: 890, s1: 80, s2: 12, s3: 8 },
  { mult: 1000, weight: 100, s1: 80, s2: 12, s3: 8 },
  { mult: 10000, weight: 10, s1: 80, s2: 12, s3: 8 }
];

function cfg(over) {
  return Object.assign({
    rows: EXAMPLE,
    buyIn: 5,
    stack: 500,
    profile: { cevMode: 'global', cev: 0, finishModel: 'harville', share2: 50, uncertainty: { enabled: false } },
    rbPerGame: 0,
    games: 1000,
    checkpoints: 50,
    jackpotMult: 100,
    smoothJackpots: false,
    cevSe: 0
  }, over);
}

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} ≉ ${b} (±${tol})`);

test('rake caché = 1 − E[m]/3', () => {
  const st = M.tableStats(EXAMPLE, 5);
  close(st.expectedMult, 2.829, 1e-12);
  close(st.hiddenRakePct, (1 - 2.829 / 3) * 100, 1e-9);
  close(st.hiddenRakePerPlayer, 5 - 2.829 * 5 / 3, 1e-9);
  assert.equal(st.splitIssues.length, 0);
});

test('rake effectif = rake sachant qu\'aucun jackpot ne tombe', () => {
  const st = M.tableStats(EXAMPLE, 5, 100);
  /* sans les lignes ≥ ×100 : E[m] = (2·750000 + 3·180000 + 5·50000 + 10·15000 + 25·4000) / 999000 */
  const em = (1500000 + 540000 + 250000 + 150000 + 100000) / 999000;
  close(st.effectiveRakePct, (1 - em / 3) * 100, 1e-9);
  assert.ok(st.effectiveRakePct > st.hiddenRakePct);
  close(st.jackpotProbability, 1000 / 1e6, 1e-12);
  /* sans seuil : rake effectif = rake réel */
  close(M.tableStats(EXAMPLE, 5).effectiveRakePct, st.hiddenRakePct, 1e-9);
});

test('multiplicateur exact et seuil jackpot tolérant aux arrondis', () => {
  /* (3 × 0,2) / 0,2 = 3,0000000000000004 en flottant : le multiplicateur saisi doit rester exact */
  assert.equal(M.normalizeRows([{ mult: 3, weight: 1 }], 0.2).rows[0].effMult, 3);
  /* prix fixe : 1100 / 1,1 = 999,9999999999999 doit compter comme un ×1000 */
  const rows = [{ mult: 2, weight: 9 }, { prize: 1100, weight: 1, s1: 100 }];
  const st = M.tableStats(rows, 1.1, 1000);
  close(st.jackpotProbability, 0.1, 1e-12);
  const a = M.analyze(cfg({ rows, buyIn: 1.1, jackpotMult: 1000 }));
  assert.equal(a.detail[1].isJackpot, true);
});

test('break-even trouvé même avec une tranche à cEV très élevé', () => {
  const profile = { cevMode: 'tranches', cev: 0, finishModel: 'harville', tranches: [{ from: 0, cev: -100 }, { from: 100, cev: 1300 }] };
  const c = cfg({ profile });
  const d = M.breakEvenDelta(c);
  assert.ok(d !== null, 'doit trouver un break-even');
  close(M.evPerGame(c, d), 0, 1e-9);
});

test('points de contrôle : pas de débordement au-delà de 2^31 parties', () => {
  const games = 3e9;
  const cp = M.checkpointGames(games, 200);
  assert.equal(cp[199], games, 'dernier point = dernière partie');
  assert.equal(cp[200], games + 1, 'sentinelle au-delà de la dernière partie');
  for (let i = 1; i < 200; i++) assert.ok(cp[i] > cp[i - 1] && cp[i] > 0, `point ${i} croissant et positif`);
  /* cohérence sur une vraie petite simulation */
  const rows = [{ mult: 2, weight: 1, s1: 100 }];
  const r = M.simulateBatch(cfg({ rows, games: 10, checkpoints: 10, profile: { cevMode: 'global', cev: 1000 } }), 1, 1);
  assert.deepEqual(r.cpGames, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  close(r.cps[9], 50, 1e-6);
});

test('prix fixe prioritaire sur le multiplicateur', () => {
  assert.equal(M.rowPool({ mult: 2, prize: 1000 }, 5), 1000);
  assert.equal(M.rowPool({ mult: 2, prize: 0 }, 5), 10);
});

test('P(1er) par conservation des jetons', () => {
  close(M.winProb(0, 500), 1 / 3, 1e-15);
  close(M.winProb(30, 500), 530 / 1500, 1e-15);
  assert.equal(M.winProb(-600, 500), 0);
  assert.equal(M.winProb(5000, 500), 1);
});

test('Harville : neutre = 1/3 partout, somme = 1', () => {
  const p = M.placeProbs(1 / 3, 'harville');
  p.forEach(x => close(x, 1 / 3, 1e-12));
  for (const x of [0, 0.1, 0.4, 0.7, 1]) {
    const q = M.placeProbs(x, 'harville');
    close(q[0] + q[1] + q[2], 1, 1e-12);
    assert.ok(q.every(v => v >= 0));
  }
  const m = M.placeProbs(0.4, 'manual', 70);
  close(m[1], 0.6 * 0.7, 1e-12);
});

test('cEV nul sans rakeback : EV = −rake caché par joueur', () => {
  const a = M.analyze(cfg());
  close(a.ev, -M.tableStats(EXAMPLE, 5).hiddenRakePerPlayer, 1e-9);
});

test('EV hors jackpots = espérance conditionnelle (aucun jackpot tiré)', () => {
  const rows = [{ mult: 2, weight: 1, s1: 100 }, { mult: 100, weight: 1, s1: 100 }];
  const a = M.analyze(cfg({ rows, jackpotMult: 100, rbPerGame: 0.1 }));
  /* sans jackpot, il ne reste que des ×2 : prix moyen = 10 € × 1/3 */
  close(a.evNoJackpot, 10 / 3 - 5 + 0.1, 1e-9);
});

test('cEV par tranche', () => {
  const profile = { cevMode: 'tranches', cev: 0, tranches: [{ from: 0, cev: 10 }, { from: 100, cev: 50 }] };
  assert.equal(M.cevForMult(profile, 2), 10);
  assert.equal(M.cevForMult(profile, 99.99), 10);
  assert.equal(M.cevForMult(profile, 100), 50);
  assert.equal(M.cevForMult(profile, 10000), 50);
});

test('break-even : EV(δ) ≈ 0', () => {
  const c = cfg({ rbPerGame: 0.1 });
  const d = M.breakEvenDelta(c);
  assert.ok(d !== null);
  close(M.evPerGame(c, d), 0, 1e-9);
});

test('rakeback : %, fixe, paliers, bonus', () => {
  close(M.rakebackPerGame({ mode: 'pct', pct: 20, feeMode: 'grid' }, 5, 7).total, 5 * 0.07 * 0.2, 1e-12);
  close(M.rakebackPerGame({ mode: 'fixed', fixedEur: 0.05, extraEur: 0.01 }, 5, 7).total, 0.06, 1e-12);
  const tiers = [{ minGames: 0, pct: 10 }, { minGames: 1500, pct: 20 }, { minGames: 4000, pct: 30 }];
  close(M.rakebackPerGame({ mode: 'tiers', tiers, monthlyVolume: 3000, feeMode: 'eur', feeEur: 0.35 }, 5, 7).total, 0.07, 1e-12);
  assert.equal(M.rakebackPerGame({ mode: 'none' }, 5, 7).total, 0);
});

test('alias : fréquences tirées conformes', () => {
  const probs = [0.5, 0.3, 0.15, 0.05];
  const al = M.buildAlias(probs);
  const rng = M.makeRng(42);
  const counts = [0, 0, 0, 0];
  const n = 400000;
  for (let i = 0; i < n; i++) {
    const x = rng() * probs.length;
    let idx = x | 0;
    if (x - idx >= al.prob[idx]) idx = al.alias[idx];
    counts[idx]++;
  }
  probs.forEach((p, i) => close(counts[i] / n, p, 0.004, `ligne ${i}`));
});

test('simulation : moyenne ≈ EV théorique (grille sans jackpot rare)', () => {
  const rows = EXAMPLE.slice(0, 5);
  const c = cfg({ rows, games: 2000, profile: { cevMode: 'global', cev: 40, finishModel: 'harville' }, rbPerGame: 0.07 });
  const a = M.analyze(c);
  const r = M.simulateBatch(c, 1500, 7);
  const mean = r.finals.reduce((s, x) => s + x, 0) / r.count;
  const se = a.sd * Math.sqrt(c.games) / Math.sqrt(r.count);
  close(mean, a.ev * c.games, 4 * se, 'moyenne simulée');
});

test('simulation : cas déterministes (toujours gagner / toujours perdre)', () => {
  const rows = [{ mult: 2, weight: 1, s1: 100, s2: 0, s3: 0 }];
  const win = M.simulateBatch(cfg({ rows, games: 100, profile: { cevMode: 'global', cev: 1000 } }), 3, 1);
  for (let s = 0; s < 3; s++) {
    close(win.finals[s], 100 * 5, 1e-9);
    assert.equal(win.maxDD[s], 0);
    assert.equal(win.stretch[s], 0);
    assert.equal(win.minCum[s], 0);
  }
  const lose = M.simulateBatch(cfg({ rows, games: 100, profile: { cevMode: 'global', cev: -500 } }), 2, 1);
  close(lose.finals[0], -500, 1e-9);
  close(lose.maxDD[0], 500, 1e-9);
  assert.equal(lose.stretch[0], 100);
  close(lose.minCum[0], -500, 1e-9);
  /* dernier point de contrôle = résultat final */
  close(lose.cps[lose.checkpoints - 1], -500, 1e-6);

  const sum = M.summarize(M.mergeBatches([lose]), { buyIn: 5, bankroll: 504, paths: 1, games: 100 });
  assert.equal(sum.rorAtBankroll, 1, 'besoin 505 € > 504 €');
  const sum2 = M.summarize(M.mergeBatches([lose]), { buyIn: 5, bankroll: 505, paths: 1, games: 100 });
  assert.equal(sum2.rorAtBankroll, 0, 'besoin 505 € ≤ 505 €');
  assert.equal(sum.pLosing, 1);
});

test('lissage des jackpots : jamais de jackpot tiré, EV des jackpots répartie sur chaque partie', () => {
  const rows = [{ mult: 2, weight: 1, s1: 100 }, { mult: 100, weight: 1, s1: 80, s2: 12, s3: 8 }];
  const base = { rows, games: 1, checkpoints: 1, jackpotMult: 100, profile: { cevMode: 'global', cev: 0, finishModel: 'harville' } };
  const c = cfg(base);
  const out = M.rowOutcomes(c, 0);
  const ev = M.evPerGame(c, 0);
  /* décalage = EV totale − EV des parties ×2 seules */
  const shift = ev - out[0].expProfit;
  const key = v => v.toFixed(6);
  const smooth = M.simulateBatch(cfg(Object.assign({ smoothJackpots: true }, base)), 6000, 5);
  const values = new Set(Array.from(smooth.finals, key));
  assert.deepEqual([...values].sort(), [key(5 + shift), key(-5 + shift)].sort(), 'seuls les résultats du ×2, décalés');
  assert.equal(smooth.simsWithJackpot, 0);
  const mean = smooth.finals.reduce((s, x) => s + x, 0) / smooth.count;
  close(mean, ev, 0.5, 'EV conservée');
  /* sans lissage, les vrais prix 1er/2e/3e du jackpot sortent */
  const raw = new Set(Array.from(M.simulateBatch(cfg(Object.assign({ smoothJackpots: false }, base)), 3000, 5).finals, key));
  assert.ok(raw.has(key(400 - 5)) && raw.has(key(60 - 5)) && raw.has(key(40 - 5)));
});

test('lissage des jackpots : variance fortement réduite sur la grille d\'exemple', () => {
  const base = { games: 2000, jackpotMult: 100, profile: { cevMode: 'global', cev: 25, finishModel: 'harville' } };
  const sd = arr => { const m = arr.reduce((s, x) => s + x, 0) / arr.length; return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); };
  const raw = sd(Array.from(M.simulateBatch(cfg(Object.assign({ smoothJackpots: false }, base)), 400, 9).finals));
  const smooth = sd(Array.from(M.simulateBatch(cfg(Object.assign({ smoothJackpots: true }, base)), 400, 9).finals));
  assert.ok(smooth < raw * 0.5, `écart-type lissé ${smooth.toFixed(0)} vs brut ${raw.toFixed(0)}`);
});

test('graine : résultat indépendant du découpage en lots', () => {
  const c = cfg({ games: 300, cevSe: 5 });
  const whole = M.simulateBatch(c, 12, 99);
  const parts = M.mergeBatches([M.simulateBatch(c, 5, 99, null, 0), M.simulateBatch(c, 7, 99, null, 5)]);
  assert.deepEqual(Array.from(parts.finals), Array.from(whole.finals));
  assert.deepEqual(Array.from(parts.deltas), Array.from(whole.deltas));
});

/* une régression (boucle jusqu'à n = 1e12) ferait dépasser le délai au lieu de dépendre de la vitesse de la machine */
test('queue binomiale : pas de boucle sur n quand les termes sont nuls', { timeout: 5000 }, () => {
  const v = M.binomTail(500, 1e12, 1e-14);
  assert.ok(v >= 0 && v < 1e-100);
});

test('incertitude cEV : écart-type des cEV tirés ≈ erreur standard', () => {
  const c = cfg({ rows: EXAMPLE.slice(0, 2), games: 10, cevSe: 7 });
  const r = M.simulateBatch(c, 20000, 11);
  const m = r.deltas.reduce((s, x) => s + x, 0) / r.count;
  const v = r.deltas.reduce((s, x) => s + (x - m) ** 2, 0) / (r.count - 1);
  close(Math.sqrt(v), 7, 0.15);
});

test('erreur standard auto du cEV', () => {
  const se = M.cevStdError({ cev: 0, uncertainty: { enabled: true, nSample: 10000, sdMode: 'auto' } }, 500);
  close(se, 1500 * Math.sqrt(2 / 9) / 100, 1e-9);
  assert.equal(M.cevStdError({ cev: 0, uncertainty: { enabled: false, nSample: 10000 } }, 500), 0);
});

test('analyse de chance : multiplicateurs conformes ⇒ chance multiplicateurs nulle', () => {
  const rows = [{ mult: 2, weight: 3, s1: 100 }, { mult: 10, weight: 1, s1: 100 }];
  const c = cfg({ rows, profile: { cevMode: 'global', cev: 0, finishModel: 'harville' } });
  const res = M.luckAnalysis(c, { 0: 300, 1: 100 }, 0);
  assert.equal(res.games, 400);
  close(res.multiplierLuck, 0, 1e-9);
  close(res.totalLuck, -res.evTheo, 1e-9);
  const lucky = M.luckAnalysis(c, { 0: 290, 1: 110 }, 0);
  assert.ok(lucky.multiplierLuck > 0);
});

test('queue binomiale', () => {
  /* P(X ≥ 3) pour Bin(10, 0.1) = 1 − P(0) − P(1) − P(2) */
  const p0 = 0.9 ** 10, p1 = 10 * 0.1 * 0.9 ** 9, p2 = 45 * 0.01 * 0.9 ** 8;
  close(M.binomTail(3, 10, 0.1), 1 - p0 - p1 - p2, 1e-9);
  close(M.binomTail(0, 10, 0.1), p0, 1e-9);
});

test('grilles officielles : rake implicite = rake annoncé, partages à 100 %', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/presets.js'), 'utf8') + ';this.P = SPIN_PRESETS;', ctx);
  const official = ctx.P.filter(p => p.source);
  assert.ok(official.length >= 25);
  for (const p of official) {
    const st = M.tableStats(p.rows, p.buyIn);
    assert.equal(st.splitIssues.length, 0, p.id);
    /* PMU 0,25 € : tableau publié incohérent (99 %), signalé dans la note */
    if (p.id === 'pmu-0_25') { assert.ok(p.note); continue; }
    close(st.hiddenRakePct, p.feePct, 1e-6, p.id);
  }
});

test('quantiles par sélection = quantiles par tri complet', () => {
  const rng = M.makeRng(3);
  for (const n of [1, 2, 5, 1000, 4097]) {
    const data = Float64Array.from({ length: n }, () => Math.round((rng() - 0.5) * 2000) / 10);
    const sorted = Float64Array.from(data).sort();
    const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
    const got = M.quantilesInPlace(Float64Array.from(data), qs);
    qs.forEach((q, i) => close(got[i], M.quantile(sorted, q), 1e-9, `n=${n} q=${q}`));
  }
});

test('EV sans jackpot indéfinie quand toutes les lignes sont des jackpots', () => {
  const a = M.analyze(cfg({ jackpotMult: 0 }));
  assert.ok(Number.isNaN(a.evNoJackpot));
});

test('queue normale précise pour les écarts extrêmes', () => {
  /* Bin(1e6, 0.5) : var = 250000 > 400 → approximation normale ; k = mu + 6σ → Q ≈ 1e-9 */
  const t = M.binomTail(500000 + 3000, 1e6, 0.5);
  assert.ok(t > 5e-10 && t < 2e-9, `queue 6σ ≈ 1e-9, obtenu ${t}`);
  close(M.binomTail(500000, 1e6, 0.5) + M.binomTail(499999, 1e6, 0.5), 1, 1e-6);
});

test('quantile interpolé', () => {
  const s = Float64Array.from([0, 10, 20, 30]);
  assert.equal(M.quantile(s, 0), 0);
  assert.equal(M.quantile(s, 1), 30);
  close(M.quantile(s, 0.5), 15, 1e-12);
});
