# Cart — Інтерактивна векторна карта України

Production-grade, GPU-accelerated vector map of Ukraine. Built on MapLibre GL JS
with a fully custom OpenMapTiles-schema style and a mobile-first responsive
shell. No bundler, no API keys — open `index.html` and you're rendering.

## Stack

- **MapLibre GL JS 5.x** — WebGL-based vector tile renderer
- **PMTiles 4.x** — protocol registered for static archive support
- **OpenFreeMap** — live OpenMapTiles vector tiles, no API keys
- Native ES modules — no bundler required

## Run

Anywhere you can serve a static directory:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .

# Caddy
caddy file-server --listen :8080
```

Then open `http://localhost:8080/`.

## Design

### Style as data

Roads are described by a config table (`src/style/roads.js`) — each road class
declares its zoom-driven width curve, colours, casing extra width, and dash
treatment. Layer specs are generated from that table. Re-tuning the map's
"feel" is a matter of editing the table; you never touch boilerplate.

The same is true for the rest of the style — every module reads design tokens
from `src/style/tokens.js`. Re-theming is a one-file change.

### Multi-tier road network

Roads render in three brunnel passes (tunnel → ground → bridge), with a
casing+inline pair per class within each pass. This gives crisp intersections,
stacks bridges over surface roads, and lets tunnels read as dashed underlays.
Width curves use exponential interpolation so the network looks proportional
all the way from zoom 5 (national overview) to zoom 22 (kerb-level detail).

### Adaptive label system

Labels are the cartographic heart of the project:

- **Fade-in opacity**. Every place / road / POI label uses an opacity ramp
  centred on its target zoom, so names *grow in* over half a zoom level
  rather than popping. This is built once via the local `fadeIn(atZoom)`
  helper in `src/style/labels.js`.
- **Variable anchors**. Towns, villages, hamlets, neighbourhoods and POIs
  use `text-variable-anchor: ['top','bottom','left','right',…]` so MapLibre
  can try multiple positions before giving up — measurably more labels
  survive in dense urban areas.
- **Priority via `symbol-sort-key`**. The OpenMapTiles `rank` field flows
  straight into `symbol-sort-key`, so when MapLibre arbitrates collisions
  the more important place wins.
- **Density profile**. Mobile devices receive a tighter `rank` cutoff,
  larger `text-padding` and a lower POI density automatically (see below).
- **Localisation**. Names prefer `name:uk`, then `name:en`, then the raw
  `name`. The map reads as native Ukrainian but is legible internationally.

### Device-aware performance profiles

`src/device.js` scores the browser environment (touch, hover, DPR, memory,
cores, network, save-data, prefers-reduced-motion) and derives a
`'high' | 'medium' | 'low'` profile at boot. The profile drives:

| Knob                 | high  | medium | low   |
| -------------------- | ----- | ------ | ----- |
| `maxTileCacheSize`   | 512   | 256    | 128   |
| `fadeDuration` (ms)  | 220   | 160    | 100   |
| `antialias`          | on    | on     | off   |
| `buildings3D`        | on    | on     | off   |
| `labelDensity`       | 1.0   | 0.85   | 0.65  |
| `placeRankCutoff`    | 12    | 10     | 7     |
| `poiRankCutoff`      | 6     | 5      | 4     |
| `textPaddingMul`     | 1.0   | 1.15   | 1.35  |
| `enableHamlets`      | on    | on     | off   |
| `enableNeighbourhoods` | on  | on     | off   |

The user can override the auto choice from the **Quality** segmented
control in the sidebar (`Auto`, `High`, `Eco`).

### Cross-platform UX

A three-tier responsive layout:

| Viewport             | Sidebar form            | Native controls hitbox |
| -------------------- | ----------------------- | ---------------------- |
| ≥ 960px (desktop)    | Permanent left rail     | 36×36                  |
| 540–960px (tablet)   | Floating overlay panel  | 44×44                  |
| < 540px (mobile)     | Bottom-sheet w/ handle  | 44×44                  |

Mobile-specific behaviour:

- The sidebar collapses to a peek state (88px) on phones, expanding via a
  tap on the handle bar or fly-to interaction (which also auto-collapses).
- HUD moves from bottom-left to top-left to avoid the bottom-sheet, and
  drops its LAT/LON rows since they are meaningless without a hover pointer.
- Tips switch between mouse and touch variants based on `@media (hover)`.
- `touch-action: none` on the map canvas defeats native pinch-zoom and
  pull-to-refresh; `pan-y` on the sheet allows vertical scrolling without
  hijacking pinch.
- `100dvh / 100svh` viewport units handle iOS Safari URL-bar collapse.
- `env(safe-area-inset-*)` keeps controls clear of notches and home indicators.
- `apple-mobile-web-app-capable` + status-bar metadata for "Add to Home Screen".

Accessibility hooks:

- `prefers-reduced-motion`: collapses sheet/splash animations and switches
  fly-to to instant `jumpTo`.
- `forced-colors` (Windows high-contrast): falls back to `CanvasText`.
- Keyboard: arrow-keys pan, Esc collapses the sheet.

### PMTiles ready

The `pmtiles://` protocol is registered at boot. To swap the live tile
server for a self-hosted PMTiles archive, change `SOURCE_BACKEND` to
`'pmtiles'` and set `PMTILES.url` in `src/config.js` — no other code change
needed. Any OpenMapTiles-schema PMTiles file works (e.g. an extract from
[Protomaps](https://maps.protomaps.com/builds/) or a self-built tile set).

## Layout

```
Cart/
├── index.html             # HTML shell + vendor imports
├── styles.css             # UI styling (no map styling)
├── src/
│   ├── main.js            # bootstrap
│   ├── config.js          # view defaults, sources, feature flags
│   ├── device.js          # capability detection + perf profiles
│   ├── map/
│   │   ├── createMap.js   # MapLibre factory, PMTiles, style assembly
│   │   └── interactions.js# zoom curves, keyboard, touch tuning, presets
│   ├── style/             # MODULAR STYLE SYSTEM
│   │   ├── index.js       # composeLayers()
│   │   ├── tokens.js      # design tokens (light/dark)
│   │   ├── base.js        # background, landcover, water
│   │   ├── roads.js       # multi-tier road network
│   │   ├── buildings.js   # 2D + 3D extrusion
│   │   ├── boundaries.js  # admin lines
│   │   └── labels.js      # density-aware, fade-in, variable-anchor labels
│   ├── ui/
│   │   ├── controls.js    # nav, layers, theme, quality, presets, sheet
│   │   └── hud.js         # FPS / zoom / coords readout (touch-aware)
│   ├── perf/monitor.js    # FPS + tile activity
│   └── utils/interp.js    # zoom interp helpers
└── README.md
```

## Controls

### Desktop

- **Scroll** — smooth zoom (rate-limited for precision)
- **Drag** — pan
- **Shift + drag** — rotate / tilt
- **Ctrl/Cmd + click** — fly to point
- **Shift + dbl-click** — zoom out
- Arrow keys — pan
- Top-right: nav / compass / geolocate / fullscreen
- Sidebar: theme switch, quality picker, layer toggles, city presets

### Touch

- **Pinch** — zoom
- **One-finger drag** — pan
- **Two-finger drag** — tilt (touchPitch)
- **Two-finger rotate** — rotate
- **Double-tap** — zoom in
- Top-right: nav / compass / geolocate
- Bottom-sheet: drag handle to expand / collapse, tap a preset to fly-to

## Performance notes

- `maxTileCacheSize` scales with device profile (128–512)
- `fadeDuration` shrinks on weaker devices (100–220ms)
- Antialiasing disabled on `low` profile
- 3D extrusion suppressed on `low` profile
- POI density rank-filtered per profile (`≤ 4` for low, `≤ 6` for high)
- `text-padding` scaled up by 1.35× on low so dense places don't crowd
- Hamlets and neighbourhoods are dropped entirely on `low` (114 → 111 layers)
- Reduce-motion users get instant `jumpTo` instead of `flyTo`
- Save-Data + 2G connections force `low` automatically

## Validation

The project is verified end-to-end via:

- **Style spec validator** (`@maplibre/maplibre-gl-style-spec`) — all 6
  theme/profile combinations and 4 feature-toggle variants validate cleanly.
- **Headless browser tests** (Puppeteer) — 7 device viewports (1920×1080
  desktop, 1366×768 laptop, 820×1180 tablet portrait, 1180×820 tablet
  landscape, 393×852 iPhone, 852×393 iPhone landscape, 360×640 small
  Android) each booting without JS errors / failed requests.
- **Interaction tests** — sheet toggle, preset fly-to + auto-collapse,
  dark theme rebuild, quality switch (Eco drops 3 label tiers).

## Attribution

Tiles © [OpenFreeMap](https://openfreemap.org), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
