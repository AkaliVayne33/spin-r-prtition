/*
 * Moteur de calcul Spin & Go / Expresso / Twister (formats jackpot à 3 joueurs).
 *
 * Tout le code est dans une factory sans dépendance externe : la même source est
 * injectée telle quelle dans les Web Workers (via Function.prototype.toString),
 * utilisée dans la page, et importée par les tests Node.
 *
 * Conventions :
 *   - buyIn  : buy-in total payé par joueur (fee comprise), en €.
 *   - stack  : tapis de départ en jetons.
 *   - row    : { mult, prize, weight, s1, s2, s3 }
 *       mult   multiplicateur du buy-in (prize pool = mult × buyIn)
 *       prize  prize pool fixe en € (prioritaire sur mult si > 0)
 *       weight fréquence relative (ex. nombre d'occurrences sur 1 000 000)
 *       s1..s3 part du prize pool pour le 1er / 2e / 3e, en %
 *   - profit d'une partie = prix gagné − buyIn + rakeback.
 */
function spinModelFactory() {
  'use strict';

  var PLAYERS = 3;

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }

  /* ---------- Grille de multiplicateurs ---------- */

  function rowPool(row, buyIn) {
    var prize = num(row.prize, 0);
    return prize > 0 ? prize : num(row.mult, 0) * buyIn;
  }

  /* Multiplicateur d'une ligne : saisi tel quel (exact) ; recalculé seulement pour un prix fixe. */
  function rowMult(row, buyIn) {
    var prize = num(row.prize, 0);
    return prize > 0 ? prize / buyIn : num(row.mult, 0);
  }

  /* a ≥ b à une erreur d'arrondi près (un ×1000 calculé 999,9999999999999 reste un ×1000). */
  function atLeast(a, b) {
    return a >= b - Math.abs(b) * 1e-9;
  }

  /* Ne garde que les lignes exploitables et calcule p = weight / Σweight. */
  function normalizeRows(rows, buyIn) {
    var out = [];
    var total = 0;
    for (var i = 0; i < rows.length; i++) {
      var w = num(rows[i].weight, 0);
      var pool = rowPool(rows[i], buyIn);
      if (w > 0 && pool > 0) {
        total += w;
        out.push({
          index: i,
          weight: w,
          pool: pool,
          effMult: rowMult(rows[i], buyIn),
          s1: num(rows[i].s1, 0) / 100,
          s2: num(rows[i].s2, 0) / 100,
          s3: num(rows[i].s3, 0) / 100
        });
      }
    }
    for (var j = 0; j < out.length; j++) out[j].p = total > 0 ? out[j].weight / total : 0;
    return { rows: out, totalWeight: total };
  }

  /*
   * Rake caché dans la grille : ce que les 3 joueurs paient moins ce qui est redistribué.
   * Rake effectif : même calcul sachant qu'aucun jackpot (multiplicateur ≥ jackpotMult)
   * ne tombe, c.-à-d. ce qu'on paie réellement tant qu'on n'en touche pas.
   */
  function tableStats(rows, buyIn, jackpotMult) {
    var norm = normalizeRows(rows, buyIn);
    var jm = num(jackpotMult, Infinity);
    var ePool = 0, ePoolSmall = 0, pSmall = 0;
    var splitIssues = [];
    for (var i = 0; i < norm.rows.length; i++) {
      var r = norm.rows[i];
      ePool += r.p * r.pool;
      if (!atLeast(r.effMult, jm)) { ePoolSmall += r.p * r.pool; pSmall += r.p; }
      var s = r.s1 + r.s2 + r.s3;
      if (Math.abs(s - 1) > 1e-6) splitIssues.push({ index: r.index, sum: s * 100 });
    }
    var paid = PLAYERS * buyIn;
    var poolNoJackpot = pSmall > 0 ? ePoolSmall / pSmall : NaN;
    return {
      rowCount: norm.rows.length,
      totalWeight: norm.totalWeight,
      expectedPool: ePool,
      expectedMult: buyIn > 0 ? ePool / buyIn : 0,
      hiddenRakePct: paid > 0 ? (1 - ePool / paid) * 100 : 0,
      hiddenRakePerPlayer: buyIn - ePool / PLAYERS,
      effectiveRakePct: paid > 0 ? (1 - poolNoJackpot / paid) * 100 : NaN,
      effectiveRakePerPlayer: buyIn - poolNoJackpot / PLAYERS,
      jackpotProbability: 1 - pSmall,
      splitIssues: splitIssues
    };
  }

  /* ---------- Profil joueur ---------- */

  /* Conservation des jetons : E[tapis final] = 3S·P(1er) = S + cEV. */
  function winProb(cev, stack) {
    return clamp((stack + cev) / (PLAYERS * stack), 0, 1);
  }

  /*
   * P(2e) n'est pas déterminée par le cEV (une équation, deux inconnues) :
   *  - 'harville' : modèle de Malmuth-Harville sur les parts de jetons espérées
   *                 (toi x, chaque adversaire (1−x)/2) → P2 = 2x(1−x)/(1+x)
   *  - 'manual'   : part des non-victoires finies 2e, saisie par l'utilisateur
   */
  function placeProbs(p1, finishModel, share2Pct) {
    var p2;
    if (finishModel === 'manual') {
      p2 = (1 - p1) * clamp(num(share2Pct, 50) / 100, 0, 1);
    } else {
      p2 = p1 >= 1 ? 0 : 2 * p1 * (1 - p1) / (1 + p1);
    }
    var p3 = Math.max(0, 1 - p1 - p2);
    return [p1, p2, p3];
  }

  /* cEV appliqué à une ligne : global, ou tranche dont le seuil "from" est le plus grand ≤ mult. */
  function cevForMult(profile, effMult) {
    var base = num(profile.cev, 0);
    if (profile.cevMode !== 'tranches' || !profile.tranches || !profile.tranches.length) return base;
    var best = null;
    for (var i = 0; i < profile.tranches.length; i++) {
      var t = profile.tranches[i];
      var from = num(t.from, 0);
      if (atLeast(effMult, from) && (best === null || from > num(best.from, 0))) best = t;
    }
    return best ? num(best.cev, base) : base;
  }

  /* Écart-type des jetons par partie : auto = 3S·√(p(1−p)) (résultat final +2S ou −S). */
  function cevStdError(profile, stack) {
    var u = profile.uncertainty || {};
    var n = num(u.nSample, 0);
    if (!u.enabled || n <= 0) return 0;
    var sd;
    if (u.sdMode === 'manual') {
      sd = num(u.sd, 0);
    } else {
      var p = winProb(num(profile.cev, 0), stack);
      sd = PLAYERS * stack * Math.sqrt(p * (1 - p));
    }
    return sd / Math.sqrt(n);
  }

  /* ---------- Rakeback ---------- */

  function nominalFee(rb, buyIn, gridFeePct) {
    if (rb.feeMode === 'eur') return num(rb.feeEur, 0);
    return buyIn * num(gridFeePct, 0) / 100;
  }

  function tierPct(tiers, monthlyVolume) {
    var best = null;
    for (var i = 0; i < (tiers || []).length; i++) {
      var t = tiers[i];
      if (num(t.minGames, 0) <= monthlyVolume && (best === null || num(t.minGames, 0) > num(best.minGames, 0))) best = t;
    }
    return best ? num(best.pct, 0) : 0;
  }

  /* Rakeback + bonus par partie (déterministe : s'ajoute à chaque partie). */
  function rakebackPerGame(rb, buyIn, gridFeePct) {
    rb = rb || {};
    var fee = nominalFee(rb, buyIn, gridFeePct);
    var value = 0;
    var pct = 0;
    if (rb.mode === 'fixed') {
      value = num(rb.fixedEur, 0);
    } else if (rb.mode === 'tiers') {
      pct = tierPct(rb.tiers, num(rb.monthlyVolume, 0));
      value = fee * pct / 100;
    } else if (rb.mode === 'pct') {
      pct = num(rb.pct, 0);
      value = fee * pct / 100;
    }
    var extra = num(rb.extraEur, 0);
    return { fee: fee, pct: pct, rakeback: value, extra: extra, total: value + extra };
  }

  /* ---------- Résultats par ligne ---------- */

  /*
   * Pour chaque ligne : probabilités de place et profit de chaque place.
   * cevDelta décale tous les cEV (incertitude d'estimation, recherche du break-even).
   */
  function rowOutcomes(cfg, cevDelta) {
    return outcomesFromRows(normalizeRows(cfg.rows, cfg.buyIn).rows, cfg, cevDelta);
  }

  /* Même calcul à partir de lignes déjà normalisées (évite de re-filtrer la grille dans les boucles). */
  function outcomesFromRows(normRows, cfg, cevDelta) {
    var rb = num(cfg.rbPerGame, 0);
    var out = [];
    for (var i = 0; i < normRows.length; i++) {
      var r = normRows[i];
      var cev = cevForMult(cfg.profile, r.effMult) + (cevDelta || 0);
      var probs = placeProbs(winProb(cev, cfg.stack), cfg.profile.finishModel, cfg.profile.share2);
      var prizes = [r.pool * r.s1, r.pool * r.s2, r.pool * r.s3];
      var expPrize = probs[0] * prizes[0] + probs[1] * prizes[1] + probs[2] * prizes[2];
      out.push({
        index: r.index,
        p: r.p,
        pool: r.pool,
        effMult: r.effMult,
        cev: cev,
        probs: probs,
        prizes: prizes,
        profits: [prizes[0] - cfg.buyIn + rb, prizes[1] - cfg.buyIn + rb, prizes[2] - cfg.buyIn + rb],
        expPrize: expPrize,
        expProfit: expPrize - cfg.buyIn + rb
      });
    }
    return out;
  }

  function evFromRows(normRows, cfg, cevDelta) {
    var rows = outcomesFromRows(normRows, cfg, cevDelta);
    var ev = 0;
    for (var i = 0; i < rows.length; i++) ev += rows[i].p * rows[i].expProfit;
    return ev;
  }

  function evPerGame(cfg, cevDelta) {
    return evFromRows(normalizeRows(cfg.rows, cfg.buyIn).rows, cfg, cevDelta);
  }

  /* Décalage de cEV (appliqué à toutes les tranches) qui annule l'EV. null si hors bornes. */
  function breakEvenDelta(cfg) {
    /*
     * P(1er) ne varie que pour un cEV dans [−S, 2S] : on borne le décalage pour que
     * toutes les tranches parcourent cet intervalle en entier, quels que soient leurs cEV.
     */
    var norm = normalizeRows(cfg.rows, cfg.buyIn).rows;
    var rows = outcomesFromRows(norm, cfg, 0);
    var minCev = Infinity, maxCev = -Infinity;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].cev < minCev) minCev = rows[i].cev;
      if (rows[i].cev > maxCev) maxCev = rows[i].cev;
    }
    if (!rows.length) return null;
    var lo = -cfg.stack - maxCev - 1;
    var hi = 2 * cfg.stack - minCev + 1;
    if (evFromRows(norm, cfg, lo) > 0 || evFromRows(norm, cfg, hi) < 0) return null;
    /* intervalle de ~3S jetons : 60 itérations descendent bien sous la précision affichée */
    for (var it = 0; it < 60; it++) {
      var mid = (lo + hi) / 2;
      if (evFromRows(norm, cfg, mid) < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* ---------- Analyse exacte (sans simulation) ---------- */

  function analyze(cfg) {
    var rows = rowOutcomes(cfg, 0);
    var games = Math.max(0, Math.floor(num(cfg.games, 0)));
    var jackpotMult = num(cfg.jackpotMult, Infinity);
    var ev = 0;
    var ex2 = 0;
    var grossPrize = 0;
    var jackpotPrize = 0;
    var pJackpot = 0;
    var pNoJackpot = 0;
    var detail = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var e2 = 0;
      for (var k = 0; k < 3; k++) e2 += r.probs[k] * r.profits[k] * r.profits[k];
      ev += r.p * r.expProfit;
      ex2 += r.p * e2;
      grossPrize += r.p * r.expPrize;
      var isJackpot = atLeast(r.effMult, jackpotMult);
      if (isJackpot) {
        jackpotPrize += r.p * r.expPrize;
        pJackpot += r.p;
      } else {
        pNoJackpot += r.p;
      }
      detail.push({
        index: r.index,
        p: r.p,
        pool: r.pool,
        effMult: r.effMult,
        cev: r.cev,
        probs: r.probs,
        prizeContribution: r.p * r.expPrize,
        expectedCount: r.p * games,
        pAtLeastOne: 1 - Math.pow(1 - r.p, games),
        isJackpot: isJackpot
      });
    }
    for (var d = 0; d < detail.length; d++) {
      detail[d].shareOfReturn = grossPrize > 0 ? detail[d].prizeContribution / grossPrize : 0;
    }
    var variance = Math.max(0, ex2 - ev * ev);
    var rbPerGame = num(cfg.rbPerGame, 0);
    /* EV sachant qu'aucun jackpot (≥ seuil) ne tombe : espérance conditionnelle sur les autres lignes. */
    /* masse exacte des lignes hors jackpot (1 − pJackpot vaudrait 1e-16 au lieu de 0 par arrondi) */
    var evNoJackpot = pNoJackpot > 0
      ? (grossPrize - jackpotPrize) / pNoJackpot - cfg.buyIn + rbPerGame
      : NaN;
    var be = breakEvenDelta(cfg);
    return {
      ev: ev,
      evWithoutRb: ev - rbPerGame,
      roi: ev / cfg.buyIn,
      roiWithoutRb: (ev - rbPerGame) / cfg.buyIn,
      evNoJackpot: evNoJackpot,
      roiNoJackpot: evNoJackpot / cfg.buyIn,
      grossPrize: grossPrize,
      jackpotShareOfEv: jackpotPrize,
      pJackpotPerGame: pJackpot,
      pAtLeastOneJackpot: 1 - Math.pow(1 - pJackpot, games),
      sd: Math.sqrt(variance),
      totalEv: ev * games,
      totalSdNormal: Math.sqrt(variance * games),
      breakEvenDelta: be,
      detail: detail
    };
  }

  /* ---------- Aléatoire ---------- */

  /*
   * sfc32 : PRNG 32 bits rapide. (seed, stream) identifie un flux indépendant :
   * chaque simulation a son propre flux, donc le résultat d'une graine ne dépend
   * pas du découpage entre workers.
   */
  function makeRng(seed, stream) {
    var a = seed >>> 0, b = (stream || 0) >>> 0, c = 0xb7e15162, d = 1;
    function next() {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      var t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    }
    for (var i = 0; i < 20; i++) next();
    return next;
  }

  function gaussian(rng) {
    var u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  /* Méthode alias de Vose : tirage d'une ligne en O(1). */
  function buildAlias(probs) {
    var n = probs.length;
    var prob = new Float64Array(n);
    var alias = new Int32Array(n);
    var scaled = new Float64Array(n);
    var small = [];
    var large = [];
    for (var i = 0; i < n; i++) {
      scaled[i] = probs[i] * n;
      (scaled[i] < 1 ? small : large).push(i);
    }
    while (small.length && large.length) {
      var s = small.pop();
      var l = large.pop();
      prob[s] = scaled[s];
      alias[s] = l;
      scaled[l] = scaled[l] + scaled[s] - 1;
      (scaled[l] < 1 ? small : large).push(l);
    }
    while (large.length) { var g = large.pop(); prob[g] = 1; alias[g] = g; }
    while (small.length) { var m = small.pop(); prob[m] = 1; alias[m] = m; }
    return { prob: prob, alias: alias };
  }

  /* ---------- Simulation Monte Carlo ---------- */

  /*
   * Simule `count` trajectoires de cfg.games parties, numérotées à partir de firstIndex.
   * cfg : { rows, buyIn, stack, profile, rbPerGame, games, checkpoints,
   *         jackpotMult, smoothJackpots, cevSe }
   * Retourne des tableaux typés par simulation (transférables depuis un worker).
   */
  /* Numéros de partie (1-based) des K points de contrôle, + sentinelle. Float64 : pas de débordement au-delà de 2^31. */
  function checkpointGames(games, K) {
    var cpGames = new Float64Array(K + 1);
    for (var c = 0; c < K; c++) cpGames[c] = Math.round((c + 1) * games / K);
    cpGames[K] = games + 1;
    return cpGames;
  }

  function simulateBatch(cfg, count, seed, onProgress, firstIndex) {
    var games = Math.max(1, Math.floor(cfg.games));
    var K = Math.max(1, Math.min(Math.floor(cfg.checkpoints || 200), games));
    var first = firstIndex || 0;
    var rng;
    /* grille normalisée une seule fois ; seules les probabilités de place dépendent du cEV tiré */
    var normRows = normalizeRows(cfg.rows, cfg.buyIn).rows;
    var base = outcomesFromRows(normRows, cfg, 0);
    var n = base.length;
    if (!n) throw new Error('Grille vide : aucune ligne avec poids et prix > 0.');
    var jackpotMult = num(cfg.jackpotMult, Infinity);
    var isJack = new Uint8Array(n);
    var pNoJack = 0;
    for (var j = 0; j < n; j++) {
      isJack[j] = atLeast(base[j].effMult, jackpotMult) ? 1 : 0;
      if (!isJack[j]) pNoJack += base[j].p;
    }
    /*
     * Lissage des jackpots : on ne tire que parmi les lignes hors jackpot (renormalisées) et on ajoute
     * à chaque partie la part d'EV qui vient des jackpots. EV identique, variance des jackpots retirée.
     */
    var smooth = !!cfg.smoothJackpots && pNoJack > 0;
    var probs = [];
    for (var i = 0; i < n; i++) probs.push(smooth ? (isJack[i] ? 0 : base[i].p / pNoJack) : base[i].p);
    var al = buildAlias(probs);
    var aProb = al.prob, aAlias = al.alias;

    var cpGames = checkpointGames(games, K);

    var finals = new Float64Array(count);
    var maxDD = new Float64Array(count);
    var stretch = new Float64Array(count);
    var minCum = new Float64Array(count);
    var deltas = new Float64Array(count);
    var cps = new Float32Array(count * K);
    var simsWithJackpot = 0;

    var c1 = new Float64Array(n), c2 = new Float64Array(n);
    var pa = new Float64Array(n), pb = new Float64Array(n), pc = new Float64Array(n);
    var cevSe = num(cfg.cevSe, 0);

    for (var s = 0; s < count; s++) {
      rng = makeRng(seed, first + s);
      var delta = cevSe > 0 ? gaussian(rng) * cevSe : 0;
      deltas[s] = delta;
      var rows = delta !== 0 ? outcomesFromRows(normRows, cfg, delta) : base;
      /* décalage du lissage = EV totale − EV conditionnelle hors jackpot (dépend du cEV tiré) */
      var shift = 0;
      if (smooth) {
        var evAll = 0, evNoJack = 0;
        for (var e = 0; e < n; e++) {
          evAll += rows[e].p * rows[e].expProfit;
          if (!isJack[e]) evNoJack += rows[e].p * rows[e].expProfit;
        }
        shift = evAll - evNoJack / pNoJack;
      }
      for (var r = 0; r < n; r++) {
        var ro = rows[r];
        c1[r] = ro.probs[0];
        c2[r] = ro.probs[0] + ro.probs[1];
        pa[r] = ro.profits[0] + shift; pb[r] = ro.profits[1] + shift; pc[r] = ro.profits[2] + shift;
      }

      var cum = 0, peak = 0, peakG = 0, dd = 0, longest = 0, low = 0;
      var cpi = 0, nextCp = cpGames[0], hit = false, off = s * K;
      for (var g = 1; g <= games; g++) {
        var x = rng() * n;
        var idx = x | 0;
        if (x - idx >= aProb[idx]) idx = aAlias[idx];
        var u = rng();
        cum += u < c1[idx] ? pa[idx] : (u < c2[idx] ? pb[idx] : pc[idx]);
        if (cum > peak) {
          if (g - peakG - 1 > longest) longest = g - peakG - 1;
          peak = cum;
          peakG = g;
        } else if (peak - cum > dd) {
          dd = peak - cum;
        }
        if (cum < low) low = cum;
        if (isJack[idx]) hit = true;
        if (g === nextCp) { cps[off + cpi] = cum; cpi++; nextCp = cpGames[cpi]; }
      }
      if (games - peakG > longest) longest = games - peakG;
      finals[s] = cum;
      maxDD[s] = dd;
      stretch[s] = longest;
      minCum[s] = low;
      if (hit) simsWithJackpot++;
      if (onProgress && (s & 15) === 15) onProgress(s + 1);
    }
    if (onProgress) onProgress(count);
    return {
      count: count,
      checkpoints: K,
      cpGames: Array.prototype.slice.call(cpGames, 0, K),
      finals: finals,
      maxDD: maxDD,
      stretch: stretch,
      minCum: minCum,
      deltas: deltas,
      cps: cps,
      simsWithJackpot: simsWithJackpot
    };
  }

  /* ---------- Agrégation ---------- */

  function sortedCopy(arr) {
    var a = Float64Array.from(arr);
    a.sort();
    return a;
  }

  /* Percentile (q dans [0,1]) d'un tableau trié, interpolation linéaire. */
  function quantile(sorted, q) {
    var n = sorted.length;
    if (!n) return NaN;
    var pos = clamp(q, 0, 1) * (n - 1);
    var lo = Math.floor(pos);
    var hi = Math.min(n - 1, lo + 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function mean(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return arr.length ? s / arr.length : NaN;
  }

  function sd(arr, m) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return arr.length > 1 ? Math.sqrt(s / (arr.length - 1)) : 0;
  }

  function concatTyped(Ctor, parts) {
    var len = 0;
    for (var i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Ctor(len);
    var off = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], off); off += parts[j].length; }
    return out;
  }

  function mergeBatches(batches) {
    var simsWithJackpot = 0;
    for (var b = 0; b < batches.length; b++) simsWithJackpot += batches[b].simsWithJackpot;
    function pick(key) { return batches.map(function (x) { return x[key]; }); }
    var count = 0;
    for (var c = 0; c < batches.length; c++) count += batches[c].count;
    return {
      count: count,
      checkpoints: batches[0].checkpoints,
      cpGames: batches[0].cpGames,
      finals: concatTyped(Float64Array, pick('finals')),
      maxDD: concatTyped(Float64Array, pick('maxDD')),
      stretch: concatTyped(Float64Array, pick('stretch')),
      minCum: concatTyped(Float64Array, pick('minCum')),
      deltas: concatTyped(Float64Array, pick('deltas')),
      cps: concatTyped(Float32Array, pick('cps')),
      simsWithJackpot: simsWithJackpot
    };
  }

  /* Place en position k (0-based) la k-ième plus petite valeur de arr[lo..hi] : à gauche ≤, à droite ≥. */
  function selectInPlace(arr, k, lo, hi) {
    while (hi > lo) {
      /* pivot médiane de trois */
      var mid = (lo + hi) >> 1;
      var a = arr[lo], b = arr[mid], c = arr[hi];
      var pivot = a < b ? (b < c ? b : (a < c ? c : a)) : (a < c ? a : (b < c ? c : b));
      var i = lo, j = hi;
      while (i <= j) {
        while (arr[i] < pivot) i++;
        while (arr[j] > pivot) j--;
        if (i <= j) { var t = arr[i]; arr[i] = arr[j]; arr[j] = t; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  /*
   * Quantiles (qs croissants) d'un tableau non trié, en O(n) par quantile au lieu d'un tri complet.
   * Même interpolation que quantile(). Réordonne arr.
   */
  function quantilesInPlace(arr, qs) {
    var n = arr.length;
    var out = new Array(qs.length);
    var start = 0;
    for (var q = 0; q < qs.length; q++) {
      var pos = clamp(qs[q], 0, 1) * (n - 1);
      var lo = Math.floor(pos);
      selectInPlace(arr, lo, start, n - 1);
      var vLo = arr[lo];
      var vHi = vLo;
      if (lo + 1 < n && pos > lo) {
        /* la suivante est le minimum de la partie droite */
        vHi = arr[lo + 1];
        for (var t = lo + 2; t < n; t++) if (arr[t] < vHi) vHi = arr[t];
      }
      out[q] = vLo + (vHi - vLo) * (pos - lo);
      start = lo;
    }
    return out;
  }

  var BAND_QS = [0.05, 0.25, 0.5, 0.75, 0.95];
  var REPORT_QS = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];

  /*
   * Statistiques finales. Ruine : la bankroll ne permet plus de payer un buy-in,
   * soit bankroll + pire cumul < buyIn  ⇔  besoin = max(0, −pire cumul) + buyIn > bankroll.
   */
  function summarize(merged, opts) {
    var n = merged.count;
    var K = merged.checkpoints;
    var finalsSorted = sortedCopy(merged.finals);
    var maxDDSorted = sortedCopy(merged.maxDD);
    var m = mean(merged.finals);
    var losing = 0;
    for (var i = 0; i < n; i++) if (merged.finals[i] < 0) losing++;

    /* un seul tampon par point de contrôle, quantiles par sélection (pas de tri complet) */
    var bands = BAND_QS.map(function () { return new Float64Array(K); });
    var meanPath = new Float64Array(K);
    var col = new Float64Array(n);
    for (var k = 0; k < K; k++) {
      var s = 0;
      for (var j = 0; j < n; j++) { col[j] = merged.cps[j * K + k]; s += col[j]; }
      meanPath[k] = s / n;
      var qv = quantilesInPlace(col, BAND_QS);
      for (var q = 0; q < BAND_QS.length; q++) bands[q][k] = qv[q];
    }

    var need = new Float64Array(n);
    for (var t = 0; t < n; t++) need[t] = Math.max(0, -merged.minCum[t]) + opts.buyIn;
    var needSorted = need.sort();
    function ror(bankroll) {
      /* proportion de besoins strictement supérieurs à la bankroll */
      var lo = 0, hi = n;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (needSorted[mid] <= bankroll) lo = mid + 1; else hi = mid; }
      return (n - lo) / n;
    }
    var rorCurve = [];
    var maxNeed = quantile(needSorted, 0.995);
    var steps = 60;
    for (var st = 0; st <= steps; st++) {
      var br = maxNeed * st / steps;
      rorCurve.push([br, ror(br)]);
    }

    var nPaths = Math.min(n, Math.max(0, opts.paths || 0));
    var paths = [];
    for (var pIdx = 0; pIdx < nPaths; pIdx++) {
      paths.push(Array.prototype.slice.call(merged.cps, pIdx * K, (pIdx + 1) * K));
    }

    function report(arr, srt, avg) {
      srt = srt || sortedCopy(arr);
      var o = {};
      REPORT_QS.forEach(function (qq) { o['p' + Math.round(qq * 100)] = quantile(srt, qq); });
      o.mean = avg === undefined ? mean(arr) : avg;
      return o;
    }

    return {
      count: n,
      games: opts.games,
      cpGames: merged.cpGames,
      meanFinal: m,
      sdFinal: sd(merged.finals, m),
      finals: report(merged.finals, finalsSorted, m),
      finalsSorted: finalsSorted,
      pLosing: losing / n,
      bands: bands,
      bandQs: BAND_QS,
      meanPath: meanPath,
      paths: paths,
      maxDD: report(merged.maxDD, maxDDSorted),
      maxDDSorted: maxDDSorted,
      stretch: report(merged.stretch),
      rorAtBankroll: ror(opts.bankroll),
      bankrollFor: {
        r10: quantile(needSorted, 0.90),
        r5: quantile(needSorted, 0.95),
        r1: quantile(needSorted, 0.99)
      },
      rorCurve: rorCurve,
      pSimsWithJackpot: merged.simsWithJackpot / n,
      deltaSd: sd(merged.deltas, mean(merged.deltas))
    };
  }

  /* ---------- Analyse de chance (résultats réels) ---------- */

  function logFactorial(k) {
    /* Stirling corrigé au-delà de 20, exact en dessous */
    if (k < 21) { var s = 0; for (var i = 2; i <= k; i++) s += Math.log(i); return s; }
    return k * Math.log(k) - k + 0.5 * Math.log(2 * Math.PI * k) + 1 / (12 * k) - 1 / (360 * k * k * k);
  }

  function logBinomPmf(k, n, p) {
    if (p <= 0) return k === 0 ? 0 : -Infinity;
    if (p >= 1) return k === n ? 0 : -Infinity;
    return logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p);
  }

  /*
   * Queue normale P(Z ≥ z), calculée directement (pas en 1 − cdf) via erfc de Numerical Recipes :
   * erreur RELATIVE < 1,2e-7, donc précise aussi pour les très petites probabilités.
   */
  function normalUpperTail(z) {
    var x = Math.abs(z) / Math.SQRT2;
    var t = 1 / (1 + 0.5 * x);
    var erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return z >= 0 ? 0.5 * erfc : 1 - 0.5 * erfc;
  }

  /* P(X ≥ k) si k ≥ espérance, sinon P(X ≤ k), pour X ~ Binomiale(n, p). */
  function binomTail(k, n, p) {
    var mu = n * p;
    var upper = k >= mu;
    var varr = n * p * (1 - p);
    if (varr > 400) {
      var z = upper ? (k - 0.5 - mu) / Math.sqrt(varr) : (k + 0.5 - mu) / Math.sqrt(varr);
      /* P(X ≥ k) = Q(z) ; P(X ≤ k) = Q(−z) */
      return normalUpperTail(upper ? z : -z);
    }
    var sum = 0;
    if (upper) {
      /* au-delà de la moyenne les termes décroissent : on s'arrête dès qu'ils sont négligeables ou nuls */
      for (var i = k; i <= n; i++) {
        var t = Math.exp(logBinomPmf(i, n, p));
        sum += t;
        if (i > mu && (t === 0 || t < sum * 1e-15)) break;
      }
    } else {
      for (var j = k; j >= 0; j--) {
        var t2 = Math.exp(logBinomPmf(j, n, p));
        sum += t2;
        if (j < mu && (t2 === 0 || t2 < sum * 1e-15)) break;
      }
    }
    return Math.min(1, sum);
  }

  /*
   * Décompose l'écart résultat réel − EV théorique :
   *   chance multiplicateurs = EV sachant les multiplicateurs réellement tirés − EV théorique
   *   chance places          = résultat réel − EV sachant les multiplicateurs tirés
   * Les résultats sont hors rakeback.
   */
  function luckAnalysis(cfg, counts, actualNet) {
    var noRb = Object.assign({}, cfg, { rbPerGame: 0 });
    var rows = rowOutcomes(noRb, 0);
    var byIndex = {};
    rows.forEach(function (r) { byIndex[r.index] = r; });
    var N = 0;
    for (var key in counts) if (byIndex[key]) N += Math.max(0, Math.floor(num(counts[key], 0)));
    var evTheo = 0, evGiven = 0, eg = 0, eg2 = 0;
    var detail = [];
    rows.forEach(function (r) {
      var k = Math.max(0, Math.floor(num(counts[r.index], 0)));
      evTheo += N * r.p * r.expProfit;
      evGiven += k * r.expProfit;
      eg += r.p * r.expProfit;
      eg2 += r.p * r.expProfit * r.expProfit;
      detail.push({
        index: r.index,
        effMult: r.effMult,
        expected: N * r.p,
        actual: k,
        tail: N > 0 ? binomTail(k, N, r.p) : 1,
        luck: (k - N * r.p) * r.expProfit
      });
    });
    var varG = Math.max(0, eg2 - eg * eg);
    var multLuck = evGiven - evTheo;
    var zMult = N > 0 && varG > 0 ? multLuck / Math.sqrt(N * varG) : 0;
    return {
      games: N,
      evTheo: evTheo,
      evGivenMultipliers: evGiven,
      actual: actualNet,
      multiplierLuck: multLuck,
      placeLuck: actualNet - evGiven,
      totalLuck: actualNet - evTheo,
      zMultiplier: zMult,
      detail: detail
    };
  }

  return {
    PLAYERS: PLAYERS,
    num: num,
    rowPool: rowPool,
    rowMult: rowMult,
    normalizeRows: normalizeRows,
    tableStats: tableStats,
    winProb: winProb,
    placeProbs: placeProbs,
    cevForMult: cevForMult,
    cevStdError: cevStdError,
    rakebackPerGame: rakebackPerGame,
    tierPct: tierPct,
    rowOutcomes: rowOutcomes,
    evPerGame: evPerGame,
    breakEvenDelta: breakEvenDelta,
    analyze: analyze,
    makeRng: makeRng,
    buildAlias: buildAlias,
    checkpointGames: checkpointGames,
    simulateBatch: simulateBatch,
    mergeBatches: mergeBatches,
    summarize: summarize,
    quantile: quantile,
    quantilesInPlace: quantilesInPlace,
    binomTail: binomTail,
    luckAnalysis: luckAnalysis
  };
}

var SpinModel = spinModelFactory();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { spinModelFactory: spinModelFactory, SpinModel: SpinModel };
}
