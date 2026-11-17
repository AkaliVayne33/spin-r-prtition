/*
 * Répartit la simulation sur plusieurs Web Workers.
 * Les workers sont créés à partir d'un Blob contenant la source de spinModelFactory,
 * ce qui fonctionne aussi en ouvrant index.html directement (file://).
 * Si les workers sont indisponibles, la simulation tourne par tranches sur le thread principal.
 */
var SpinSim = (function () {
  'use strict';

  function workerMain() {
    self.onmessage = function (e) {
      var msg = e.data;
      try {
        var res = SpinModel.simulateBatch(msg.cfg, msg.count, msg.seed, function (done) {
          self.postMessage({ type: 'progress', done: done });
        }, msg.firstIndex);
        self.postMessage({ type: 'done', result: res },
          [res.finals.buffer, res.maxDD.buffer, res.stretch.buffer, res.minCum.buffer,
            res.deltas.buffer, res.cps.buffer]);
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err && err.message || err) });
      }
    };
  }

  var blobUrl = null;
  function workerUrl() {
    if (!blobUrl) {
      var src = 'var SpinModel = (' + spinModelFactory.toString() + ')();\n(' + workerMain.toString() + ')();';
      blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    }
    return blobUrl;
  }

  /* Nombre de workers lancés pour `sims` simulations (aussi affiché par l'interface). */
  function workerCount(sims) {
    return Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16, Math.floor(sims) || 1));
  }

  function splitCounts(total, parts) {
    var out = [];
    var base = Math.floor(total / parts);
    var rest = total % parts;
    for (var i = 0; i < parts; i++) {
      var c = base + (i < rest ? 1 : 0);
      if (c > 0) out.push(c);
    }
    return out;
  }

  /*
   * Lance la simulation. Retourne { promise, cancel }.
   * onProgress(fraction) est appelé régulièrement.
   */
  function run(cfg, sims, seed, onProgress) {
    var cancelled = false;
    var workers = [];
    var cancelHook = null;

    var promise = new Promise(function (resolve, reject) {
      var nWorkers = workerCount(sims);
      var counts = splitCounts(sims, nWorkers);
      var done = new Array(counts.length).fill(0);
      var results = new Array(counts.length);
      var finished = 0;

      function report() {
        var s = 0;
        for (var i = 0; i < done.length; i++) s += done[i];
        if (onProgress) onProgress(s / sims);
      }

      var fellBack = false;
      function fallback(reason) {
        if (fellBack) return;
        fellBack = true;
        workers.forEach(function (w) { w.terminate(); });
        workers = [];
        runOnMainThread(cfg, sims, seed, onProgress, function () { return cancelled; })
          .then(function (r) { r.usedFallback = reason; resolve(r); }, reject);
      }

      function abort(message) {
        workers.forEach(function (x) { x.terminate(); });
        reject(new Error(message));
      }

      /* vrai dès qu'un worker a répondu : les workers fonctionnent, une erreur ensuite est un vrai plantage */
      var anyMessage = false;

      try {
        var url = workerUrl();
        var firstIndex = 0;
        counts.forEach(function (count, i) {
          var offset = firstIndex;
          firstIndex += count;
          var w = new Worker(url);
          workers.push(w);
          w.onmessage = function (e) {
            anyMessage = true;
            var msg = e.data;
            /* une exception ici (ex. mémoire à la fusion) doit terminer la promesse, pas la laisser en suspens */
            try {
              if (msg.type === 'progress') {
                done[i] = msg.done;
                report();
              } else if (msg.type === 'done') {
                results[i] = msg.result;
                done[i] = count;
                report();
                w.terminate();
                finished++;
                if (finished === counts.length) resolve({ merged: SpinModel.mergeBatches(results), workers: counts.length });
              } else if (msg.type === 'error') {
                abort(msg.message);
              }
            } catch (err) {
              abort('Erreur pendant la simulation : ' + (err && err.message || err));
            }
          };
          w.onerror = function (ev) {
            ev.preventDefault();
            if (cancelled) return;
            /* aucun worker n'a jamais répondu : ils sont indisponibles (ex. file://), on bascule ; sinon c'est un plantage */
            if (!anyMessage) fallback(ev.message || 'erreur worker');
            else abort('Un worker a planté : ' + (ev.message || 'cause inconnue') + '. Essaie avec moins de simulations.');
          };
          w.postMessage({ cfg: cfg, count: count, seed: seed, firstIndex: offset });
        });
      } catch (err) {
        fallback(String(err && err.message || err));
      }

      cancelHook = function () {
        workers.forEach(function (w) { w.terminate(); });
        reject(new Error('Simulation annulée.'));
      };
    });

    return {
      promise: promise,
      cancel: function () {
        cancelled = true;
        if (cancelHook) cancelHook();
      }
    };
  }

  /* Repli : petites tranches de simulations entre deux frames pour garder la page réactive. */
  /* Au-delà, une seule trajectoire bloquerait la page plusieurs secondes sans pouvoir être annulée. */
  var MAIN_THREAD_MAX_GAMES = 2e7;

  function runOnMainThread(cfg, sims, seed, onProgress, isCancelled) {
    return new Promise(function (resolve, reject) {
      if (cfg.games > MAIN_THREAD_MAX_GAMES) {
        reject(new Error('Les workers sont indisponibles dans ce navigateur : sans eux, une trajectoire est limitée à ' +
          (MAIN_THREAD_MAX_GAMES / 1e6) + ' millions de parties. Réduis « Parties prévues ».'));
        return;
      }
      var results = [];
      var doneCount = 0;
      var chunk = Math.max(1, Math.floor(2e6 / Math.max(1, cfg.games)));
      function step() {
        if (isCancelled()) { reject(new Error('Simulation annulée.')); return; }
        try {
          var c = Math.min(chunk, sims - doneCount);
          results.push(SpinModel.simulateBatch(cfg, c, seed, null, doneCount));
          doneCount += c;
          if (onProgress) onProgress(doneCount / sims);
          if (doneCount >= sims) resolve({ merged: SpinModel.mergeBatches(results), workers: 0 });
          else setTimeout(step, 0);
        } catch (err) {
          reject(err);
        }
      }
      step();
    });
  }

  return { run: run, workerCount: workerCount };
})();
