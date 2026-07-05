# Cart — Інтерактивна векторна карта України

Production-grade, GPU-accelerated vector map of Ukraine with full relief
treatment (multi-directional hillshade, 3D terrain, dynamic contours,
hypsometric tint, ridge/trail detail in the Carpathians). Built on
MapLibre GL JS with a fully custom OpenMapTiles-schema style and a
mobile-first responsive shell. No bundler, no API keys — open
`index.html` and you're rendering.

## Stack

- **MapLibre GL JS 5.x** — WebGL-based vector tile renderer (sky / terrain / globe)
- **PMTiles 4.x** — protocol registered for static archive support
- **maplibre-contour** — worker-based topographic contours from raster-DEM
- **OpenFreeMap** — live OpenMapTiles vector tiles, no API keys
- **AWS Open Data Terrain Tiles** — Mapzen Terrarium-encoded DEMs, no key
- Native ES modules — no bundler required at runtime

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

### Relief stack

Six layers stack between water and roads to give every map view the
right level of topographic context. Each one is independent and
URL-gated — turn it on by populating the relevant `TERRAIN.*.url` (or
`FEATURES.*` flag for runtime overlays).

| Layer            | Source                          | Z-order slot                     | Toggle                          |
| ---------------- | ------------------------------- | -------------------------------- | ------------------------------- |
| Hillshade        | DEM (Mapzen / Carpathian)       | 6 — over hypso, under water_fill | `FEATURES.hillshade`            |
| WorldCover landcover-tint | ESA 10 m landcover (2021 v200)  | 6a — over hillshade, under water_fill (multiply-blend over vector landuse) | `FEATURES.worldcoverTint`       |
| Canopy height tint | ETH Global Canopy Height 10 m (Lang et al. 2023) | 6b — over WorldCover, under water_fill (modulates tree-cover by stand age) | `FEATURES.canopyHeightTint` |
| Forest leaf-type | OSM leaf_type / wood / leaf_cycle in `forest_polygon` source-layer | 7b — over water_fill, under SVF / texture / trails (Carpathian biom-colouring) | `FEATURES.forestLeafType` |
| Sky-View Factor  | WhiteboxTools SkyViewFactor     | 8 — over bathymetry, under texture | `FEATURES.skyViewFactor`        |
| Texture shading  | Leland Brown α=0.8 raster       | 9 — pulls ridges + drainage forward | `FEATURES.textureShading`       |
| Hypsometric tint | native color-relief / raster    | 5 — under hillshade (land mask)  | `FEATURES.hypsometricTint`      |
| Slope-warning    | native color-relief on `['slope']` | 16a — over trails, under buildings | `FEATURES.slopeWarning`         |
| Ridges (Imhof)   | WhiteboxTools FindRidges vector | 12 — double-stroke enhancement   | `FEATURES.ridgeOverlay`         |

Notes:

- **Hypsometric tint** picks between native `color-relief` (MapLibre
  ≥ 5.6) and pre-rendered raster PMTiles automatically via
  `src/style/hypso/detect.js`. Seven ramp presets are bundled.
- **Sky-View Factor** is rendered as a multiplicative greyscale wash
  via `raster-saturation: -1`. It darkens narrow valleys, cirque
  edges and rock terraces hillshade smears out at low azimuths.
- **WorldCover landcover-tint** paints the ESA 10 m global classification
  (Tree / Shrub / Grass / Crop / Built-up / Bare / Snow / Wetland /
  Moss-lichen) as a multiply-blend overlay above the hillshade and below
  the vector water polygons, so coniferous Чорногора reads darker than
  deciduous Гошку, polonyna grass glows yellow-green, and скельні
  поясочки read as warm sand. Opacity rescales when hypso is active so
  the elevation tint stays the dominant signal. Build via
  `tools/build-worldcover.sh` (CC BY 4.0).
- **Canopy height tint** modulates the WorldCover tree-cover wash by
  per-pixel canopy top height — Lang et al.'s 10 m global canopy model
  reads young plantings as light grass-green, mature смерекові ліси as
  emerald, and букові праліси Угольки as the darkest pixels. Stacks
  ABOVE WorldCover (it details the tree-cover class specifically) but
  BELOW texture-shading. Pixels with height = 0 are fully transparent
  so meadows / villages / roads / lakes are never tinted. Opacity adapts
  to relief state: hypso suppresses, WorldCover reinforces, both at
  once → conservative MIN. Build via `tools/build-canopy-height.sh`
  (CC BY 4.0).
- **Forest leaf-type** paints `landuse=forest` / `natural=wood`
  polygons in the Carpathian bbox by their OSM `leaf_type` tag
  (with cascading fallbacks to `wood` and `leaf_cycle`). The four
  canonical slots (needleleaved / broadleaved / mixed / leafless)
  drive distinct biom-colours so Чорногора / Свидовець / Ґорґани
  read as cool dark conifer, Закарпатські букові праліси as warm
  yellow-green, mixed slopes as the in-between tone. Заповідники
  carry an amber dashed outline; named massifs italic-labelled
  above zoom-aware area thresholds. Stacks ABOVE water_fill (no
  bleed into lakes) and BELOW SVF / texture / trails. Source lives
  in the same `carpathian-osm.pmtiles` archive as trails — rebuild
  via `tools/build-carpathian-osm.sh` after pulling the new
  `forest_polygon` schema entry; until then the renderer's
  graceful-fallback path keeps the layer absent.
- **Slope-warning** uses the native `color-relief` layer driven by
  the `['slope']` expression — slopes ≥ 35° render in translucent
  red (configurable via `tokens.slopeWarning`). Runtimes that don't
  yet support `['slope']` silently drop the layer (probed in
  `src/style/hypso/detect.js`).
- **Texture shading** is built once via Leland Brown's fractional
  Laplacian (α=0.8); see `tools/build-texture-shading.sh`.
- **Ridges** are extracted with WhiteboxTools `FindRidges` and
  rendered as Imhof-style double-strokes (dark below, light above).

3D terrain (`map.setTerrain`) is wired to a `zoomend` lifecycle so it
fades in past zoom 7 with a profile-aware exaggeration multiplier and
the user-controllable `0.5×–2×` slider in the sidebar.

### Carpathian ultra-detail

The Ukrainian Carpathians (`bbox = [22.0, 47.6, 27.0, 49.5]`) get a
dedicated pipeline:

- 30 m Copernicus GLO-30 DEM (built locally — see `tools/`)
- Custom Planetiler vector PMTiles with hiking_route / mountain_feature /
  forest_road / forest_polygon / ski_piste / cableway source-layers
- Trail emphasis: light casing + dashed inline (red by default, recoloured
  per OSMC/colour tags)
- Peak/pass/saddle labels with elevation, sorted by `rank` so taller
  peaks win collisions
- **Forest leaf-type** — fill-окраска лісових масивів за OSM
  `leaf_type` тегом. Хвойні Чорногори читаються холодним темним
  смерековим зеленим, букові схили Гошку та Угольки — теплішим
  жовто-зеленим, мішані смуги між ними — проміжним відтінком.
  Заповідні території (Карпатський, Угольсько-Широколужанський,
  Стужиця) обведені янтарним пунктиром; названі масиви підписані
  курсивом італьянським шрифтом тільки понад zoom-залежні пороги
  площі (z8 > 50 км², z14 > 1 км²). Включається через `Forest types`
  в панелі «Рельєф» і вмикається після перебудови
  `carpathian-osm.pmtiles` із новим source-layer `forest_polygon`
  (див. `tools/README.md`).
- Optional ridge/valley overlay extracted via WhiteboxTools
- Imhof-style "serpentine halo" — extra-wide soft casing on
  primary/secondary/tertiary/minor inside the bbox at z ≥ 13

Five preset fly-tos (Hoverla, Pip Ivan, Petros, Svydovets, Chornohora)
ship with sensible pitch + bearing so terrain reads immediately on landing.

### PMTiles ready

The `pmtiles://` protocol is registered at boot. To swap the live tile
server for a self-hosted PMTiles archive, change `SOURCE_BACKEND` to
`'pmtiles'` and set `PMTILES.url` in `src/config.js` — no other code change
needed. The same protocol carries every relief overlay; see
`tools/README.md` for offline build scripts.

## Layout

```
Cart/
├── index.html             # HTML shell + vendor imports (maplibre-gl,
│                          # pmtiles, maplibre-contour)
├── styles.css             # UI styling (no map styling)
├── validate.cjs           # style-spec validator (npm run validate)
├── package.json           # dev-only deps (validator); no runtime bundling
├── src/
│   ├── main.js            # bootstrap
│   ├── config.js          # view, sources, TERRAIN, CONTOURS, CARPATHIAN, FEATURES
│   ├── device.js          # capability detection + tri-tier relief profile
│   ├── map/
│   │   ├── createMap.js   # protocol registration, source/style assembly
│   │   └── interactions.js# zoom curves, terrain lifecycle, presets
│   ├── style/             # MODULAR STYLE SYSTEM
│   │   ├── index.js       # composeLayers() — z-ordered layer stack
│   │   ├── tokens.js      # design tokens (light/dark)
│   │   ├── sources.js     # composeSources() — pure source-dict builder
│   │   ├── base.js        # background, landcover, water (split fill/way)
│   │   ├── terrain.js     # hillshade × N, texture, hypso delegate, bathymetry,
│   │   │                  #   composeWorldcoverLayer (ESA landcover-tint),
│   │   │                  #   composeCanopyHeightLayer (ETH Lang 2023 canopy),
│   │   │                  #   composeSky / composeTerrain / composeProjection
│   │   ├── worldcover-ramps.js # ESA WorldCover 11-class colour table (light/dark)
│   │   ├── canopy-height-ramps.js # ETH canopy-height ramp [h_m, hex, alpha] (light/dark)
│   │   ├── forest-leaf-tokens.js # Carpathian forest leaf-type biom palette (light/dark)
│   │   ├── contours.js    # contour line + label specs (static & dynamic)
│   │   ├── carpathian.js  # ridges, trails, peak/pass/saddle labels, cableway,
│   │   │                  #   forestPolygonLayers (leaf-type biom polygons)
│   │   ├── roads.js       # 14-class table; lane-scaling, surface variants,
│   │   │                  #   subclass splits (cycleway/footway/steps),
│   │   │                  #   Carpathian double-casing
│   │   ├── buildings.js   # 2D + 3D extrusion
│   │   ├── boundaries.js  # admin lines
│   │   ├── settlements-supplement.js # hardcoded user-curated settlement contours
│   │   ├── labels.js      # density-aware, fade-in, shielded labels
│   │   └── hypso/         # HYPSOMETRIC SUBSYSTEM
│   │       ├── ramps.js      # 7 ramp presets × light/dark + bathymetry stops
│   │       ├── color.js      # LAB ↔ sRGB converter, densifier, contrast boost
│   │       ├── expression.js # MapLibre color-relief expression generator
│   │       ├── layers.js     # native + raster + bathymetry layer factories
│   │       ├── detect.js     # runtime native-color-relief feature probe
│   │       ├── runtime.js    # imperative setPaintProperty surface (no rebuild)
│   │       └── index.js      # public barrel
│   ├── ui/
│   │   ├── controls.js    # nav, theme, quality, layer + relief toggles,
│   │   │                  #   exaggeration slider, fly-to presets, hypso mount
│   │   ├── hud.js         # FPS / zoom / coords / ELEV readout
│   │   └── hypso/         # HYPSOMETRIC UI
│   │       ├── picker.js     # ramp radio list + CB-safe badge + strength slider
│   │       ├── editor.js     # drag-stops editor, import/export JSON
│   │       ├── legend.js     # gradient bar + ticks + you-are-here cursor
│   │       ├── profile.js    # elevation-profile drawing mode + chart
│   │       ├── autoregion.js # viewport-region auto-pick + min/mean/max stats
│   │       ├── store.js      # localStorage for custom ramps + user prefs
│   │       └── index.js      # mount + barrel
│   ├── perf/monitor.js    # FPS + tile activity
│   └── utils/interp.js    # zoom interp helpers
└── tools/                 # OFFLINE BUILD PIPELINE (optional, see README.md)
    ├── _lib.sh
    ├── build-carpathian-dem.sh    # Copernicus GLO-30 → Terrarium PMTiles
    ├── build-texture-shading.sh   # Leland Brown α=0.8 → raster PMTiles
    ├── build-hypso.sh             # gdaldem color-relief per ramp preset
    ├── build-bathymetry.sh        # GEBCO 2024 seabed tint, joins at 0 m
    ├── build-worldcover.sh         # ESA WorldCover 10 m landcover-tint
    ├── build-canopy-height.sh      # ETH Global Canopy Height 10 m (Lang et al. 2023)
    ├── build-contours.sh           # gdal_contour + tippecanoe → PMTiles
    ├── build-ridges.sh             # WhiteboxTools FindRidges → PMTiles
    ├── build-carpathian-osm.sh     # Planetiler with custom profile
    ├── carpathian-profile.yml      # Planetiler schema
    ├── dump-ramp.mjs               # Node ramp-table parser (CIELAB densifier)
    ├── dump-worldcover-ramp.mjs    # Node WorldCover colour-table emitter
    ├── dump-canopy-ramp.mjs        # Node ETH canopy ramp emitter (alpha-aware)
    ├── import-settlement-contours.mjs # RepoMapper export → hardcoded contours
    ├── smoke-hypso.mjs            # headless paint-property smoke test
    └── README.md
```

### Hypsometric subsystem at a glance

| Feature                | What it does                                                           | Toggle / config                |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| **7 ramp presets**     | Patterson, Raisz–Henry, Swiss alpine, OSM physical, Carpathian focus, Steppe flat, Colourblind-safe — each light + dark + bathymetry | `src/style/hypso/ramps.js`     |
| **Native + raster**    | Native `color-relief` layer on supported runtimes; raster PMTiles fallback per ramp | feature-detected at boot       |
| **Strength slider**    | 0 → 1.5× opacity multiplier, instant via `setPaintProperty`            | `HYPSO.defaultStrength`        |
| **Bathymetry**         | GEBCO 2024 seabed tint, joins seamlessly with the ramp at 0 m          | `TERRAIN.bathymetry.url`       |
| **Land-only mask**     | Hypso layer sits below `water_fill` — no tile-level masking needed     | z-order in `composeLayers`     |
| **Smart hillshade**    | Hillshade exaggeration auto-fades when hypso is active                 | `HILLSHADE_BLEND` curve        |
| **Auto-region**        | Viewport classifier (Carpathian / alpine / steppe / sea) picks the matching ramp | `HYPSO.regionRamp`             |
| **Live editor**        | Drag colour stops along the elevation axis, save to localStorage, import/export JSON | `enableHypsoEditor` (high)     |
| **Legend**             | Vertical gradient bar + ticks + "you-are-here" elevation marker        | `enableHypsoLegend`            |
| **Stats**              | Live min/mean/max from a 5×5 viewport-DEM sample on each `idle`        | `enableHypsoStats`             |
| **Elevation profile**  | Click-to-draw polyline → SVG chart with tooltip + CSV export           | `enableHypsoProfile` (high/med)|
| **Colourblind-safe**   | Luminance-led palette, badge in picker, OS `prefers-contrast: more` auto-flip | per-ramp `colorblindSafe`     |
| **Perceptual blend**   | CIELAB densification of every ramp before MapLibre's linear-RGB interp | `densifyStopsLab` (~50 LOC, no deps) |

### Hardcoded Settlement Contours

Manual contours drawn in the app can be promoted into the shipped map style
through `src/style/settlements-supplement.js`. Do not paste a large export by
hand. Use the importer so the format stays stable and duplicate contours are
filtered against existing hardcoded entries such as `Заросляк`:

```bash
npm run import-settlement-contours -- ../repomapper-export-1783268027369.json
npm run import-settlement-contours -- ../repomapper-export-1783268027369.json --write
```

The dry-run reports how many `settlement-contour` polygons will be added,
skipped as malformed/hidden, or skipped as duplicates. The write pass appends
new entries with 6-decimal `[lng, lat]` rings, no repeated closing vertex, and
provenance notes that include the source export and original contour id.

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

```bash
npm install        # one-off: install the style-spec validator
npm run validate   # walks the full theme × profile × feature matrix
```

`validate.cjs` runs every (light/dark) × (high/medium/low) × 12
feature-toggle pack through `@maplibre/maplibre-gl-style-spec` —
72 combinations, all expected to pass. The validator covers source
referential integrity (no layer points at a missing source), expression
shape (every paint property is a valid expression), and root-block
correctness (`sky`, `terrain`, `projection`).

## Attribution

- Vector tiles © [OpenFreeMap](https://openfreemap.org), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
- Terrain (default) © [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (AWS Open Data)
- Optional Carpathian DEM (recommended): [FABDEM v1.2](https://data.bris.ac.uk/data/dataset/25wfy0f9ukoge2gs7a5mqpq2j7) © Fathom (CC BY-NC 4.0, **non-commercial use only**)
- Optional Carpathian DEM (commercial fallback): © [Copernicus GLO-30](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model)
- Satellite mode: low zooms use Sentinel-2 cloudless 2024 by [EOX IT Services GmbH](https://s2maps.eu) (Contains modified Copernicus Sentinel data 2024); high-detail zooms use © [Mapbox Satellite](https://www.mapbox.com/about/maps/) with `@2x` tiles on HiDPI displays
- Satellite fallback: © [Esri World Imagery](https://www.esri.com/) — Maxar, Earthstar Geographics, GIS User Community
- Texture shading: Leland Brown (CC BY)
- ESA WorldCover 10 m 2021 v200: © [ESA WorldCover project](https://esa-worldcover.org) / VITO / Brockmann Consult / CS / Gamma Remote Sensing / IIASA / WUR (CC BY 4.0)
- ETH Global Canopy Height 10 m: Lang, Jetz, Schindler, Wegner, "A high-resolution canopy height model of the Earth" — [project page](https://langnico.github.io/globalcanopyheight/), *Nature Ecology & Evolution* (2023) (CC BY 4.0)
- Sky-View Factor: [WhiteboxTools](https://www.whiteboxgeo.com/) (Lindsay)
- Ridge extraction: [WhiteboxTools](https://www.whiteboxgeo.com/geospatial-software/)
- Tile pipeline: [Planetiler](https://github.com/onthegomap/planetiler), [tippecanoe](https://github.com/felt/tippecanoe), [maplibre-contour](https://github.com/onthegomap/maplibre-contour)
