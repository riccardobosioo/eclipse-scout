(function (window, document) {
  'use strict';

  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const AU_KM = 1.496e8;
  const CALIBRATION_KEY = 'eclipseScout:arCalibration:v1';
  const DEFAULT_DATE = new Date('2026-08-12T20:29:40+02:00');
  const SEARCH_START = new Date('2026-08-09T00:00:00+02:00');
  const $ = (selector) => document.querySelector(selector);

  const video = $('#camera');
  const canvas = $('#overlay');
  const ctx = canvas.getContext('2d');
  const slider = $('#timeSlider');

  const state = {
    started: false,
    starting: false,
    date: initialDate(),
    position: null,
    locationAccuracy: null,
    eclipse: null,
    pathCache: { key: '', points: [] },
    showPath: true,
    stream: null,
    watchId: null,
    wakeLock: null,
    rawBasis: null,
    filteredBasis: null,
    orientationSource: 'none',
    compassAccuracy: null,
    compassNeedsCalibration: false,
    lastAbsoluteAt: 0,
    lastFrameAt: 0,
    lastDrawAt: 0,
    lastStatusUpdate: 0,
    animationFrame: 0,
    phaseCache: { key: '', value: null },
  };

  const calibration = loadCalibration();

  function initialDate() {
    const raw = new URLSearchParams(window.location.search).get('t');
    if (!raw) return new Date(DEFAULT_DATE);
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) return new Date(DEFAULT_DATE);
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(parsed);
    return day === '2026-08-12' ? parsed : new Date(DEFAULT_DATE);
  }

  function loadCalibration() {
    const defaults = { heading: 0, pitch: 0, fov: 72 };
    try {
      const saved = JSON.parse(window.localStorage.getItem(CALIBRATION_KEY));
      if (!saved || typeof saved !== 'object') return defaults;
      return {
        heading: clamp(Number(saved.heading) || 0, -45, 45),
        pitch: clamp(Number(saved.pitch) || 0, -30, 30),
        fov: clamp(Number(saved.fov) || 72, 45, 100),
      };
    } catch (error) {
      return defaults;
    }
  }

  function saveCalibration() {
    try { window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration)); }
    catch (error) { /* la calibrazione resta valida per questa sessione */ }
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function norm360(value) { return ((value % 360) + 360) % 360; }
  function wrap180(value) { return ((value + 540) % 360) - 180; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scale(v, factor) { return [v[0] * factor, v[1] * factor, v[2] * factor]; }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function length(v) { return Math.hypot(v[0], v[1], v[2]); }
  function normalize(v) {
    const magnitude = length(v);
    return magnitude > 1e-8 ? scale(v, 1 / magnitude) : [0, 0, 0];
  }
  function lerp(a, b, amount) {
    return [
      a[0] + (b[0] - a[0]) * amount,
      a[1] + (b[1] - a[1]) * amount,
      a[2] + (b[2] - a[2]) * amount,
    ];
  }

  function orthonormalize(basis) {
    const forward = normalize(basis.forward);
    let right = subtract(basis.right, scale(forward, dot(basis.right, forward)));
    right = normalize(right);
    if (length(right) < .5) return basis;
    const up = normalize(cross(right, forward));
    return { forward, right, up };
  }

  function rotateAroundAxis(vector, axis, radians) {
    const unit = normalize(axis);
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return add(
      add(scale(vector, cosine), scale(cross(unit, vector), sine)),
      scale(unit, dot(unit, vector) * (1 - cosine))
    );
  }

  /* Una variazione positiva ruota il punto di vista in senso orario rispetto
     al nord: nord (0°) -> est (90°). */
  function rotateHeadingVector(vector, degrees) {
    const radians = degrees * D2R;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return [
      vector[0] * cosine + vector[1] * sine,
      -vector[0] * sine + vector[1] * cosine,
      vector[2],
    ];
  }

  function rotateHeadingBasis(basis, degrees) {
    return {
      forward: rotateHeadingVector(basis.forward, degrees),
      right: rotateHeadingVector(basis.right, degrees),
      up: rotateHeadingVector(basis.up, degrees),
    };
  }

  function headingOf(vector) { return norm360(Math.atan2(vector[0], vector[1]) * R2D); }
  function pitchOf(vector) { return Math.atan2(vector[2], Math.hypot(vector[0], vector[1])) * R2D; }

  /* Matrice W3C DeviceOrientation Z-X'-Y''. Le colonne sono gli assi fisici
     del telefono nel frame Terra: x est, y nord, z cielo. La camera posteriore
     guarda lungo -Z. Conservare tutti e tre gli assi evita il bug di pitch/roll
     che faceva muovere l'orizzonte in direzione opposta. */
  function sensorBasis(alphaDeg, betaDeg, gammaDeg, screenAngleOverride) {
    const alpha = alphaDeg * D2R;
    const beta = betaDeg * D2R;
    const gamma = gammaDeg * D2R;
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const cb = Math.cos(beta), sb = Math.sin(beta);
    const cg = Math.cos(gamma), sg = Math.sin(gamma);

    const deviceX = [
      ca * cg - sa * sb * sg,
      sa * cg + ca * sb * sg,
      -cb * sg,
    ];
    const deviceY = [
      -cb * sa,
      ca * cb,
      sb,
    ];
    const deviceZ = [
      cg * sa * sb + ca * sg,
      sa * sg - ca * cg * sb,
      cb * cg,
    ];

    const screenAngle = finite(screenAngleOverride)
      ? screenAngleOverride
      : finite(window.screen.orientation && window.screen.orientation.angle)
        ? window.screen.orientation.angle
        : (finite(window.orientation) ? window.orientation : 0);
    // ScreenOrientation.angle è la rotazione dello schermo rispetto alla posa
    // naturale: per riportare gli assi device in quelli visivi serve l'inversa.
    const theta = -screenAngle * D2R;
    const cosine = Math.cos(theta), sine = Math.sin(theta);
    const right = add(scale(deviceX, cosine), scale(deviceY, sine));
    const up = add(scale(deviceX, -sine), scale(deviceY, cosine));
    const forward = scale(deviceZ, -1);
    return orthonormalize({ forward, right, up });
  }

  function basisFromEvent(event, source) {
    if (!finite(event.alpha) || !finite(event.beta) || !finite(event.gamma)) return null;
    let basis = sensorBasis(event.alpha, event.beta, event.gamma);
    let orientationSource = source;
    let accuracy = null;

    if (finite(event.webkitCompassHeading)) {
      const horizontal = Math.hypot(basis.forward[0], basis.forward[1]);
      if (horizontal > .08) {
        const correction = wrap180(event.webkitCompassHeading - headingOf(basis.forward));
        basis = rotateHeadingBasis(basis, correction);
      }
      orientationSource = 'ios_compass';
      accuracy = finite(event.webkitCompassAccuracy) ? event.webkitCompassAccuracy : null;
    } else if (source === 'absolute' || event.absolute === true) {
      orientationSource = 'absolute';
    } else {
      orientationSource = 'relative';
    }

    return { basis: orthonormalize(basis), source: orientationSource, accuracy };
  }

  function applyCalibration(basis) {
    if (!basis) return null;
    let adjusted = rotateHeadingBasis(basis, calibration.heading);
    const radians = calibration.pitch * D2R;
    adjusted = {
      forward: rotateAroundAxis(adjusted.forward, adjusted.right, radians),
      right: adjusted.right,
      up: rotateAroundAxis(adjusted.up, adjusted.right, radians),
    };
    return orthonormalize(adjusted);
  }

  function smoothBasis(previous, next, elapsedSeconds) {
    if (!previous) return next;
    const amount = 1 - Math.exp(-elapsedSeconds / .09);
    let forward = normalize(lerp(previous.forward, next.forward, amount));
    let right = normalize(lerp(previous.right, next.right, amount));
    right = normalize(subtract(right, scale(forward, dot(right, forward))));
    const up = normalize(cross(right, forward));
    return { forward, right, up };
  }

  function handleOrientationSample(event, source) {
    const sample = basisFromEvent(event, source);
    if (!sample) return;
    if (sample.source === 'ios_compass' && finite(sample.accuracy) && sample.accuracy < 0) {
      state.compassNeedsCalibration = true;
      state.orientationSource = 'invalid_compass';
      state.compassAccuracy = sample.accuracy;
      return;
    }
    state.compassNeedsCalibration = false;
    if (source === 'absolute') state.lastAbsoluteAt = performance.now();
    if (source === 'relative' && sample.source !== 'ios_compass'
      && performance.now() - state.lastAbsoluteAt < 1200) return;
    state.rawBasis = sample.basis;
    state.orientationSource = sample.source;
    state.compassAccuracy = sample.accuracy;
  }

  function onAbsoluteOrientation(event) { handleOrientationSample(event, 'absolute'); }
  function onRelativeOrientation(event) { handleOrientationSample(event, 'relative'); }

  function removeOrientationListeners() {
    window.removeEventListener('deviceorientationabsolute', onAbsoluteOrientation, true);
    window.removeEventListener('deviceorientation', onRelativeOrientation, true);
  }

  async function requestOrientation() {
    if (typeof window.DeviceOrientationEvent === 'undefined') {
      throw new Error('Questo browser non espone i sensori di orientamento.');
    }
    if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
      // `true` richiede anche il riferimento assoluto/magnetometro nei browser
      // che implementano la firma W3C moderna; Safari legacy ignora l'argomento.
      const result = await window.DeviceOrientationEvent.requestPermission(true);
      if (result !== 'granted') throw new Error('Permesso movimento e bussola non concesso.');
    }
    removeOrientationListeners();
    window.addEventListener('deviceorientationabsolute', onAbsoluteOrientation, true);
    window.addEventListener('deviceorientation', onRelativeOrientation, true);
  }

  function positionPromise() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('La geolocalizzazione non è disponibile in questo browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (error) => {
        const message = error.code === 1
          ? 'Permesso posizione non concesso.'
          : error.code === 3
            ? 'Il GPS non ha risposto in tempo. Prova all’aperto.'
            : 'Posizione non disponibile. Prova all’aperto.';
        reject(new Error(message));
      }, { enableHighAccuracy: true, timeout: 18000, maximumAge: 10000 });
    });
  }

  function setPosition(position) {
    const coords = position && position.coords;
    if (!coords || !finite(coords.latitude) || !finite(coords.longitude)) return;
    const old = state.position;
    state.position = { lat: coords.latitude, lng: coords.longitude };
    state.locationAccuracy = finite(coords.accuracy) ? Math.round(coords.accuracy) : null;
    if (!old || Math.abs(old.lat - state.position.lat) > .0002 || Math.abs(old.lng - state.position.lng) > .0002) {
      state.pathCache.key = '';
      updateLocalEclipse();
    }
  }

  function startLocationWatch() {
    if (!navigator.geolocation || state.watchId !== null) return;
    state.watchId = navigator.geolocation.watchPosition(setPosition, () => {}, {
      enableHighAccuracy: true, timeout: 20000, maximumAge: 5000,
    });
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('La fotocamera web non è disponibile in questo browser.');
    }
    stopCamera();
    const videoDefaults = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    let stream;
    let usedFallback = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: Object.assign({ facingMode: { exact: 'environment' } }, videoDefaults),
      });
    } catch (error) {
      if (error && error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw error;
      usedFallback = true;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: Object.assign({ facingMode: { ideal: 'environment' } }, videoDefaults),
      });
    }
    const track = stream.getVideoTracks()[0];
    const facingMode = track && track.getSettings ? track.getSettings().facingMode : '';
    if (facingMode === 'user' || (usedFallback && facingMode !== 'environment')) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('Non riesco a confermare la fotocamera posteriore su questo browser.');
    }
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) {
      await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
    }
  }

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    video.srcObject = null;
  }

  function waitForSensor(timeoutMilliseconds) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const check = () => {
        if (state.rawBasis && state.orientationSource !== 'relative'
          && state.orientationSource !== 'invalid_compass' && !state.compassNeedsCalibration) resolve();
        else if (performance.now() - startedAt > timeoutMilliseconds) {
          reject(new Error(state.orientationSource === 'relative'
            ? 'Il browser fornisce solo orientamento relativo, senza nord reale. Prova Safari su iPhone o Chrome su Android.'
            : state.orientationSource === 'invalid_compass'
              ? 'La bussola non è calibrata. Muovi il telefono a forma di 8 e riprova.'
            : 'Nessun dato dalla bussola. Muovi il telefono e riprova.'));
        } else setTimeout(check, 100);
      };
      check();
    });
  }

  function setPermission(id, status, label) {
    const row = $(id);
    row.classList.toggle('ok', status === 'ok');
    row.classList.toggle('error', status === 'error');
    row.querySelector('.state').textContent = label;
  }

  async function requestWakeLock() {
    if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); }
    catch (error) { /* non essenziale */ }
  }

  async function startExperience() {
    if (state.starting) return;
    const button = $('#startAr');
    state.starting = true;
    state.started = false;
    state.rawBasis = null;
    state.filteredBasis = null;
    state.orientationSource = 'none';
    state.compassAccuracy = null;
    state.compassNeedsCalibration = false;
    state.lastAbsoluteAt = 0;
    button.disabled = true;
    button.textContent = 'Attivazione…';
    $('#setupError').textContent = '';

    if (!window.isSecureContext) {
      $('#setupError').textContent = 'Serve un collegamento HTTPS per fotocamera, GPS e bussola.';
      state.starting = false;
      button.disabled = false;
      button.textContent = 'Riprova';
      return;
    }

    try {
      setPermission('#permOrientation', 'pending', 'richiesta…');
      try {
        await requestOrientation();
        setPermission('#permOrientation', 'ok', 'consentita');
      } catch (error) {
        setPermission('#permOrientation', 'error', 'bloccata');
        throw error;
      }

      setPermission('#permLocation', 'pending', 'richiesta…');
      try {
        const position = await positionPromise();
        setPosition(position);
        setPermission('#permLocation', 'ok', state.locationAccuracy ? '±' + state.locationAccuracy + ' m' : 'attiva');
      } catch (error) {
        setPermission('#permLocation', 'error', 'bloccata');
        throw error;
      }

      setPermission('#permCamera', 'pending', 'richiesta…');
      try {
        await startCamera();
        setPermission('#permCamera', 'ok', 'attiva');
      } catch (error) {
        setPermission('#permCamera', 'error', 'bloccata');
        throw new Error(error && error.name === 'NotAllowedError'
          ? 'Permesso fotocamera non concesso.'
          : error && error.message
            ? error.message
            : 'Impossibile avviare la fotocamera posteriore.');
      }

      await waitForSensor(5500);
      state.started = true;
      $('#setup').hidden = true;
      $('#dock').hidden = false;
      updateLocalEclipse();
      syncTimeUi();
      startLocationWatch();
      requestWakeLock();
      state.lastFrameAt = performance.now();
      cancelAnimationFrame(state.animationFrame);
      state.animationFrame = requestAnimationFrame(renderFrame);
    } catch (error) {
      stopCamera();
      removeOrientationListeners();
      state.rawBasis = null;
      state.filteredBasis = null;
      if (state.watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
      }
      $('#setupError').textContent = error && error.message ? error.message : 'Non sono riuscito ad avviare la modalità AR.';
      button.textContent = 'Riprova';
      button.disabled = false;
    } finally {
      state.starting = false;
    }
  }

  /* ---------- Astronomia ---------- */
  const observer = (lat, lng) => new Astronomy.Observer(lat, lng, 200);
  function bodyPos(body, date, lat, lng) {
    const obs = observer(lat, lng);
    const equatorial = Astronomy.Equator(body, date, obs, true, true);
    const horizon = Astronomy.Horizon(date, obs, equatorial.ra, equatorial.dec, 'normal');
    return { az: horizon.azimuth, alt: horizon.altitude, distAU: equatorial.dist };
  }
  const sunPos = (date, lat, lng) => bodyPos(Astronomy.Body.Sun, date, lat, lng);
  const moonPos = (date, lat, lng) => bodyPos(Astronomy.Body.Moon, date, lat, lng);
  function angularSeparation(a, b) {
    const a1 = a.alt * D2R, a2 = b.alt * D2R, deltaAzimuth = (a.az - b.az) * D2R;
    const cosine = Math.sin(a1) * Math.sin(a2)
      + Math.cos(a1) * Math.cos(a2) * Math.cos(deltaAzimuth);
    return Math.acos(clamp(cosine, -1, 1)) * R2D;
  }
  const sunRadius = (position) => R2D * Math.asin(695700 / (position.distAU * AU_KM));
  const moonRadius = (position) => R2D * Math.asin(1737.4 / (position.distAU * AU_KM));
  function obscuredFraction(separation, sunR, moonR) {
    if (separation >= sunR + moonR) return 0;
    if (separation <= Math.abs(moonR - sunR)) return moonR >= sunR ? 1 : (moonR * moonR) / (sunR * sunR);
    const x = (separation * separation + sunR * sunR - moonR * moonR) / (2 * separation);
    const y = Math.sqrt(Math.max(0, sunR * sunR - x * x));
    const area1 = sunR * sunR * Math.acos(clamp(x / sunR, -1, 1)) - x * y;
    const x2 = separation - x;
    const area2 = moonR * moonR * Math.acos(clamp(x2 / moonR, -1, 1)) - x2 * y;
    return (area1 + area2) / (Math.PI * sunR * sunR);
  }
  function phaseAt(date, lat, lng) {
    const sun = sunPos(date, lat, lng);
    const moon = moonPos(date, lat, lng);
    const separation = angularSeparation(sun, moon);
    const sunR = sunRadius(sun), moonR = moonRadius(moon);
    const fraction = obscuredFraction(separation, sunR, moonR);
    return {
      sun, moon, sunR, moonR, fraction,
      phase: fraction >= .9995 ? 'totality' : fraction > 0 ? 'partial' : 'none',
    };
  }

  function currentPhase() {
    if (!state.position) return null;
    const key = state.date.getTime() + '|' + state.position.lat.toFixed(5) + ',' + state.position.lng.toFixed(5);
    if (state.phaseCache.key !== key) {
      state.phaseCache = {
        key,
        value: phaseAt(state.date, state.position.lat, state.position.lng),
      };
    }
    return state.phaseCache.value;
  }

  function updateLocalEclipse() {
    if (!state.position) return;
    try {
      state.eclipse = Astronomy.SearchLocalSolarEclipse(
        SEARCH_START,
        observer(state.position.lat, state.position.lng)
      );
    } catch (error) {
      state.eclipse = null;
    }
    buildPresets();
  }

  function madridMinutes(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour').value);
    const minute = Number(parts.find((part) => part.type === 'minute').value);
    return hour * 60 + minute;
  }

  function dateAtMadridMinutes(minutes) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
    const minute = String(minutes % 60).padStart(2, '0');
    return new Date('2026-08-12T' + hour + ':' + minute + ':00+02:00');
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  function buildPresets() {
    const container = $('#presets');
    container.innerHTML = '';
    const eclipse = state.eclipse;
    if (!eclipse) return;
    const entries = [
      { label: 'inizio', date: eclipse.partial_begin.time.date, className: '' },
      eclipse.kind === 'total' && eclipse.total_begin
        ? { label: 'totalità', date: eclipse.total_begin.time.date, className: 'peak' }
        : { label: 'massimo', date: eclipse.peak.time.date, className: 'peak' },
      { label: 'fine', date: eclipse.partial_end.time.date, className: '' },
    ];
    entries.forEach((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = entry.className;
      button.append(document.createTextNode(entry.label));
      const strong = document.createElement('b');
      strong.textContent = formatTime(entry.date);
      button.appendChild(strong);
      button.addEventListener('click', () => {
        state.date = new Date(entry.date);
        syncTimeUi();
      });
      container.appendChild(button);
    });

    const begin = madridMinutes(eclipse.partial_begin.time.date);
    const end = madridMinutes(eclipse.partial_end.time.date);
    slider.min = String(Math.max(0, begin - 15));
    slider.max = String(Math.min(1439, end + 15));
  }

  function getDayPath() {
    if (!state.position) return [];
    const key = state.position.lat.toFixed(4) + ',' + state.position.lng.toFixed(4);
    if (state.pathCache.key === key) return state.pathCache.points;
    const points = [];
    for (let minutes = 0; minutes < 1440; minutes += 5) {
      const date = dateAtMadridMinutes(minutes);
      const sun = sunPos(date, state.position.lat, state.position.lng);
      if (sun.alt >= -4) points.push({ minutes, date, az: sun.az, alt: sun.alt });
    }
    state.pathCache = { key, points };
    return points;
  }

  /* ---------- Proiezione e disegno ---------- */
  function optics() {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) return null;
    const width = window.innerWidth, height = window.innerHeight;
    const videoDiagonal = Math.hypot(videoWidth, videoHeight);
    const focalVideo = videoDiagonal / (2 * Math.tan(calibration.fov * D2R / 2));
    const coverScale = Math.max(width / videoWidth, height / videoHeight);
    return {
      fx: focalVideo * coverScale,
      fy: focalVideo * coverScale,
      cx: width / 2,
      cy: height / 2,
    };
  }

  function targetVector(azimuthDegrees, altitudeDegrees) {
    const azimuth = azimuthDegrees * D2R;
    const altitude = altitudeDegrees * D2R;
    return [
      Math.cos(altitude) * Math.sin(azimuth),
      Math.cos(altitude) * Math.cos(azimuth),
      Math.sin(altitude),
    ];
  }

  function project(azimuth, altitude, basis, cameraOptics) {
    const target = targetVector(azimuth, altitude);
    const depth = dot(target, basis.forward);
    if (depth <= .045) return null;
    const x = cameraOptics.cx + dot(target, basis.right) / depth * cameraOptics.fx;
    const y = cameraOptics.cy - dot(target, basis.up) / depth * cameraOptics.fy;
    return finite(x) && finite(y) ? { x, y, depth } : null;
  }

  function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = window.innerWidth, height = window.innerHeight;
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  function pointUsable(point, width, height) {
    return point && point.x > -2 * width && point.x < 3 * width
      && point.y > -2 * height && point.y < 3 * height;
  }

  function label(text, x, y, color, size, align) {
    ctx.save();
    ctx.font = '750 ' + (size || 12) + 'px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = align || 'left';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,.82)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color || '#f7f4eb';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawHorizon(basis, cameraOptics, width, height) {
    ctx.save();
    ctx.strokeStyle = 'rgba(247,244,235,.68)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    let previous = null;
    for (let azimuth = 0; azimuth <= 360; azimuth += 2) {
      const point = project(azimuth, 0, basis, cameraOptics);
      if (pointUsable(point, width, height)) {
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < width) ctx.lineTo(point.x, point.y);
        else ctx.moveTo(point.x, point.y);
        previous = point;
      } else previous = null;
    }
    ctx.stroke();
    ctx.restore();

    const north = project(0, 0, basis, cameraOptics);
    if (pointUsable(north, width, height)) label('N', north.x, north.y - 8, '#d8e1ff', 11, 'center');
  }

  function eclipsePhaseForDate(date) {
    const eclipse = state.eclipse;
    if (!eclipse) return 'none';
    const time = date.getTime();
    if (eclipse.kind === 'total' && eclipse.total_begin && eclipse.total_end
      && time >= eclipse.total_begin.time.date.getTime() && time <= eclipse.total_end.time.date.getTime()) return 'totality';
    if (time >= eclipse.partial_begin.time.date.getTime() && time <= eclipse.partial_end.time.date.getTime()) return 'partial';
    return 'none';
  }

  function drawPath(basis, cameraOptics, width, height) {
    if (!state.showPath) return;
    const peakMinutes = state.eclipse ? madridMinutes(state.eclipse.peak.time.date) : madridMinutes(state.date);
    let previous = null;
    ctx.lineCap = 'round';
    for (const item of getDayPath()) {
      if (Math.abs(item.minutes - peakMinutes) > 150) { previous = null; continue; }
      const point = project(item.az, item.alt, basis, cameraOptics);
      const usable = pointUsable(point, width, height);
      if (usable && previous && item.minutes - previous.minutes === 5
        && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) < width * .7) {
        const phase = eclipsePhaseForDate(item.date);
        ctx.strokeStyle = phase === 'totality' ? 'rgba(255,91,91,.98)'
          : phase === 'partial' ? 'rgba(255,162,39,.94)'
          : 'rgba(255,190,100,.55)';
        ctx.lineWidth = phase === 'none' ? 2.5 : 4;
        ctx.beginPath();
        ctx.moveTo(previous.point.x, previous.point.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      if (usable && item.minutes % 30 === 0) {
        ctx.fillStyle = 'rgba(247,244,235,.92)';
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        if (item.minutes % 60 === 0) label(formatTime(item.date), point.x + 7, point.y - 7, '#ffd49a', 10);
      }
      previous = usable ? { point, minutes: item.minutes } : null;
    }
  }

  function drawSunAndMoon(phase, basis, cameraOptics, width, height) {
    const sunPoint = project(phase.sun.az, phase.sun.alt, basis, cameraOptics);
    const moonPoint = project(phase.moon.az, phase.moon.alt, basis, cameraOptics);
    const visibleSun = sunPoint && sunPoint.x > -60 && sunPoint.x < width + 60
      && sunPoint.y > -60 && sunPoint.y < height + 60;

    if (sunPoint && pointUsable(sunPoint, width, height)) {
      const rawRadius = cameraOptics.fx * Math.tan(phase.sunR * D2R);
      const radius = clamp(rawRadius, 6, 50);
      const glow = ctx.createRadialGradient(sunPoint.x, sunPoint.y, 1, sunPoint.x, sunPoint.y, radius * 6);
      glow.addColorStop(0, phase.phase === 'totality' ? 'rgba(255,245,220,.75)' : 'rgba(255,205,115,.8)');
      glow.addColorStop(1, 'rgba(255,162,39,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sunPoint.x, sunPoint.y, radius * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = phase.phase === 'totality' ? '#080910' : '#ffc45c';
      ctx.beginPath();
      ctx.arc(sunPoint.x, sunPoint.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = phase.phase === 'totality' ? '#fff7e7' : '#fff2c4';
      ctx.lineWidth = 2;
      ctx.stroke();
      const tag = phase.phase === 'totality' ? 'TOTALITÀ'
        : phase.fraction > 0 ? Math.round(phase.fraction * 100) + '%' : formatTime(state.date);
      label(tag, sunPoint.x + radius + 8, sunPoint.y - radius - 4,
        phase.phase === 'totality' ? '#ff9b9b' : '#ffd49a', 13);
      label(phase.sun.alt.toFixed(1) + '° sull’orizzonte', sunPoint.x + radius + 8, sunPoint.y - radius + 13, '#f7f4eb', 10);
    }

    if (moonPoint && pointUsable(moonPoint, width, height)) {
      const rawRadius = cameraOptics.fx * Math.tan(phase.moonR * D2R);
      const radius = clamp(rawRadius, 6, 50);
      ctx.fillStyle = 'rgba(12,15,24,.72)';
      ctx.beginPath();
      ctx.arc(moonPoint.x, moonPoint.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(205,215,235,.9)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    const hint = $('#offscreenHint');
    if (visibleSun) hint.textContent = '';
    else {
      const headingDifference = wrap180(phase.sun.az - headingOf(basis.forward));
      const pitchDifference = phase.sun.alt - pitchOf(basis.forward);
      if (Math.abs(headingDifference) > 12) hint.textContent = headingDifference > 0 ? 'Il Sole è a destra →' : '← Il Sole è a sinistra';
      else hint.textContent = pitchDifference > 0 ? 'Il Sole è più in alto ↑' : 'Il Sole è più in basso ↓';
    }
  }

  function updateStatus(basis, now) {
    if (now - state.lastStatusUpdate < 300) return;
    state.lastStatusUpdate = now;
    const chip = $('#sensorChip');
    const relative = state.orientationSource === 'relative';
    const magnetic = state.orientationSource === 'ios_compass';
    const invalidCompass = state.orientationSource === 'invalid_compass';
    const lowAccuracy = finite(state.compassAccuracy) && state.compassAccuracy > 25;
    chip.classList.toggle('warning', relative || magnetic || invalidCompass || lowAccuracy);
    const accuracyText = state.locationAccuracy ? ' · GPS ±' + state.locationAccuracy + ' m' : '';
    $('#sensorStatus').textContent = invalidCompass
      ? 'muovi il telefono a forma di 8'
      : relative
      ? 'bussola relativa · calibra' + accuracyText
      : lowAccuracy
        ? 'precisione bussola bassa' + accuracyText
        : magnetic
          ? 'nord magnetico · calibra' + accuracyText
          : 'nord magnetico · calibra' + accuracyText;
    $('#debug').textContent = 'direzione ' + headingOf(basis.forward).toFixed(1) + '° · inclinazione '
      + pitchOf(basis.forward).toFixed(1) + '° · sorgente ' + state.orientationSource
      + '\ncorrezione ' + calibration.heading.toFixed(1) + '° / ' + calibration.pitch.toFixed(1)
      + '° · FOV diagonale ' + calibration.fov.toFixed(0) + '°';
  }

  function renderFrame(now) {
    state.animationFrame = requestAnimationFrame(renderFrame);
    if (!state.started || !state.position || !state.rawBasis) return;
    const elapsed = clamp((now - state.lastFrameAt) / 1000, .001, .1);
    state.lastFrameAt = now;
    state.filteredBasis = smoothBasis(state.filteredBasis, state.rawBasis, elapsed);
    if (now - state.lastDrawAt < 32) return;
    state.lastDrawAt = now;
    const basis = applyCalibration(state.filteredBasis);
    const cameraOptics = optics();
    if (!cameraOptics || !basis) return;
    const size = resizeCanvas();
    ctx.clearRect(0, 0, size.width, size.height);
    drawHorizon(basis, cameraOptics, size.width, size.height);
    drawPath(basis, cameraOptics, size.width, size.height);
    const phase = currentPhase();
    drawSunAndMoon(phase, basis, cameraOptics, size.width, size.height);
    updateStatus(basis, now);
  }

  function syncTimeUi() {
    const minutes = madridMinutes(state.date);
    slider.value = String(clamp(minutes, Number(slider.min), Number(slider.max)));
    $('#clock').textContent = formatTime(state.date);
    if (!state.position) return;
    const phase = currentPhase();
    const cover = $('#cover');
    cover.innerHTML = '<span>sole coperto</span>' + Math.round(phase.fraction * 100) + '%';
    cover.classList.toggle('total', phase.phase === 'totality');
  }

  function syncCalibrationUi() {
    $('#headingOffset').value = String(calibration.heading);
    $('#pitchOffset').value = String(calibration.pitch);
    $('#cameraFov').value = String(calibration.fov);
    $('#headingValue').textContent = calibration.heading.toFixed(1) + '°';
    $('#pitchValue').textContent = calibration.pitch.toFixed(1) + '°';
    $('#fovValue').textContent = calibration.fov.toFixed(0) + '°';
  }

  function openCalibration(open) {
    $('#calibration').hidden = !open;
    if (open) syncCalibrationUi();
  }

  function runMathSelfCheck() {
    const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
    const north = sensorBasis(0, 90, 0);
    const east = sensorBasis(270, 90, 0);
    // Landscape ruotato a destra: senza l'inversa di ScreenOrientation gli
    // assi risultano specchiati (right=ovest, up=terra).
    const landscapeNorth = sensorBasis(270, 0, 90, 270);
    const testOptics = { fx: 500, fy: 500, cx: 200, cy: 400 };
    const northCenter = project(0, 0, north, testOptics);
    const pitched = {
      forward: rotateAroundAxis(north.forward, north.right, 10 * D2R),
      right: north.right,
      up: rotateAroundAxis(north.up, north.right, 10 * D2R),
    };
    const pitchedHorizon = project(0, 0, orthonormalize(pitched), testOptics);
    return near(headingOf(north.forward), 0, .01)
      && near(pitchOf(north.forward), 0, .01)
      && near(headingOf(east.forward), 90, .01)
      && near(headingOf(landscapeNorth.forward), 0, .01)
      && dot(landscapeNorth.right, [1, 0, 0]) > .999
      && dot(landscapeNorth.up, [0, 0, 1]) > .999
      && northCenter && near(northCenter.x, 200, .01) && near(northCenter.y, 400, .01)
      && pitchedHorizon && pitchedHorizon.y > 400;
  }

  slider.addEventListener('input', () => {
    state.date = dateAtMadridMinutes(Number(slider.value));
    syncTimeUi();
  });
  $('#startAr').addEventListener('click', startExperience);
  $('#calibrateTop').addEventListener('click', () => openCalibration(true));
  $('#openCalibration').addEventListener('click', () => openCalibration(true));
  $('#closeCalibration').addEventListener('click', () => openCalibration(false));
  $('#togglePath').addEventListener('click', (event) => {
    state.showPath = !state.showPath;
    event.currentTarget.setAttribute('aria-pressed', state.showPath ? 'true' : 'false');
  });

  $('#headingOffset').addEventListener('input', (event) => {
    calibration.heading = Number(event.target.value);
    syncCalibrationUi();
    saveCalibration();
  });
  $('#pitchOffset').addEventListener('input', (event) => {
    calibration.pitch = Number(event.target.value);
    syncCalibrationUi();
    saveCalibration();
  });
  $('#cameraFov').addEventListener('input', (event) => {
    calibration.fov = Number(event.target.value);
    syncCalibrationUi();
    saveCalibration();
  });
  $('#setHorizon').addEventListener('click', () => {
    const basis = applyCalibration(state.filteredBasis || state.rawBasis);
    if (!basis) return;
    calibration.pitch = clamp(calibration.pitch - pitchOf(basis.forward), -30, 30);
    syncCalibrationUi();
    saveCalibration();
  });
  $('#resetCalibration').addEventListener('click', () => {
    calibration.heading = 0;
    calibration.pitch = 0;
    calibration.fov = 72;
    syncCalibrationUi();
    saveCalibration();
  });

  window.addEventListener('orientationchange', () => { state.filteredBasis = null; });
  if (window.screen.orientation) window.screen.orientation.addEventListener('change', () => { state.filteredBasis = null; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.started) requestWakeLock();
  });
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(state.animationFrame);
    removeOrientationListeners();
    stopCamera();
    if (state.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.watchId);
    if (state.wakeLock) state.wakeLock.release().catch(() => {});
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });

  const mathCheckPassed = runMathSelfCheck();
  document.documentElement.dataset.arMathCheck = mathCheckPassed ? 'ok' : 'failed';
  if (!mathCheckPassed) {
    $('#setupError').textContent = 'Controllo interno orientamento non riuscito. Ricarica la pagina.';
    $('#startAr').disabled = true;
  }
  syncCalibrationUi();
  syncTimeUi();
})(window, document);
