/**
 * Focused spec validation for the wildlife overlay.
 *
 * The main validate.cjs composes the default style (wildlife OFF), so it
 * never exercises the wildlife layers. This script applies withWildlifeOverlay
 * to a minimal spec-valid base style across several filter permutations and
 * runs each through @maplibre/maplibre-gl-style-spec's validateStyleMin.
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import {
  withWildlifeOverlay,
  wildlifeTileUrl,
  wildlifeSearchParams,
  normalizeWildlifeFilters,
  WILDLIFE_LAYER_IDS,
  WILDLIFE_SOURCE_ID,
} from '../src/style/wildlife.js';

const tokens = { font: { bold: ['Noto Sans Bold'], regular: ['Noto Sans Regular'] } };

const baseStyle = () => ({
  version: 8,
  name: 'wildlife-test',
  glyphs: 'https://example.com/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
  ],
});

const cases = [
  { label: 'defaults (all animals, UA, full years)', filters: undefined },
  { label: 'single group (mammals)', filters: { group: 'mammals' } },
  { label: 'year range + specimens + worldwide', filters: { group: 'insects', yearFrom: 2000, yearTo: 2020, basis: 'PRESERVED_SPECIMEN', region: 'world' } },
  { label: 'legacy groups[] shape (birds)', filters: { groups: ['birds'] } },
  { label: 'garbage input (degrades to defaults)', filters: { group: 42, yearFrom: 'x', yearTo: null, basis: 'BOGUS', region: 'moon' } },
];

let failed = 0;
let checks = 0;

for (const c of cases) {
  const style = withWildlifeOverlay(baseStyle(), tokens, { enabled: true, filters: c.filters });
  const errors = validateStyleMin(style);

  // Structural assertions.
  const layerIds = style.layers.map((l) => l.id);
  const hasSource = !!style.sources[WILDLIFE_SOURCE_ID];
  const hasAllLayers = WILDLIFE_LAYER_IDS.every((id) => layerIds.includes(id));
  const url = wildlifeTileUrl(c.filters);
  const urlOk = url.includes('{z}/{x}/{y}') && url.includes('srs=EPSG') && url.includes('taxonKey=');

  const problems = [];
  if (errors.length) problems.push(`spec errors: ${errors.map((e) => e.message).join('; ')}`);
  if (!hasSource) problems.push('missing wildlife source');
  if (!hasAllLayers) problems.push('missing one or more wildlife layers');
  if (!urlOk) problems.push(`tile URL malformed: ${url}`);

  checks += 4;
  if (problems.length) {
    failed += problems.length;
    console.log(`  ✖ ${c.label}`);
    for (const p of problems) console.log(`      - ${p}`);
  } else {
    console.log(`  ✓ ${c.label}`);
    console.log(`      url: ${url}`);
  }
}

// Idempotency: applying twice must not duplicate layers.
const once = withWildlifeOverlay(baseStyle(), tokens, { enabled: true });
const twice = withWildlifeOverlay(once, tokens, { enabled: true });
const dupOk = twice.layers.filter((l) => l.id === 'wildlife-markers').length === 1;
checks += 1;
if (!dupOk) { failed += 1; console.log('  ✖ idempotency: layers duplicated on second apply'); }
else console.log('  ✓ idempotency: no duplicate layers on re-apply');

// Disabled → untouched.
const disabled = withWildlifeOverlay(baseStyle(), tokens, { enabled: false });
const disabledOk = !disabled.sources[WILDLIFE_SOURCE_ID] && disabled.layers.length === 1;
checks += 1;
if (!disabledOk) { failed += 1; console.log('  ✖ disabled overlay still injected layers/source'); }
else console.log('  ✓ disabled overlay leaves style untouched');

// Search params sanity.
const sp = wildlifeSearchParams({ group: 'mammals', region: 'ua' });
const spOk = sp.taxonKey === 359 && sp.country === 'UA';
checks += 1;
if (!spOk) { failed += 1; console.log('  ✖ search params malformed', JSON.stringify(sp)); }
else console.log('  ✓ search params carry taxonKey + country');

console.log(`\nWildlife spec validation — Total: ${checks}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
