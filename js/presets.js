/*
 * Grilles intégrées.
 *
 * Les grilles « room » sont recopiées des pages officielles des rooms (voir `source`
 * et `checked`). Les rooms changent leurs tables sans préavis : en cas de doute,
 * revérifier sur la page source. PokerStars.fr ne publie pas de table accessible
 * publiquement : à saisir depuis le client de jeu.
 */
var SPIN_PRESETS = (function () {
  'use strict';

  var CHECKED = '2026-11-03';
  var SPLIT_WINAMAX = [80, 12, 8];
  var presets = [];

  /* rows : [prize pool en €, occurrences, partage ? ] → multiplicateur = pool / buyIn */
  function fromPools(buyIn, rows) {
    return rows.map(function (r) {
      var s = r[2] || [100, 0, 0];
      return { mult: r[0] / buyIn, prize: 0, weight: r[1], s1: s[0], s2: s[1], s3: s[2] };
    });
  }

  /* rows : [multiplicateur, occurrences, partage ?] */
  function fromMults(rows) {
    return rows.map(function (r) {
      var s = r[2] || [100, 0, 0];
      return { mult: r[0], prize: 0, weight: r[1], s1: s[0], s2: s[1], s3: s[2] };
    });
  }

  function add(room, label, buyIn, opts) {
    presets.push({
      id: room.id + '-' + String(buyIn).replace('.', '_'),
      room: room.id,
      roomName: room.name,
      name: room.name + ' ' + label,
      builtin: true,
      buyIn: buyIn,
      stack: room.stack,
      feePct: opts.feePct,
      rows: opts.rows,
      source: room.source,
      checked: CHECKED,
      note: opts.note || ''
    });
  }

  /* ---------- Winamax Expresso (occurrences sur 10 000 000, sauf 250 € et 500 € sur 1 000 000) ---------- */
  var WINA = { id: 'winamax', name: 'Winamax Expresso', stack: 500, source: 'https://www.winamax.fr/expresso' };
  var S = SPLIT_WINAMAX;
  [
    [0.25, 8, [[25000, 2, S], [250, 100, S], [25, 2000, S], [5, 10000], [2.5, 100000], [1.25, 400000], [1, 800000], [0.75, 3324204], [0.5, 5363694]]],
    [0.5, 8, [[50000, 2, S], [500, 100, S], [50, 2000, S], [10, 10000], [5, 100000], [2.5, 400000], [2, 800000], [1.5, 3324204], [1, 5363694]]],
    [1, 7, [[100000, 4, S], [1000, 100, S], [100, 2000, S], [20, 10000], [10, 100000], [5, 400000], [4, 850000], [3, 3324208], [2, 5313688]]],
    [2, 7, [[1000000, 1, S], [2000, 100, S], [200, 2000, S], [40, 10000], [20, 100000], [10, 400000], [8, 800000], [6, 3324202], [4, 5363697]]],
    [5, 7, [[1000000, 1, S], [5000, 100, S], [500, 2000, S], [100, 15000], [50, 100000], [25, 400000], [20, 900000], [15, 3334202], [10, 5248697]]],
    [10, 7, [[1000000, 2, S], [10000, 100, S], [1000, 2000, S], [200, 15000], [100, 100000], [50, 400000], [40, 900000], [30, 3334204], [20, 5248694]]],
    [25, 7, [[1000000, 5, S], [25000, 100, S], [2500, 2000, S], [500, 15000], [250, 100000], [125, 400000], [100, 900000], [75, 3334210], [50, 5248685]]],
    [50, 7, [[1000000, 10, S], [50000, 100, S], [5000, 2000, S], [1000, 15000], [500, 100000], [250, 400000], [200, 900000], [150, 3334220], [100, 5248670]]],
    [100, 7, [[1000000, 20, S], [100000, 100, S], [10000, 2000, S], [2000, 15000], [1000, 100000], [500, 400000], [400, 900000], [300, 3334240], [200, 5248640]]],
    [250, 7, [[1000000, 4, S], [100000, 25, S], [25000, 200, S], [5000, 1500], [2500, 10000], [1250, 40000], [1000, 90000], [750, 337458], [500, 520813]]],
    [500, 7, [[2000000, 4, S], [200000, 25, S], [50000, 200, S], [10000, 1500], [5000, 10000], [2500, 40000], [2000, 90000], [1500, 337458], [1000, 520813]]]
  ].forEach(function (d) {
    add(WINA, String(d[0]).replace('.', ',') + ' €', d[0], { feePct: d[1], rows: fromPools(d[0], d[2]) });
  });

  /* ---------- Unibet Power Spin (probabilités en %, converties en occurrences sur 1 000 000) ---------- */
  var UNI = { id: 'unibet', name: 'Unibet Power Spin', stack: 500, source: 'https://www.unibet.fr/paris-sportifs/poker-power-spin' };
  function unibetRows(top) {
    return fromMults([
      [top, 2, [80, 12, 8]], [100, 40, [80, 12, 8]], [10, 10000, [80, 10, 10]],
      [5, 32000], [4, 130000], [3, 345084], [2, 482874]
    ]);
  }
  [1, 2, 5, 10, 25, 50, 100].forEach(function (b) {
    add(UNI, b + ' €', b, { feePct: 7, rows: unibetRows(2500) });
  });
  add(UNI, '250 €', 250, { feePct: 6.9, rows: unibetRows(4000) });

  /* ---------- PMU Twister (probabilités en %, converties en occurrences sur 1 000 000) ---------- */
  var PMU = { id: 'pmu', name: 'PMU Twister', stack: 500, source: 'https://poker.pmu.fr/twister' };
  var P = [75, 15, 10];
  [1, 2, 5, 10, 20, 50, 100].forEach(function (b) {
    add(PMU, b + ' €', b, {
      feePct: 7,
      rows: fromMults([[1000, 10, P], [200, 30, P], [100, 100, P], [20, 500, P], [10, 3000, P],
        [5, 30000], [4, 130000], [3, 381280], [2, 455080]])
    });
  });
  add(PMU, '0,25 €', 0.25, {
    feePct: 7,
    note: 'Le tableau publié totalise 99 % : les fréquences sont renormalisées.',
    rows: fromMults([[1000, 10], [200, 30], [100, 100], [20, 500], [10, 3000], [5, 30000], [4, 110000], [3, 381280], [2, 465080]])
  });

  /* ---------- Betclic Twister (occurrences sur 1 000 000, tableau fourni par l'utilisateur depuis betclic.fr) ---------- */
  var BET = { id: 'betclic', name: 'Betclic Twister', stack: 500, source: 'https://www.betclic.fr/poker/content/pok_twister' };
  var T = [75, 15, 10];
  var betclicNote = 'Même grille pour tous les buy-ins de 0,20 € à 100 €. Tapis de départ non indiqué sur la page : 500 par défaut, à vérifier dans le client.';
  [0.2, 1, 2, 5, 10, 20, 50, 100].forEach(function (b) {
    add(BET, String(b).replace('.', ',') + ' €', b, {
      feePct: 7,
      note: betclicNote,
      rows: fromMults([[1000, 5, T], [100, 100, T], [20, 500, T], [10, 5000], [5, 40000], [4, 130000], [3, 346210], [2, 478185]])
    });
  });
  add(BET, '200 €', 200, {
    feePct: 7,
    note: 'Tapis de départ non indiqué sur la page : 500 par défaut, à vérifier dans le client.',
    rows: fromMults([[5000, 1, T], [500, 20, T], [50, 200, T], [10, 5000], [5, 40000], [4, 130000], [3, 345442], [2, 479337]])
  });

  /* ---------- Exemples ---------- */
  var EX = { id: 'exemples', name: 'Exemple', stack: 500, source: '' };
  presets.push({
    id: 'exemple-generique', room: EX.id, roomName: 'Exemples', name: 'Exemple générique (illustratif)', builtin: true,
    buyIn: 5, stack: 500, feePct: 7, source: '', checked: '', note: 'Grille inventée pour tester l\'outil.',
    rows: fromMults([[2, 750000], [3, 180000], [5, 50000], [10, 15000], [25, 4000],
      [100, 890, [80, 12, 8]], [1000, 100, [80, 12, 8]], [10000, 10, [80, 12, 8]]])
  });
  presets.push({
    id: 'vierge', room: EX.id, roomName: 'Exemples', name: 'Grille vierge', builtin: true,
    buyIn: 5, stack: 500, feePct: 0, source: '', checked: '', note: '',
    rows: fromMults([[2, 1]])
  });

  return presets;
})();

var SPIN_ROOMS = [
  { id: 'winamax', name: 'Winamax – Expresso' },
  { id: 'unibet', name: 'Unibet – Power Spin' },
  { id: 'pmu', name: 'PMU – Twister' },
  { id: 'betclic', name: 'Betclic – Twister' },
  { id: 'user', name: 'Mes grilles' },
  { id: 'exemples', name: 'Exemples' }
];

var SPIN_DEFAULT_STATE = {
  ui: { mode: 'simple' },
  presetId: 'winamax-5',
  grid: null,
  profile: {
    cevMode: 'global',
    cev: 25,
    tranches: [
      { from: 0, cev: 25 },
      { from: 10, cev: 25 },
      { from: 100, cev: 25 }
    ],
    finishModel: 'harville',
    share2: 50,
    uncertainty: { enabled: true, nSample: 10000, sdMode: 'auto', sd: 700 }
  },
  rb: {
    feeMode: 'grid',
    feeEur: 0.35,
    mode: 'pct',
    pct: 20,
    fixedEur: 0,
    tiers: [
      { minGames: 0, pct: 10 },
      { minGames: 1500, pct: 20 },
      { minGames: 4000, pct: 30 }
    ],
    monthlyVolume: 3000,
    extraEur: 0
  },
  sim: {
    games: 50000,
    sims: 2000,
    checkpoints: 200,
    paths: 25,
    bankroll: 500,
    seed: '',
    smoothJackpots: false,
    jackpotMult: 100,
    gamesPerHour: 60
  },
  luck: { counts: {}, actualNet: 0 },
  userPresets: [],
  scenarios: []
};

/* Réglages appliqués en mode simple, quels que soient les réglages experts enregistrés. */
var SPIN_SIMPLE_SIM = { sims: 2000, checkpoints: 200, paths: 25, seed: '', smoothJackpots: false, jackpotMult: 100 };
