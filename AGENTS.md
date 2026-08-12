# Analytics Tracking — Mixpanel

This project uses **Mixpanel** as the only product analytics system. Read this file before changing analytics code. Do not add another analytics SDK unless the user explicitly asks for it.

## Tech stack

| Detail | Value |
|---|---|
| Platform | Static HTML/CSS/JavaScript website |
| Mixpanel SDK | JavaScript Browser SDK loaded from the official CDN |
| SDK version | `mixpanel-2-latest.min.js` |
| Data residency | EU — `https://api-eu.mixpanel.com` |
| Tracking method | Direct client-side, through `window.EclipseAnalytics` |
| CDP | None |
| Consent required | Yes — explicit opt-in before the SDK is downloaded |
| Token location | `analytics.js` → `TOKEN` (a browser project token is public by design) |

## Initialization and privacy

Mixpanel is initialized once in `analytics.js`. Feature code must call `window.EclipseAnalytics.track()` and must never call `mixpanel.track()` directly.

- Production tracking is enabled only on HTTPS, host `riccardobosioo.github.io`, path `/eclipse-scout/`.
- The consent choice is stored as `eclipseScout:analyticsConsent:v1` with value `granted` or `denied`.
- Before opt-in, no Mixpanel SDK or event request is made and earlier actions are not replayed later.
- Autocapture, automatic page views, Session Replay, marketing/referrer persistence and IP geolocation are disabled.
- Consent can be changed through “Preferenze analytics” on both pages.
- The site has no accounts: identity stays anonymous. Do not call `identify()`, `people.set()` or `reset()` unless authentication is added later and this file is updated first.

Never send coordinates, searched text, formatted addresses, panorama IDs, camera heading/azimuth, free-form errors, stack traces or PII. Event and property allowlists live in `analytics.js`; unknown values are discarded.

## Tracking plan

All names and properties use `snake_case`. Common properties are `platform`, `surface`, `app_version`, `viewport_orientation`, `viewport_width`, `viewport_height` and `device_pixel_ratio`.

| Event | Trigger | Event properties | File |
|---|---|---|---|
| `landing_viewed` | Landing becomes trackable after consent | common only | `analytics.js` |
| `map_opened` | Primary landing CTA is clicked | `entry_method`, `destination` | `index.html` |
| `extension_downloaded` | Extension ZIP link is clicked | `artifact_type` | `index.html` |
| `app_opened` | App becomes trackable after consent | common only | `analytics.js` |
| `viewpoint_loaded` | User-selected Street View succeeds | `selection_method`, `eclipse_kind`, `eclipse_phase`, `obscuration_percent`, `sun_altitude_degrees` | `app.html` |
| `viewpoint_load_failed` | User-selected Street View fails | `selection_method`, `failure_reason` | `app.html` |
| `place_search_completed` | Search validation/geocoding completes | `is_successful`, `result_status`, `query_length_bucket`, `latency_bucket` | `app.html` |
| `sun_view_centered` | “Guarda verso il sole” is used | safe camera/solar metrics; never heading | `app.html` |
| `eclipse_time_selected` | Slider, preset or playback is used | `selection_method`, `preset_name`, `playback_action` | `app.html` |
| `overlay_feedback_submitted` | User answers whether the overlay is aligned | `is_aligned` plus safe camera/solar metrics | `app.html` |
| `application_error_detected` | A known application failure occurs | stable `error_code`, `component`, `action` only | `app.html` |

## Rules for changes

1. Reuse an existing event whenever its meaning matches.
2. Add new events and properties to the allowlist in `analytics.js` and to the table above.
3. Track outcomes after success/failure, not noisy intermediate callbacks.
4. Keep slider tracking on `change`; never track continuous `input`, `pov_changed` or render loops.
5. Run syntax checks and verify that no request is made before consent.
6. Check the event in the Mixpanel dashboard after publishing.
