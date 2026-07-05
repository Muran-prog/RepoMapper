#!/usr/bin/env node
/**
 * Import user-drawn settlement contours from a RepoMapper export into the
 * curated hardcoded supplemental-settlement registry.
 *
 * Usage:
 *   node tools/import-settlement-contours.mjs ../repomapper-export-123.json
 *   node tools/import-settlement-contours.mjs ../repomapper-export-123.json --write
 *
 * The script is dry-run by default. It writes only when --write is passed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..');
const DEFAULT_TARGET = path.join(REPO_ROOT, 'src/style/settlements-supplement.js');
const DEFAULT_DECIMALS = 6;

function usage() {
  console.log(`Usage:
  node tools/import-settlement-contours.mjs <repomapper-export.json> [--write]

Options:
  --write                 Modify src/style/settlements-supplement.js.
  --target <path>          Override the hardcoded supplement file.
  --decimals <n>           Coordinate precision; default ${DEFAULT_DECIMALS}.
  --include-hidden         Import contours marked properties.hidden=true.
  --help                  Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    target: DEFAULT_TARGET,
    decimals: DEFAULT_DECIMALS,
    write: false,
    includeHidden: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '--include-hidden') {
      args.includeHidden = true;
    } else if (arg === '--target') {
      args.target = path.resolve(argv[++i] ?? '');
    } else if (arg === '--decimals') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        throw new Error('--decimals must be an integer from 0 to 10');
      }
      args.decimals = n;
    } else if (!args.input) {
      args.input = path.resolve(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read JSON ${file}: ${err.message}`);
  }
}

function isFeature(value) {
  return value && value.type === 'Feature' && value.geometry;
}

function collectFeatures(value, { contourScope = false } = {}, out = []) {
  if (!value || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    for (const item of value) collectFeatures(item, { contourScope }, out);
    return out;
  }

  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
    collectFeatures(value.features, { contourScope }, out);
    return out;
  }

  if (isFeature(value)) {
    out.push({ feature: value, contourScope });
    return out;
  }

  if (Array.isArray(value.features)) {
    collectFeatures(value.features, { contourScope }, out);
  }
  return out;
}

function extractContourFeatures(root) {
  const out = [];
  const knownContourScopes = [
    root?.data?.contours,
    root?.contours,
    root?.data?.settlementContours,
    root?.settlementContours,
  ].filter(Boolean);

  for (const scope of knownContourScopes) {
    collectFeatures(scope, { contourScope: true }, out);
  }

  // Fallback for future exports: accept explicitly tagged settlement-contour
  // features anywhere in the blob, but do not import arbitrary draw polygons.
  collectFeatures(root, { contourScope: false }, out);

  const seen = new Set();
  return out
    .filter(({ feature, contourScope }) => {
      const id = feature.id ?? `${feature.properties?.name ?? ''}:${JSON.stringify(feature.geometry)}`;
      const key = `${contourScope ? 'scope' : 'tag'}:${id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return contourScope || feature.properties?.kind === 'settlement-contour';
    })
    .map(({ feature }) => feature);
}

function samePoint(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

function roundCoord(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normaliseRing(feature, decimals) {
  if (feature?.geometry?.type !== 'Polygon') return null;
  const sourceRing = feature.geometry.coordinates?.[0];
  if (!Array.isArray(sourceRing)) return null;

  const ring = [];
  for (const raw of sourceRing) {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const lng = Number(raw[0]);
    const lat = Number(raw[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    const point = [roundCoord(lng, decimals), roundCoord(lat, decimals)];
    if (!ring.length || !samePoint(point, ring[ring.length - 1])) {
      ring.push(point);
    }
  }

  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) {
    ring.pop();
  }
  if (ring.length < 3) return null;
  return ring;
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += (a[0] * b[1]) - (b[0] * a[1]);
  }
  return area / 2;
}

function bboxOf(ring) {
  return ring.reduce(
    (bbox, point) => [
      Math.min(bbox[0], point[0]),
      Math.min(bbox[1], point[1]),
      Math.max(bbox[2], point[0]),
      Math.max(bbox[3], point[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

function centroidOf(ring) {
  let lng = 0;
  let lat = 0;
  for (const point of ring) {
    lng += point[0];
    lat += point[1];
  }
  return [lng / ring.length, lat / ring.length];
}

function metersPerLngAt(lat) {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

function distanceMeters(a, b) {
  const lat = (a[1] + b[1]) / 2;
  const dx = (a[0] - b[0]) * metersPerLngAt(lat);
  const dy = (a[1] - b[1]) * 110_540;
  return Math.hypot(dx, dy);
}

function bboxIntersects(a, b) {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function bboxDiagonalMeters(bbox) {
  return distanceMeters([bbox[0], bbox[1]], [bbox[2], bbox[3]]);
}

function canonicalRingKey(ring) {
  const points = ring.map((point) => `${point[0].toFixed(6)},${point[1].toFixed(6)}`);
  const variants = [];
  for (const seq of [points, [...points].reverse()]) {
    for (let i = 0; i < seq.length; i++) {
      variants.push([...seq.slice(i), ...seq.slice(0, i)].join('|'));
    }
  }
  return variants.sort()[0];
}

function likelySameFootprint(a, b) {
  if (!bboxIntersects(a.bbox, b.bbox)) return false;
  const maxDiag = Math.max(bboxDiagonalMeters(a.bbox), bboxDiagonalMeters(b.bbox));
  return distanceMeters(a.centroid, b.centroid) <= maxDiag * 0.75;
}

function normaliseName(name, index) {
  const text = String(name ?? '').trim();
  return text || `Imported contour ${index + 1}`;
}

function jsString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function jsLongString(value, indent = '    ') {
  const text = String(value);
  if (text.length <= 96) return jsString(text);

  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 74 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);

  return [
    '',
    ...lines.map((part, idx) => {
      const suffix = idx < lines.length - 1 ? ' ' : '';
      return `${indent}${jsString(part + suffix)}${suffix ? ' +' : ''}`;
    }),
  ].join('\n');
}

function featureCreatedAt(feature) {
  const value = Number(feature.properties?.createdAt ?? feature.properties?.updatedAt);
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function entryForFeature(item, sourceName) {
  const createdAt = featureCreatedAt(item.feature);
  const note = [
    `Imported from ${sourceName}`,
    item.feature.id ? `manual contour ${item.feature.id}` : null,
    createdAt ? `created ${createdAt}` : null,
  ].filter(Boolean).join(' · ');

  const coords = item.ring
    .map(([lng, lat]) => `      [${lng.toFixed(6)}, ${lat.toFixed(6)}],`)
    .join('\n');

  return [
    '  {',
    `    name: ${jsString(item.name)},`,
    `    note:${jsLongString(note + '.', '      ')},`,
    '    ring: [',
    coords,
    '    ],',
    '  },',
  ].join('\n');
}

function findSupplementArrayBounds(source) {
  const marker = 'export const SUPPLEMENTAL_SETTLEMENTS =';
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error('SUPPLEMENTAL_SETTLEMENTS export not found');
  const openIndex = source.indexOf('[', markerIndex);
  if (openIndex < 0) throw new Error('SUPPLEMENTAL_SETTLEMENTS array opener not found');

  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return { openIndex, closeIndex: i };
    }
  }
  throw new Error('SUPPLEMENTAL_SETTLEMENTS array closer not found');
}

async function loadExisting(targetPath, decimals) {
  const url = `${pathToFileURL(targetPath).href}?import=${Date.now()}`;
  const mod = await import(url);
  const settlements = Array.isArray(mod.SUPPLEMENTAL_SETTLEMENTS)
    ? mod.SUPPLEMENTAL_SETTLEMENTS
    : [];
  return settlements
    .map((settlement, index) => {
      const ring = Array.isArray(settlement.ring)
        ? settlement.ring
            .map(([lng, lat]) => [roundCoord(Number(lng), decimals), roundCoord(Number(lat), decimals)])
            .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
        : [];
      if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) ring.pop();
      if (ring.length < 3) return null;
      return {
        index,
        name: settlement.name ?? `Supplement ${index + 1}`,
        ring,
        key: canonicalRingKey(ring),
        bbox: bboxOf(ring),
        centroid: centroidOf(ring),
      };
    })
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const input = readJson(args.input);
  const sourceName = path.basename(args.input);
  const features = extractContourFeatures(input);
  const existing = await loadExisting(args.target, args.decimals);
  const existingKeys = new Set(existing.map((entry) => entry.key));
  const acceptedKeys = new Set();

  const summary = {
    input: args.input,
    target: args.target,
    features: features.length,
    added: 0,
    skippedHidden: 0,
    skippedInvalid: 0,
    skippedDuplicate: 0,
    skippedLikelyDuplicate: 0,
  };
  const additions = [];

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (feature.properties?.hidden && !args.includeHidden) {
      summary.skippedHidden++;
      continue;
    }

    const ring = normaliseRing(feature, args.decimals);
    if (!ring || Math.abs(signedArea(ring)) < 1e-12) {
      summary.skippedInvalid++;
      continue;
    }

    const key = canonicalRingKey(ring);
    if (existingKeys.has(key) || acceptedKeys.has(key)) {
      summary.skippedDuplicate++;
      continue;
    }

    const candidate = {
      feature,
      name: normaliseName(feature.properties?.name, i),
      ring,
      key,
      bbox: bboxOf(ring),
      centroid: centroidOf(ring),
    };

    const duplicate = existing.find((entry) => likelySameFootprint(candidate, entry));
    if (duplicate) {
      summary.skippedLikelyDuplicate++;
      console.log(
        `skip likely duplicate: ${candidate.name} (${feature.id ?? 'no id'}) overlaps "${duplicate.name}"`,
      );
      continue;
    }

    acceptedKeys.add(key);
    additions.push(candidate);
  }

  summary.added = additions.length;

  if (additions.length && args.write) {
    const source = fs.readFileSync(args.target, 'utf8');
    const bounds = findSupplementArrayBounds(source);
    const insertion = additions
      .map((item) => entryForFeature(item, sourceName))
      .join('\n');
    const nextSource = `${source.slice(0, bounds.closeIndex)}${insertion}\n${source.slice(bounds.closeIndex)}`;
    fs.writeFileSync(args.target, nextSource);
  }

  console.log(JSON.stringify({
    ...summary,
    mode: args.write ? 'write' : 'dry-run',
    addedNames: additions.map((item) => item.name),
  }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
