// Eclipse Scout — overlay sole/luna su Google Maps & Street View
//
// Fonti del punto di vista (POV):
//   - lat/lng, pitch (tilt), fov  → dall'URL (@lat,lng,3a,75y,Hh,Tt) — aggiornato da Google a fine gesto
//   - heading                     → LIVE dalla bussola di Street View (ruota in tempo reale durante il drag);
//                                   fallback all'URL se la bussola non è agganciabile.
// Astronomia topocentrica con astronomy-engine; fasi eclissi calcolate per il punto osservato.
(function () {
  'use strict';
  if (window.__eclipseScoutLoaded) return;
  window.__eclipseScoutLoaded = true;

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const AU_KM = 1.496e8;

  const norm360 = (a) => ((a % 360) + 360) % 360;
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

  // ---------- Stato ----------
  const state = {
    date: new Date(2026, 7, 12, 20, 29, 40), // default: massimo eclissi Spagna (ora locale)
    showSunPath: true,
    showMoon: true,
    playing: false,
    hidden: false, // true mentre pitch/fov sono inaffidabili (drag verticale / zoom in corso)
    lastURL: '',
    lastRect: null,
    cam: null, // { lat, lng, mode, heading(URL), pitch, hfov }
    eclipse: null,
    eclipseKey: '',
    pathCache: { key: '', pts: [] },
    cal: { heading: 0, pitch: 0 }, // calibrazione manuale (⌥+trascina)
  };
  try {
    const saved = JSON.parse(localStorage.getItem('eclipseScoutCal') || 'null');
    if (saved) state.cal = saved;
  } catch (e) { /* ignore */ }

  // ---------- Parsing URL ----------
  function parseURL() {
    const href = location.href;
    let m = href.match(/@(-?[\d.]+),(-?[\d.]+),(?:[\d.]+a,)?([\d.]+)y,([\d.]+)h,([\d.]+)t/);
    if (m) {
      return {
        mode: 'streetview',
        lat: +m[1], lng: +m[2],
        hfov: +m[3], heading: +m[4], pitch: +m[5] - 90,
      };
    }
    m = href.match(/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
    if (m) return { mode: 'map', lat: +m[1], lng: +m[2] };
    return null;
  }

  // ---------- Bussola live ----------
  // La bussola di Street View ruota in tempo reale col drag: da lì leggiamo l'heading vivo.
  // La convenzione (segno/offset) viene imparata automaticamente confrontando con l'URL
  // ogni volta che l'URL si aggiorna: così resiste ai cambi di markup/convenzione di Google.
  const compass = { el: null, sign: 1, offset: 0, good: false };

  function findCompassEl() {
    if (compass.el && compass.el.isConnected) return compass.el;
    compass.el = null;
    const sels = ['[aria-label*="ompass" i]', '[aria-label*="ussola" i]', '.widget-compass', '#compass', '[class*="compass" i]', '[jsaction*="compass" i]'];
    const cands = [];
    for (const s of sels) {
      try { document.querySelectorAll(s).forEach((el) => cands.push(el)); } catch (e) { /* selettore non valido */ }
    }
    for (const root of cands) {
      const els = [root, ...root.querySelectorAll('*')];
      for (const el of els) {
        const t = getComputedStyle(el).transform;
        if (t && t !== 'none' && t.startsWith('matrix(')) { compass.el = el; return el; }
      }
    }
    return null;
  }

  function compassAngle() {
    const el = findCompassEl();
    if (!el) return null;
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none' || !t.startsWith('matrix(')) return null;
    const m = t.slice(7, -1).split(',').map(parseFloat);
    return Math.atan2(m[1], m[0]) * R2D;
  }

  function learnCompass(urlHeading) {
    const a = compassAngle();
    if (a === null) { compass.good = false; return; }
    let best = null;
    for (const sign of [1, -1]) {
      for (const off of [0, 180]) {
        const err = angDiff(urlHeading, norm360(sign * a + off));
        if (!best || err < best.err) best = { sign, off, err };
      }
    }
    if (best && best.err < 8) {
      compass.sign = best.sign; compass.offset = best.off; compass.good = true;
    } else {
      compass.good = false;
    }
  }

  function liveHeading() {
    const cam = state.cam;
    if (!cam) return 0;
    if (compass.good) {
      const a = compassAngle();
      if (a !== null) return norm360(compass.sign * a + compass.offset);
    }
    return cam.heading;
  }

  // ---------- Riquadro del panorama ----------
  function getViewRect() {
    if (state.cam && state.cam.mode === 'streetview') {
      const c = document.querySelector('canvas.widget-scene-canvas');
      if (c) {
        const r = c.getBoundingClientRect();
        if (r.width > 200 && r.height > 200) return r;
      }
      let best = null;
      for (const el of document.querySelectorAll('canvas')) {
        if (el.id === 'eclipse-scout-canvas') continue;
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.height > 200 && (!best || r.width * r.height > best.width * best.height)) best = r;
      }
      if (best) return best;
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  // ---------- Astronomia ----------
  function observer(lat, lng) { return new Astronomy.Observer(lat, lng, 200); }

  function bodyPos(body, date, lat, lng) {
    const obs = observer(lat, lng);
    const eq = Astronomy.Equator(body, date, obs, true, true);
    const hor = Astronomy.Horizon(date, obs, eq.ra, eq.dec, 'normal');
    return { az: hor.azimuth, alt: hor.altitude, distAU: eq.dist };
  }
  const sunPos = (d, lat, lng) => bodyPos(Astronomy.Body.Sun, d, lat, lng);
  const moonPos = (d, lat, lng) => bodyPos(Astronomy.Body.Moon, d, lat, lng);

  function angularSep(a, b) {
    const a1 = a.alt * D2R, a2 = b.alt * D2R, dAz = (a.az - b.az) * D2R;
    const c = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dAz);
    return Math.acos(Math.min(1, Math.max(-1, c))) * R2D;
  }
  const sunRadiusDeg = (p) => R2D * Math.asin(695700 / (p.distAU * AU_KM));
  const moonRadiusDeg = (p) => R2D * Math.asin(1737.4 / (p.distAU * AU_KM));

  function obscurationFrac(sep, rs, rm) {
    if (sep >= rs + rm) return 0;
    if (sep <= Math.abs(rm - rs)) return rm >= rs ? 1 : (rm * rm) / (rs * rs);
    const x = (sep * sep + rs * rs - rm * rm) / (2 * sep);
    const y = Math.sqrt(Math.max(0, rs * rs - x * x));
    const areaA = rs * rs * Math.acos(Math.min(1, Math.max(-1, x / rs))) - x * y;
    const xb = sep - x;
    const areaB = rm * rm * Math.acos(Math.min(1, Math.max(-1, xb / rm))) - xb * y;
    return (areaA + areaB) / (Math.PI * rs * rs);
  }

  function phaseAt(date, lat, lng) {
    const s = sunPos(date, lat, lng), m = moonPos(date, lat, lng);
    const sep = angularSep(s, m), rs = sunRadiusDeg(s), rm = moonRadiusDeg(m);
    const frac = obscurationFrac(sep, rs, rm);
    let phase = 'none';
    if (frac >= 1) phase = 'totality';
    else if (frac > 0) phase = 'partial';
    return { s, m, sep, rs, rm, frac, phase };
  }

  function updateLocalEclipse(lat, lng) {
    const key = lat.toFixed(2) + ',' + lng.toFixed(2);
    if (key === state.eclipseKey) return;
    state.eclipseKey = key;
    try {
      const start = new Date(state.date.getTime() - 3 * 86400000);
      state.eclipse = Astronomy.SearchLocalSolarEclipse(start, observer(lat, lng));
    } catch (e) { state.eclipse = null; }
    updatePresets();
  }

  // ---------- Proiezione ----------
  function effCam(cam) {
    return { heading: liveHeading() + state.cal.heading, pitch: cam.pitch + state.cal.pitch, hfov: cam.hfov };
  }
  // Il fov "y" dell'URL è il fov VERTICALE del riquadro. Determinato empiricamente
  // (two-view solve su screenshot reali: fov verticale misurato 75.1° con URL 75y).
  function focal(cam, rect) { return (rect.height / 2) / Math.tan((cam.hfov / 2) * D2R); }

  function project(azDeg, altDeg, cam, rect) {
    const az = azDeg * D2R, alt = altDeg * D2R;
    const v = [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
    const hd = cam.heading * D2R, pt = cam.pitch * D2R;
    const fwd = [Math.sin(hd) * Math.cos(pt), Math.cos(hd) * Math.cos(pt), Math.sin(pt)];
    const right = [Math.cos(hd), -Math.sin(hd), 0];
    const up = [-Math.sin(hd) * Math.sin(pt), -Math.cos(hd) * Math.sin(pt), Math.cos(pt)];
    const d = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
    if (d <= 0.05) return null;
    const x = (v[0] * right[0] + v[1] * right[1] + v[2] * right[2]) / d;
    const y = (v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / d;
    const f = focal(cam, rect);
    return { x: rect.left + rect.width / 2 + x * f, y: rect.top + rect.height / 2 - y * f };
  }

  // ---------- Canvas ----------
  const canvas = document.createElement('canvas');
  canvas.id = 'eclipse-scout-canvas';
  document.documentElement.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    render();
  }
  window.addEventListener('resize', resize);

  // ---------- Disegno ----------
  function drawSunMarker(x, y, phase, rPx) {
    ctx.save();
    const glow = ctx.createRadialGradient(x, y, 2, x, y, 30);
    const col = phase === 'totality' ? '255,60,60' : phase === 'partial' ? '255,150,40' : '255,200,40';
    glow.addColorStop(0, `rgba(${col},0.85)`);
    glow.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, 30, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = phase === 'totality' ? '#111' : `rgb(${col})`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(4, rPx), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  function drawMoonDisc(x, y, rPx) {
    ctx.save();
    ctx.fillStyle = 'rgba(40,45,60,0.75)';
    ctx.beginPath(); ctx.arc(x, y, Math.max(4, rPx), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(200,205,220,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  function label(text, x, y, color) {
    ctx.save();
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color || '#fff';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function fmtTime(d) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function getDayPath(lat, lng) {
    const day = new Date(state.date); day.setHours(0, 0, 0, 0);
    const key = day.toDateString() + '|' + lat.toFixed(3) + ',' + lng.toFixed(3);
    if (state.pathCache.key === key) return state.pathCache.pts;
    const pts = [];
    for (let min = 0; min < 1440; min += 5) {
      const t = new Date(day.getTime() + min * 60000);
      const s = sunPos(t, lat, lng);
      if (s.alt < -6) continue;
      let phase = 'none';
      if (state.eclipse && Math.abs(t - state.eclipse.peak.time.date) < 2.5 * 3600000) {
        const m = moonPos(t, lat, lng);
        const frac = obscurationFrac(angularSep(s, m), sunRadiusDeg(s), moonRadiusDeg(m));
        phase = frac >= 1 ? 'totality' : frac > 0 ? 'partial' : 'none';
      }
      pts.push({ min, az: s.az, alt: s.alt, phase });
    }
    state.pathCache = { key, pts };
    return pts;
  }

  function renderStreetView(cam0, rect) {
    const { lat, lng } = cam0;
    const cam = effCam(cam0);
    const f = focal(cam, rect);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top, rect.width, rect.height);
    ctx.clip();

    // Linea orizzonte (alt = 0°)
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let az = 0; az <= 360; az += 2) {
      const p = project(az, 0, cam, rect);
      if (p) { started ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); started = true; }
      else started = false;
    }
    ctx.stroke();
    ctx.restore();

    // Traiettoria del sole
    if (state.showSunPath) {
      const day = new Date(state.date); day.setHours(0, 0, 0, 0);
      const pts = getDayPath(lat, lng);
      let prev = null;
      for (const pt of pts) {
        const p = project(pt.az, pt.alt, cam, rect);
        if (p && prev && prev.p && pt.min - prev.min === 5) {
          ctx.strokeStyle = pt.phase === 'totality' ? 'rgba(255,60,60,0.95)'
            : pt.phase === 'partial' ? 'rgba(255,150,40,0.9)'
            : pt.alt < 0 ? 'rgba(255,200,40,0.25)' : 'rgba(255,200,40,0.7)';
          ctx.lineWidth = pt.phase === 'none' ? 2 : 4;
          ctx.setLineDash(pt.alt < 0 ? [4, 4] : []);
          ctx.beginPath(); ctx.moveTo(prev.p.x, prev.p.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          ctx.setLineDash([]);
        }
        if (p && pt.min % 60 === 0) {
          const t = new Date(day.getTime() + pt.min * 60000);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
          label(fmtTime(t), p.x + 6, p.y - 6, 'rgba(255,230,150,0.95)');
        }
        prev = { min: pt.min, p };
      }
    }

    // Sole + luna al tempo selezionato (dischi in scala reale)
    const ph = phaseAt(state.date, lat, lng);
    const ps = project(ph.s.az, ph.s.alt, cam, rect);
    const pm = project(ph.m.az, ph.m.alt, cam, rect);
    const rsPx = f * Math.tan(ph.rs * D2R);
    const rmPx = f * Math.tan(ph.rm * D2R);

    if (ps) {
      drawSunMarker(ps.x, ps.y, ph.phase, rsPx);
      label('Sole ' + fmtTime(state.date) + '  az ' + ph.s.az.toFixed(0) + '° / alt ' + ph.s.alt.toFixed(1) + '°', ps.x + 18, ps.y - 12);
      if (ph.s.alt < 0) label('(sotto l\'orizzonte)', ps.x + 18, ps.y + 2, '#faa');
    }
    if (state.showMoon && pm) {
      drawMoonDisc(pm.x, pm.y, rmPx);
      if (ph.sep > ph.rs + ph.rm) label('Luna ' + ph.m.alt.toFixed(1) + '°', pm.x + 14, pm.y + 4, '#cdd3e0');
    }

    if (!ps && ph.s.alt > -10) {
      const dAz = ((ph.s.az - cam.heading + 540) % 360) - 180;
      const txt = dAz > 0 ? 'Sole a destra →  (' + Math.abs(dAz).toFixed(0) + '°)' : '← Sole a sinistra  (' + Math.abs(dAz).toFixed(0) + '°)';
      ctx.font = 'bold 15px -apple-system, sans-serif';
      const tw = ctx.measureText(txt).width;
      label(txt, dAz > 0 ? rect.left + rect.width - tw - 24 : rect.left + 24, rect.top + rect.height / 2, '#ffd54a');
    }

    ctx.restore();
    updateReadout(ph);
  }

  function renderMap(cam, rect) {
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const L = Math.min(rect.width, rect.height) * 0.32;
    const ph = phaseAt(state.date, cam.lat, cam.lng);

    function ray(az, colStroke, dash) {
      const dx = Math.sin(az * D2R), dy = -Math.cos(az * D2R);
      ctx.save();
      ctx.strokeStyle = colStroke; ctx.lineWidth = 3;
      if (dash) ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * L, cy + dy * L); ctx.stroke();
      ctx.restore();
      return { x: cx + dx * L, y: cy + dy * L };
    }

    const e1 = ray(ph.s.az, ph.s.alt >= 0 ? 'rgba(255,190,30,0.95)' : 'rgba(255,190,30,0.35)');
    drawSunMarker(e1.x, e1.y, ph.phase, 9);
    label('Sole az ' + ph.s.az.toFixed(0) + '° / alt ' + ph.s.alt.toFixed(1) + '°', e1.x + 16, e1.y, '#ffe08a');

    if (state.showMoon) {
      const e2 = ray(ph.m.az, 'rgba(190,200,220,0.8)', true);
      drawMoonDisc(e2.x, e2.y, 8);
    }
    updateReadout(ph);
  }

  function render() {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    const cam = state.cam;
    if (!cam || state.hidden) return;
    updateLocalEclipse(cam.lat, cam.lng);
    const rect = getViewRect();
    state.lastRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (cam.mode === 'streetview') renderStreetView(cam, rect);
    else renderMap(cam, rect);
  }

  // ---------- Pannello ----------
  const panel = document.createElement('div');
  panel.id = 'eclipse-scout-panel';
  panel.innerHTML = `
    <div class="es-header">🌘 Eclipse Scout <span class="es-mode"></span><button class="es-min" title="riduci">–</button></div>
    <div class="es-body">
      <input type="datetime-local" class="es-dt" step="60">
      <input type="range" class="es-slider" min="0" max="1439" step="1">
      <div class="es-presets"></div>
      <div class="es-readout"></div>
      <div class="es-toggles">
        <label><input type="checkbox" class="es-path" checked> traiettoria sole</label>
        <label><input type="checkbox" class="es-moon" checked> luna</label>
      </div>
      <div class="es-note es-eclipse-info"></div>
      <div class="es-note"><span class="es-compass-status"></span></div>
      <div class="es-note">⌥+trascina per allineare l'overlay al panorama · ⌥+doppio clic per reset. <span class="es-cal"></span></div>
    </div>`;
  document.documentElement.appendChild(panel);

  const $ = (s) => panel.querySelector(s);
  const dtInput = $('.es-dt'), slider = $('.es-slider'), readout = $('.es-readout');

  function toLocalInputValue(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function syncInputs() {
    dtInput.value = toLocalInputValue(state.date);
    slider.value = state.date.getHours() * 60 + state.date.getMinutes();
  }
  syncInputs();

  function setDate(d) { state.date = d; syncInputs(); render(); }

  dtInput.addEventListener('input', () => { if (dtInput.value) setDate(new Date(dtInput.value)); });
  slider.addEventListener('input', () => {
    const d = new Date(state.date);
    d.setHours(Math.floor(slider.value / 60), slider.value % 60, 0, 0);
    state.date = d; dtInput.value = toLocalInputValue(d); render();
  });

  function updatePresets() {
    const box = $('.es-presets');
    box.innerHTML = '';
    const e = state.eclipse;
    const mk = (labelTxt, cls, date, seconds) => {
      const b = document.createElement('button');
      b.textContent = labelTxt;
      if (cls) b.className = cls;
      b.addEventListener('click', () => {
        const d = new Date(date);
        if (!seconds) d.setSeconds(0, 0);
        setDate(d);
      });
      box.appendChild(b);
    };
    if (e) {
      mk('Parziale ' + fmtTime(e.partial_begin.time.date), '', e.partial_begin.time.date);
      if (e.kind === 'total' && e.total_begin) {
        mk('TOTALITÀ ' + fmtTime(e.total_begin.time.date), 'es-tot', e.total_begin.time.date, true);
      } else {
        mk('MAX ' + fmtTime(e.peak.time.date) + ' (' + Math.round(e.obscuration * 100) + '%)', 'es-partialmax', e.peak.time.date, true);
      }
      mk('Fine ' + fmtTime(e.partial_end.time.date), '', e.partial_end.time.date);
    }
    const play = document.createElement('button');
    play.className = 'es-play'; play.textContent = state.playing ? '⏸' : '▶';
    play.addEventListener('click', togglePlay);
    box.appendChild(play);

    const info = $('.es-eclipse-info');
    if (e) {
      info.innerHTML = e.kind === 'total'
        ? '✅ Questo punto è nella <b>fascia di totalità</b> (' + fmtTime(e.total_begin.time.date) + '–' + fmtTime(e.total_end.time.date) + ', max ' + fmtTime(e.peak.time.date) + ')'
        : '⚠️ Qui l\'eclissi è solo <b>parziale</b> (max ' + Math.round(e.obscuration * 100) + '% alle ' + fmtTime(e.peak.time.date) + ') — spostati nella fascia di totalità';
    } else info.textContent = '';
  }

  let playTimer = null;
  function togglePlay() {
    state.playing = !state.playing;
    const btn = $('.es-play'); if (btn) btn.textContent = state.playing ? '⏸' : '▶';
    if (state.playing) {
      playTimer = setInterval(() => {
        state.date = new Date(state.date.getTime() + 60000);
        syncInputs(); render();
      }, 120);
    } else clearInterval(playTimer);
  }

  $('.es-path').addEventListener('change', (e) => { state.showSunPath = e.target.checked; render(); });
  $('.es-moon').addEventListener('change', (e) => { state.showMoon = e.target.checked; render(); });
  $('.es-min').addEventListener('click', () => panel.classList.toggle('es-collapsed'));

  function updateReadout(ph) {
    const cover = Math.round(ph.frac * 100);
    const phaseTxt = ph.phase === 'totality' ? '<b class="es-red">● TOTALITÀ</b>'
      : ph.phase === 'partial' ? '<b class="es-orange">◐ parziale ' + cover + '%</b>' : '';
    readout.innerHTML =
      '☀️ az ' + ph.s.az.toFixed(1) + '° · alt ' + ph.s.alt.toFixed(1) + '°' +
      (ph.s.alt < 0 ? ' <span class="es-red">(sotto orizzonte)</span>' : '') + '<br>' +
      '🌙 az ' + ph.m.az.toFixed(1) + '° · alt ' + ph.m.alt.toFixed(1) + '°<br>' +
      'sep ' + ph.sep.toFixed(3) + '° · copertura sole ' + cover + '% ' + phaseTxt;
    const cal = $('.es-cal');
    cal.textContent = (state.cal.heading || state.cal.pitch)
      ? 'Δh ' + state.cal.heading.toFixed(1) + '° Δp ' + state.cal.pitch.toFixed(1) + '°' : '';
  }

  function updateCompassStatus() {
    const el = $('.es-compass-status');
    if (state.cam && state.cam.mode === 'streetview') {
      el.textContent = compass.good ? '🧭 bussola agganciata: overlay segue la rotazione in tempo reale'
        : '🧭 bussola non trovata: l\'overlay si aggiorna a fine trascinamento';
    } else el.textContent = '';
  }

  // ---------- Gesti sul panorama ----------
  // Rotazione orizzontale: heading live dalla bussola → overlay resta visibile e segue.
  // Drag verticale (pitch) o rotella (fov): quei valori arrivano solo dall'URL a fine gesto → nascondi.
  let unhideTimer = null;
  function hideOverlay() {
    if (state.cam && state.cam.mode === 'streetview' && !state.hidden) {
      state.hidden = true;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }
  function scheduleUnhide(ms) {
    clearTimeout(unhideTimer);
    unhideTimer = setTimeout(() => {
      if (state.hidden) { state.hidden = false; render(); }
    }, ms);
  }

  let svPointer = null;
  window.addEventListener('pointerdown', (e) => {
    if (e.altKey || panel.contains(e.target)) return;
    if (!state.cam || state.cam.mode !== 'streetview') return;
    svPointer = { y: e.clientY };
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!svPointer || state.hidden) return;
    // il pitch cambia solo col drag verticale: se scende/sale parecchio, il nostro pitch (da URL) è stantio
    if (Math.abs(e.clientY - svPointer.y) > 48) hideOverlay();
  }, true);
  window.addEventListener('pointerup', () => {
    if (svPointer && state.hidden) scheduleUnhide(1200); // fallback se l'URL non si aggiorna
    svPointer = null;
  }, true);
  window.addEventListener('wheel', (e) => {
    if (panel.contains(e.target)) return;
    if (!state.cam || state.cam.mode !== 'streetview') return;
    // lo zoom cambia il fov: l'URL si aggiorna con calma a fine animazione.
    // Restiamo nascosti finché non arriva (il tick ci fa ricomparire al cambio URL);
    // il timer è solo un paracadute se l'URL non cambia (es. zoom già al limite).
    hideOverlay();
    scheduleUnhide(2500);
  }, { capture: true, passive: true });

  // ---------- Calibrazione: ⌥ (Alt) + trascina ----------
  let dragging = null;
  window.addEventListener('keydown', (e) => {
    if (e.altKey) { canvas.style.pointerEvents = 'auto'; canvas.style.cursor = 'move'; }
  });
  window.addEventListener('keyup', (e) => {
    if (!e.altKey) { canvas.style.pointerEvents = 'none'; canvas.style.cursor = ''; dragging = null; }
  });
  window.addEventListener('blur', () => {
    canvas.style.pointerEvents = 'none'; canvas.style.cursor = ''; dragging = null;
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.altKey || !state.cam || state.cam.mode !== 'streetview') return;
    dragging = { x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault(); e.stopPropagation();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !state.cam) return;
    const rect = state.lastRect || getViewRect();
    const f = focal(effCam(state.cam), rect);
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    state.cal.heading -= Math.atan(dx / f) * R2D;
    state.cal.pitch += Math.atan(dy / f) * R2D;
    dragging = { x: e.clientX, y: e.clientY };
    localStorage.setItem('eclipseScoutCal', JSON.stringify(state.cal));
    render();
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  canvas.addEventListener('dblclick', (e) => {
    if (!e.altKey) return;
    state.cal = { heading: 0, pitch: 0 };
    localStorage.setItem('eclipseScoutCal', JSON.stringify(state.cal));
    render();
  });

  // ---------- Loop: URL + bussola + riquadro ----------
  let lastRenderedHeading = null;

  function rectChanged(a, b) {
    if (!a || !b) return true;
    return Math.abs(a.left - b.left) > 1 || Math.abs(a.top - b.top) > 1
      || Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1;
  }

  function tick() {
    if (location.href !== state.lastURL) {
      state.lastURL = location.href;
      state.cam = parseURL();
      state.hidden = false; // URL assestato: pitch/fov di nuovo affidabili
      clearTimeout(unhideTimer);
      if (state.cam && state.cam.mode === 'streetview') learnCompass(state.cam.heading);
      $('.es-mode').textContent = state.cam ? (state.cam.mode === 'streetview' ? 'Street View' : 'mappa') : 'in attesa…';
      updateCompassStatus();
      render();
      lastRenderedHeading = liveHeading();
      return;
    }
    if (state.hidden || !state.cam) return;
    // heading live: se la bussola ruota (drag in corso o inerzia), ridisegna subito
    if (state.cam.mode === 'streetview' && compass.good) {
      const h = liveHeading();
      if (lastRenderedHeading === null || angDiff(h, lastRenderedHeading) > 0.2) {
        lastRenderedHeading = h;
        render();
        return;
      }
    }
    // riquadro cambiato (sidebar aperta/chiusa, resize interno) → ridisegna
    const r = getViewRect();
    if (rectChanged(r, state.lastRect)) render();
  }
  setInterval(tick, 80);
  resize();
  tick();
  updateCompassStatus();

  // hook di debug per i test dell'harness
  window.__eclipseScoutDebug = {
    state, compass,
    liveHeading, compassAngle,
    effHeading: () => (state.cam ? effCam(state.cam).heading : null),
  };
})();
