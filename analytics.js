(function (window, document) {
  'use strict';

  const script = document.currentScript;
  const TOKEN = '2ca9f8ac2f7238ac5af0ec0bbd259faf';
  const SDK_URL = 'https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js';
  const CONSENT_KEY = 'eclipseScout:analyticsConsent:v1';
  const surface = script && script.dataset.surface === 'app' ? 'app' : 'landing';
  const appVersion = (script && script.dataset.appVersion) || '2026.08.12.1';
  const isProduction = window.location.protocol === 'https:'
    && window.location.hostname === 'riccardobosioo.github.io'
    && window.location.pathname.indexOf('/eclipse-scout/') === 0;

  const allowedProperties = Object.freeze({
    landing_viewed: [],
    map_opened: ['entry_method', 'destination'],
    extension_downloaded: ['artifact_type'],
    app_opened: [],
    viewpoint_loaded: ['selection_method', 'eclipse_kind', 'eclipse_phase', 'obscuration_percent', 'sun_altitude_degrees'],
    viewpoint_load_failed: ['selection_method', 'failure_reason'],
    place_search_completed: ['is_successful', 'result_status', 'query_length_bucket', 'latency_bucket'],
    sun_view_centered: ['sun_altitude_degrees', 'camera_pitch_degrees', 'camera_zoom', 'horizontal_fov_degrees', 'eclipse_phase', 'obscuration_percent'],
    eclipse_time_selected: ['selection_method', 'preset_name', 'playback_action'],
    overlay_feedback_submitted: ['is_aligned', 'camera_pitch_degrees', 'camera_zoom', 'horizontal_fov_degrees', 'eclipse_phase', 'obscuration_percent', 'sun_altitude_degrees'],
    application_error_detected: ['error_code', 'component', 'action'],
  });

  let consent = readConsent();
  let sdkState = 'idle';
  let domReady = document.readyState !== 'loading';
  let pageOpenTracked = false;
  let pendingEvents = [];
  let consentPanel = null;

  const enums = Object.freeze({
    action: ['update_eclipse', 'initialize', 'load_script'],
    artifact_type: ['chrome_extension_zip'],
    component: ['astronomy', 'google_maps'],
    destination: ['web_app'],
    eclipse_kind: ['total', 'partial', 'annular', 'none'],
    eclipse_phase: ['totality', 'partial', 'none'],
    entry_method: ['primary_cta'],
    error_code: ['astronomy_search_failed', 'maps_auth_failed', 'maps_script_load_failed'],
    failure_reason: ['not_found', 'permission_or_quota', 'temporary_failure', 'invalid_request', 'service_unavailable', 'unknown_failure'],
    latency_bucket: ['under_300ms', '300_999ms', '1_3s', 'over_3s'],
    playback_action: ['started', 'stopped'],
    preset_name: ['partial_begin', 'totality_begin', 'maximum', 'partial_end'],
    query_length_bucket: ['empty', '1_10', '11_30', '31_60', 'over_60'],
    result_status: ['empty_query', 'result_found', 'not_found', 'permission_or_quota', 'temporary_failure', 'invalid_request', 'service_unavailable', 'unknown_failure'],
    selection_method: ['map', 'search', 'slider', 'preset', 'playback'],
  });

  function readConsent() {
    try {
      const value = window.localStorage.getItem(CONSENT_KEY);
      return value === 'granted' || value === 'denied' ? value : null;
    } catch (error) {
      return null;
    }
  }

  function persistConsent(value) {
    consent = value;
    try { window.localStorage.setItem(CONSENT_KEY, value); } catch (error) { /* session only */ }
  }

  function round(value, digits) {
    const factor = Math.pow(10, digits || 0);
    return Math.round(value * factor) / factor;
  }

  function viewportOrientation() {
    if (window.innerWidth === window.innerHeight) return 'square';
    return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  }

  function commonProperties() {
    return {
      platform: 'web',
      surface: surface,
      app_version: appVersion,
      viewport_orientation: viewportOrientation(),
      viewport_width: Math.round(window.innerWidth),
      viewport_height: Math.round(window.innerHeight),
      device_pixel_ratio: round(Number(window.devicePixelRatio) || 1, 2),
    };
  }

  function safeValue(name, value) {
    if (name === 'is_aligned' || name === 'is_successful') {
      return typeof value === 'boolean' ? value : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(enums, name)) {
      return typeof value === 'string' && enums[name].indexOf(value) !== -1 ? value : undefined;
    }
    const ranges = {
      camera_pitch_degrees: [-90, 90, 1],
      camera_zoom: [0, 5, 2],
      horizontal_fov_degrees: [1, 180, 1],
      obscuration_percent: [0, 100, 0],
      sun_altitude_degrees: [-90, 90, 1],
    };
    if (Object.prototype.hasOwnProperty.call(ranges, name) && typeof value === 'number' && Number.isFinite(value)) {
      const rule = ranges[name];
      return round(Math.max(rule[0], Math.min(rule[1], value)), rule[2]);
    }
    return undefined;
  }

  function sanitizeProperties(eventName, properties) {
    const clean = {};
    const allowed = allowedProperties[eventName] || [];
    const source = properties && typeof properties === 'object' ? properties : {};
    allowed.forEach((name) => {
      const value = safeValue(name, source[name]);
      if (value !== undefined) clean[name] = value;
    });
    return Object.assign(clean, commonProperties());
  }

  function sendEvent(item) {
    if (sdkState !== 'ready' || consent !== 'granted') return;
    const options = item.transport === 'sendBeacon' ? { transport: 'sendBeacon' } : undefined;
    window.mixpanel.track(item.name, item.properties, options);
  }

  function flushEvents() {
    const events = pendingEvents;
    pendingEvents = [];
    events.forEach(sendEvent);
  }

  function trackPageOpen() {
    if (!domReady || sdkState !== 'ready' || pageOpenTracked || consent !== 'granted') return;
    pageOpenTracked = true;
    track(surface === 'app' ? 'app_opened' : 'landing_viewed');
  }

  function activateSdk(instance) {
    if (consent !== 'granted') {
      sdkState = 'idle';
      pendingEvents = [];
      if (instance && typeof instance.opt_out_tracking === 'function') {
        instance.opt_out_tracking({ clear_persistence: true, delete_user: false });
      }
      return;
    }
    if (!instance || !instance.__loaded) {
      sdkState = 'idle';
      return;
    }
    instance.opt_in_tracking({ track: function () {} });
    instance.register({ platform: 'web', surface: surface, app_version: appVersion });
    sdkState = 'ready';
    trackPageOpen();
    flushEvents();
  }

  function mixpanelConfig() {
    return {
      api_host: 'https://api-eu.mixpanel.com',
      autocapture: false,
      debug: false,
      flags: false,
      // Il progetto è ospitato nel data residency cluster UE. Dopo un consenso
      // esplicito la scelta dell'utente prevale sul segnale DNT del browser.
      ignore_dnt: true,
      ip: false,
      opt_out_persistence_by_default: true,
      opt_out_tracking_by_default: true,
      opt_out_tracking_persistence_type: 'localStorage',
      persistence: 'localStorage',
      property_blacklist: [
        '$current_url', '$referrer', '$referring_domain', '$initial_referrer', '$initial_referring_domain',
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      ],
      record_sessions_percent: 0,
      remote_settings_mode: 'disabled',
      save_referrer: false,
      skip_first_touch_marketing: true,
      stop_utm_persistence: true,
      store_google: false,
      track_marketing: false,
      track_pageview: false,
      loaded: activateSdk,
    };
  }

  function installMixpanelStub() {
    if (window.mixpanel && window.mixpanel.__SV) return;
    const stub = window.mixpanel = window.mixpanel || [];
    stub._i = [];
    stub.init = function (token, config, name) {
      function stubMethod(target, method) {
        const parts = method.split('.');
        if (parts.length === 2) { target = target[parts[0]]; method = parts[1]; }
        target[method] = function () { target.push([method].concat(Array.prototype.slice.call(arguments))); };
      }
      let instance = stub;
      if (name !== undefined) instance = stub[name] = [];
      else name = 'mixpanel';
      instance.people = instance.people || [];
      instance.toString = function (people) { return 'mixpanel' + (name === 'mixpanel' ? '' : '.' + name) + (people ? '.people' : ''); };
      instance.people.toString = function () { return instance.toString(true); };
      const methods = 'disable time_event track track_pageview track_links track_forms track_with_groups add_group set_group remove_group register register_once alias unregister identify name_tag set_config reset opt_in_tracking opt_out_tracking has_opted_in_tracking has_opted_out_tracking clear_opt_in_out_tracking start_batch_senders'.split(' ');
      methods.forEach(function (method) { stubMethod(instance, method); });
      'set set_once union unset remove delete'.split(' ').forEach(function (method) { stubMethod(instance, 'people.' + method); });
      stub._i.push([token, config, name]);
    };
    stub.__SV = 1.2;
  }

  function loadSdk() {
    if (!isProduction || consent !== 'granted' || sdkState !== 'idle') return;
    sdkState = 'loading';
    if (window.mixpanel && window.mixpanel.__loaded) {
      activateSdk(window.mixpanel);
      return;
    }
    installMixpanelStub();
    window.mixpanel.init(TOKEN, mixpanelConfig());
    const sdk = document.createElement('script');
    sdk.async = true;
    sdk.src = SDK_URL;
    sdk.onerror = function () {
      sdkState = 'idle';
      pendingEvents = [];
      try { delete window.mixpanel; } catch (error) { window.mixpanel = undefined; }
      sdk.remove();
    };
    (document.head || document.documentElement).appendChild(sdk);
  }

  function track(eventName, properties, options) {
    if (!Object.prototype.hasOwnProperty.call(allowedProperties, eventName)) return false;
    if (!isProduction || consent !== 'granted') return false;
    const item = {
      name: eventName,
      properties: sanitizeProperties(eventName, properties),
      transport: options && options.transport,
    };
    if (sdkState === 'ready') sendEvent(item);
    else {
      if (pendingEvents.length < 50) pendingEvents.push(item);
      loadSdk();
    }
    return true;
  }

  function dispatchConsentChange() {
    window.dispatchEvent(new CustomEvent('eclipseanalytics:consentchange', {
      detail: { consent: consent },
    }));
  }

  function closePreferences() {
    if (consentPanel) consentPanel.hidden = true;
  }

  function setConsent(value) {
    if (value !== 'granted' && value !== 'denied') return false;
    persistConsent(value);
    closePreferences();

    if (value === 'granted') {
      if (sdkState === 'ready') window.mixpanel.opt_in_tracking({ track: function () {} });
      loadSdk();
      trackPageOpen();
    } else {
      pendingEvents = [];
      if (sdkState === 'ready') {
        window.mixpanel.opt_out_tracking({ clear_persistence: true, delete_user: false });
      }
    }
    dispatchConsentChange();
    return true;
  }

  function openPreferences() {
    if (!consentPanel) createConsentUi();
    if (!consentPanel) return;
    const closeButton = consentPanel.querySelector('[data-consent-close]');
    if (closeButton) closeButton.hidden = consent === null;
    consentPanel.hidden = false;
  }

  function createConsentUi() {
    if (consentPanel || !document.body) return;
    const style = document.createElement('style');
    style.textContent = [
      '#esAnalyticsConsent{position:fixed;z-index:10000;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));max-width:520px;margin:auto;padding:16px;background:#151a26;color:#f3f1ea;border:1px solid rgba(255,255,255,.2);border-radius:14px;box-shadow:0 14px 50px rgba(0,0,0,.55);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '#esAnalyticsConsent[hidden]{display:none}',
      '#esAnalyticsConsent h2{margin:0 28px 6px 0;font-size:16px;line-height:1.2}',
      '#esAnalyticsConsent p{margin:0 0 13px;color:#b9bfd0}',
      '#esAnalyticsConsent .es-consent-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '#esAnalyticsConsent button{min-height:44px;padding:0 14px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:transparent;color:#f3f1ea;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}',
      '#esAnalyticsConsent button[data-consent="granted"]{background:#ffa227;border-color:#ffa227;color:#150d02}',
      '#esAnalyticsConsent .es-consent-close{position:absolute;right:8px;top:8px;width:40px;padding:0;border:0;font-size:20px}',
      '#esAnalyticsConsent button:focus-visible{outline:3px solid rgba(255,162,39,.72);outline-offset:2px}',
    ].join('');
    document.head.appendChild(style);

    consentPanel = document.createElement('section');
    consentPanel.id = 'esAnalyticsConsent';
    consentPanel.setAttribute('role', 'dialog');
    consentPanel.setAttribute('aria-labelledby', 'esAnalyticsTitle');
    consentPanel.innerHTML =
      '<button class="es-consent-close" type="button" data-consent-close aria-label="Chiudi" hidden>×</button>' +
      '<h2 id="esAnalyticsTitle">Analytics anonimi</h2>' +
      '<p>Ci aiutano a capire se la mappa funziona e se il sole risulta allineato. Non registriamo lo schermo, le ricerche o la posizione scelta.</p>' +
      '<div class="es-consent-actions">' +
        '<button type="button" data-consent="granted">Accetta analytics</button>' +
        '<button type="button" data-consent="denied">Continua senza</button>' +
      '</div>';
    document.body.appendChild(consentPanel);

    consentPanel.querySelector('[data-consent="granted"]').addEventListener('click', function () { setConsent('granted'); });
    consentPanel.querySelector('[data-consent="denied"]').addEventListener('click', function () { setConsent('denied'); });
    consentPanel.querySelector('[data-consent-close]').addEventListener('click', closePreferences);
    document.querySelectorAll('[data-analytics-preferences]').forEach(function (button) {
      button.addEventListener('click', openPreferences);
    });

    consentPanel.hidden = consent !== null;
  }

  window.EclipseAnalytics = Object.freeze({
    getConsent: function () { return consent; },
    isReady: function () { return sdkState === 'ready' && consent === 'granted'; },
    openPreferences: openPreferences,
    setConsent: setConsent,
    track: track,
  });

  function onDomReady() {
    domReady = true;
    createConsentUi();
    trackPageOpen();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  else onDomReady();
  if (consent === 'granted') loadSdk();
})(window, document);
