/*
 * Graphiques canvas minimalistes : bandes de percentiles, histogramme, courbe.
 * Couleurs lues dans les variables CSS (--viz-*), donc compatibles clair/sombre.
 * Chaque graphique garde sa dernière définition pour se redessiner (resize, thème).
 */
var SpinCharts = (function () {
  'use strict';

  var registry = [];

  /* Couleurs lues dans les variables CSS, mises en cache le temps d'un dessin (prepareCanvas vide le cache). */
  var styleCache = null;
  function css(name) {
    if (!styleCache) styleCache = { style: getComputedStyle(document.documentElement), values: {} };
    if (!(name in styleCache.values)) styleCache.values[name] = styleCache.style.getPropertyValue(name).trim();
    return styleCache.values[name];
  }

  function niceStep(range, target) {
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var norm = raw / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }

  function ticks(min, max, target) {
    if (!(max > min)) { max = min + 1; }
    var step = niceStep(max - min, target);
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }

  function setup(host) {
    var el = typeof host === 'string' ? document.getElementById(host) : host;
    var chart = el.__chart;
    if (!chart) {
      el.classList.add('chart');
      var canvas = document.createElement('canvas');
      var tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.hidden = true;
      el.appendChild(canvas);
      el.appendChild(tip);
      chart = { el: el, canvas: canvas, tip: tip, draw: null, hover: null };
      el.__chart = chart;
      canvas.addEventListener('mousemove', function (e) {
        if (!chart.hover) return;
        var rect = canvas.getBoundingClientRect();
        chart.hover(e.clientX - rect.left, e.clientY - rect.top);
      });
      canvas.addEventListener('mouseleave', function () {
        tip.hidden = true;
        /* un graphique qui a une image mémorisée l'affiche simplement, sans tout retracer */
        if (chart.clearHover) chart.clearHover();
        else if (chart.draw) chart.draw(null);
      });
      registry.push(chart);
    }
    return chart;
  }

  function prepareCanvas(chart) {
    styleCache = null;
    var w = chart.el.clientWidth || 600;
    var h = parseInt(chart.el.dataset.height || '300', 10);
    var dpr = window.devicePixelRatio || 1;
    chart.canvas.width = Math.round(w * dpr);
    chart.canvas.height = Math.round(h * dpr);
    chart.canvas.style.width = w + 'px';
    chart.canvas.style.height = h + 'px';
    var ctx = chart.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function showTip(chart, x, y, html) {
    chart.tip.innerHTML = html;
    chart.tip.hidden = false;
    var tw = chart.tip.offsetWidth;
    var th = chart.tip.offsetHeight;
    var left = x + 14;
    if (left + tw > chart.el.clientWidth) left = x - tw - 14;
    var top = Math.max(0, Math.min(y - th / 2, chart.el.clientHeight - th));
    chart.tip.style.left = Math.max(0, left) + 'px';
    chart.tip.style.top = top + 'px';
  }

  /* Repère commun : axes, grille, graduations. */
  function frame(ctx, w, h, xr, yr, fmtX, fmtY) {
    var pad = { l: 64, r: 14, t: 12, b: 28 };
    var pw = w - pad.l - pad.r;
    var ph = h - pad.t - pad.b;
    var sx = function (v) { return pad.l + (v - xr[0]) / (xr[1] - xr[0] || 1) * pw; };
    var sy = function (v) { return pad.t + ph - (v - yr[0]) / (yr[1] - yr[0] || 1) * ph; };
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.fillStyle = css('--viz-text-muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks(yr[0], yr[1], 5).forEach(function (v) {
      var y = Math.round(sy(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? css('--viz-axis') : css('--viz-grid');
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(fmtY(v), pad.l - 6, y);
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ticks(xr[0], xr[1], Math.max(2, Math.floor(pw / 90))).forEach(function (v) {
      ctx.fillText(fmtX(v), sx(v), h - pad.b + 8);
    });
    return { pad: pad, pw: pw, ph: ph, sx: sx, sy: sy };
  }

  function nearestIndex(xs, value) {
    var lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] < value) lo = mid; else hi = mid; }
    return Math.abs(xs[lo] - value) <= Math.abs(xs[hi] - value) ? lo : hi;
  }

  /*
   * Trajectoires : bandes 5–95 % et 25–75 %, médiane, moyenne simulée, EV théorique,
   * quelques trajectoires individuelles.
   * def = { xs, bands:[p5,p25,p50,p75,p95], meanPath, evPerGame, paths, fmtY }
   */
  function bands(host, def) {
    var chart = setup(host);
    var snapshot = null;
    function snapshotValid() {
      return snapshot && snapshot.width === chart.canvas.width && snapshot.height === chart.canvas.height;
    }
    /* recolle l'image mémorisée (sans curseur) ; renvoie le contexte, ou null s'il faut tout redessiner */
    function restoreSnapshot() {
      if (!snapshotValid()) return null;
      var hctx = chart.canvas.getContext('2d');
      hctx.save();
      hctx.setTransform(1, 0, 0, 1, 0, 0);
      hctx.clearRect(0, 0, chart.canvas.width, chart.canvas.height);
      hctx.drawImage(snapshot, 0, 0);
      hctx.restore();
      return hctx;
    }
    chart.clearHover = function () {
      if (!restoreSnapshot()) chart.draw(null);
    };
    chart.draw = function (hoverIdx) {
      /* survol : on recolle l'image mémorisée et on ne dessine que le curseur (évite de retracer toutes les trajectoires) */
      if (hoverIdx != null) {
        var hctx = restoreSnapshot();
        if (hctx) {
          styleCache = null;
          drawHover(hctx, chart.geom, hoverIdx);
          return;
        }
      }
      var c = prepareCanvas(chart);
      var ctx = c.ctx;
      var xs = def.xs;
      var lo = 0, hi = 0;
      function scan(arr) { for (var i = 0; i < arr.length; i++) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; } }
      scan(def.bands[0]); scan(def.bands[4]); scan(def.meanPath);
      def.paths.forEach(scan);
      scan([def.evPerGame * xs[xs.length - 1]]);
      var padY = (hi - lo) * 0.05 || 1;
      var f = frame(ctx, c.w, c.h, [0, xs[xs.length - 1]], [lo - padY, hi + padY], fmtGames, def.fmtY);

      function area(a, b, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(f.sx(0), f.sy(0));
        for (var i = 0; i < xs.length; i++) ctx.lineTo(f.sx(xs[i]), f.sy(a[i]));
        for (var j = xs.length - 1; j >= 0; j--) ctx.lineTo(f.sx(xs[j]), f.sy(b[j]));
        ctx.lineTo(f.sx(0), f.sy(0));
        ctx.closePath();
        ctx.fill();
      }
      function line(arr, color, width, dash) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash || []);
        ctx.beginPath();
        ctx.moveTo(f.sx(0), f.sy(0));
        for (var i = 0; i < xs.length; i++) ctx.lineTo(f.sx(xs[i]), f.sy(arr[i]));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(f.pad.l, f.pad.t, f.pw, f.ph); ctx.clip();
      area(def.bands[0], def.bands[4], css('--viz-band-outer'));
      area(def.bands[1], def.bands[3], css('--viz-band-inner'));
      ctx.globalAlpha = 0.55;
      def.paths.forEach(function (p) { line(p, css('--viz-path'), 1); });
      ctx.globalAlpha = 1;
      line(xs.map(function (x) { return x * def.evPerGame; }), css('--viz-ev'), 2, [6, 4]);
      line(def.meanPath, css('--viz-mean'), 1.5, [2, 3]);
      line(def.bands[2], css('--viz-median'), 2);
      ctx.restore();

      chart.geom = f;
      /* copie sur un canvas hors écran (pas de relecture des pixels, contrairement à getImageData) */
      snapshot = snapshot || document.createElement('canvas');
      snapshot.width = chart.canvas.width;
      snapshot.height = chart.canvas.height;
      snapshot.getContext('2d').drawImage(chart.canvas, 0, 0);
      if (hoverIdx != null) drawHover(ctx, f, hoverIdx);
    };
    function drawHover(ctx, f, hoverIdx) {
      var x = f.sx(def.xs[hoverIdx]);
      ctx.strokeStyle = css('--viz-axis');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, f.pad.t); ctx.lineTo(x, f.pad.t + f.ph); ctx.stroke();
      ctx.fillStyle = css('--viz-median');
      ctx.strokeStyle = css('--viz-surface');
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, f.sy(def.bands[2][hoverIdx]), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    chart.hover = function (mx) {
      var f = chart.geom;
      if (!f) return;
      var xs = def.xs;
      var v = (mx - f.pad.l) / f.pw * xs[xs.length - 1];
      if (v < 0 || v > xs[xs.length - 1] * 1.02) { chart.tip.hidden = true; chart.clearHover(); return; }
      var i = nearestIndex(xs, v);
      chart.draw(i);
      var fy = def.fmtY;
      showTip(chart, f.sx(xs[i]), f.pad.t + f.ph / 2,
        '<b>' + fmtGames(xs[i]) + ' parties</b>' +
        '<div>95 % : ' + fy(def.bands[4][i]) + '</div>' +
        '<div>75 % : ' + fy(def.bands[3][i]) + '</div>' +
        '<div><b>Médiane : ' + fy(def.bands[2][i]) + '</b></div>' +
        '<div>25 % : ' + fy(def.bands[1][i]) + '</div>' +
        '<div>5 % : ' + fy(def.bands[0][i]) + '</div>' +
        '<div>Moyenne simulée : ' + fy(def.meanPath[i]) + '</div>' +
        '<div>EV théorique : ' + fy(def.evPerGame * xs[i]) + '</div>');
    };
    chart.draw(null);
  }

  /*
   * Histogramme d'un tableau trié. Les extrêmes (hors [clipLo, clipHi]) sont regroupés
   * dans la première / dernière barre pour ne pas écraser l'échelle.
   * def = { sorted, bins, fmt, clipLo, clipHi, markers:[{value,label}] }
   */
  function histogram(host, def) {
    var chart = setup(host);
    var s = def.sorted;
    var n = s.length;
    var lo = SpinModel.quantile(s, def.clipLo == null ? 0.005 : def.clipLo);
    var hi = SpinModel.quantile(s, def.clipHi == null ? 0.995 : def.clipHi);
    if (!(hi > lo)) hi = lo + 1;
    var nb = def.bins || 40;
    var width = (hi - lo) / nb;
    var counts = new Array(nb).fill(0);
    for (var i = 0; i < n; i++) {
      var b = Math.floor((s[i] - lo) / width);
      counts[Math.max(0, Math.min(nb - 1, b))]++;
    }
    var maxC = Math.max.apply(null, counts);
    chart.draw = function (hoverBin) {
      var c = prepareCanvas(chart);
      var ctx = c.ctx;
      var f = frame(ctx, c.w, c.h, [lo, hi], [0, maxC / n * 1.08], def.fmt, function (v) { return (v * 100).toFixed(v < 0.1 ? 1 : 0) + ' %'; });
      var bw = f.pw / nb;
      for (var k = 0; k < nb; k++) {
        var x0 = f.pad.l + k * bw + 1;
        var y0 = f.sy(counts[k] / n);
        var hgt = f.sy(0) - y0;
        ctx.fillStyle = k === hoverBin ? css('--viz-bar-hover') : css('--viz-bar');
        roundTop(ctx, x0, y0, Math.max(1, bw - 2), hgt, Math.min(4, (bw - 2) / 2));
      }
      var lastLabelX = -Infinity, labelRow = 0;
      (def.markers || []).slice().sort(function (a, b) { return a.value - b.value; }).forEach(function (m) {
        if (m.value < lo || m.value > hi) return;
        var x = Math.round(f.sx(m.value)) + 0.5;
        /* décale verticalement les libellés de marqueurs trop proches */
        labelRow = x - lastLabelX < 60 ? labelRow + 1 : 0;
        lastLabelX = x;
        ctx.strokeStyle = css('--viz-ev');
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, f.pad.t); ctx.lineTo(x, f.pad.t + f.ph); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = css('--viz-text');
        ctx.textAlign = x > f.pad.l + f.pw - 80 ? 'right' : 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(m.label, x + (ctx.textAlign === 'left' ? 5 : -5), f.pad.t + 2 + labelRow * 14);
      });
      chart.geom = f;
    };
    chart.hover = function (mx, my) {
      var f = chart.geom;
      if (!f) return;
      var k = Math.floor((mx - f.pad.l) / (f.pw / nb));
      if (k < 0 || k >= nb) { chart.tip.hidden = true; chart.draw(null); return; }
      chart.draw(k);
      var a = lo + k * width, z = a + width;
      var label = (k === 0 ? '≤ ' + def.fmt(z) : k === nb - 1 ? '≥ ' + def.fmt(a) : def.fmt(a) + ' → ' + def.fmt(z));
      showTip(chart, mx, my, '<b>' + label + '</b><div>' + (counts[k] / n * 100).toFixed(2) + ' % des simulations</div>');
    };
    chart.draw(null);
  }

  function roundTop(ctx, x, y, w, h, r) {
    if (h <= 0) return;
    r = Math.max(0, Math.min(r, h));
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  /* Courbe simple. def = { points:[[x,y]], fmtX, fmtTickX, fmtY, yMax, markers:[{x,label}] } */
  function curve(host, def) {
    var chart = setup(host);
    var pts = def.points;
    var xs = pts.map(function (p) { return p[0]; });
    chart.draw = function (hoverIdx) {
      var c = prepareCanvas(chart);
      var ctx = c.ctx;
      var f = frame(ctx, c.w, c.h, [xs[0], xs[xs.length - 1]], [0, def.yMax || 1], def.fmtTickX || def.fmtX, def.fmtY);
      ctx.strokeStyle = css('--viz-median');
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach(function (p, i) { if (i) ctx.lineTo(f.sx(p[0]), f.sy(p[1])); else ctx.moveTo(f.sx(p[0]), f.sy(p[1])); });
      ctx.stroke();
      (def.markers || []).forEach(function (m) {
        if (!(m.x >= xs[0] && m.x <= xs[xs.length - 1])) return;
        var x = Math.round(f.sx(m.x)) + 0.5;
        ctx.strokeStyle = css('--viz-ev');
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, f.pad.t); ctx.lineTo(x, f.pad.t + f.ph); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = css('--viz-text');
        ctx.textBaseline = 'top';
        ctx.textAlign = x > f.pad.l + f.pw - 90 ? 'right' : 'left';
        ctx.fillText(m.label, x + (ctx.textAlign === 'left' ? 5 : -5), f.pad.t + 2);
      });
      if (hoverIdx != null) {
        var p = pts[hoverIdx];
        ctx.fillStyle = css('--viz-median');
        ctx.strokeStyle = css('--viz-surface');
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.sx(p[0]), f.sy(p[1]), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      chart.geom = f;
    };
    chart.hover = function (mx) {
      var f = chart.geom;
      if (!f) return;
      var v = xs[0] + (mx - f.pad.l) / f.pw * (xs[xs.length - 1] - xs[0]);
      var i = nearestIndex(xs, v);
      chart.draw(i);
      showTip(chart, f.sx(xs[i]), f.sy(pts[i][1]), '<b>' + def.fmtX(xs[i]) + '</b><div>' + def.fmtY(pts[i][1]) + '</div>');
    };
    chart.draw(null);
  }

  function fmtGames(v) {
    if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' k';
    return String(Math.round(v));
  }

  function redrawAll() {
    registry.forEach(function (c) {
      if (c.draw && document.body.contains(c.el) && c.el.offsetParent !== null) c.draw(null);
    });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 120);
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', redrawAll);
  }

  return { bands: bands, histogram: histogram, curve: curve, redrawAll: redrawAll, fmtGames: fmtGames };
})();
