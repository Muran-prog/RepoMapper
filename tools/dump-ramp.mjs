#!/usr/bin/env node
/**
 * dump-ramp.mjs — emit a gdaldem color-relief ramp file for a chosen
 * hypsometric ramp preset, parsed straight out of the JS source so the
 * offline raster pipeline always matches what the live renderer paints.
 *
 * Usage
 * -----
 *   tools/dump-ramp.mjs <ramp-id> [--theme=light|dark] [--no-bathymetry] [--densify=N]
 *
 *   tools/dump-ramp.mjs --list                  Print every ramp id, one per line.
 *   tools/dump-ramp.mjs all [--theme=light]     Write a directory of ramp files
 *                                                in $WORK_DIR (or ./ramps/).
 *
 * Outputs gdaldem-compatible lines on stdout when a single ramp is
 * requested, e.g.:
 *
 *     -3000 44 93 131 255
 *     -1500 61 128 168 255
 *     ...
 *     2100 241 236 234 255
 *     nv 0 0 0 0
 *
 * Dependencies: only Node ≥ 18, no npm packages. The file imports the
 * project's ESM modules directly via `import()`; no build step.
 *
 * Why Node and not awk?
 * ---------------------
 * awk would have to track:
 *   • a ramp dictionary keyed by id
 *   • light/dark variants
 *   • bathymetry filtering
 *   • LAB densification
 *
 * That's a lot of code and brittle string parsing of JS literal syntax.
 * Node imports the same `ramps.js` and `expression.js` the renderer uses,
 * so adding a new preset is one edit to one file — no awk script update.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

async function importEsm(rel) {
  const abs = path.resolve(REPO, rel);
  return import(pathToFileURL(abs).href);
}

function parseArgs(argv) {
  const out = { positional: [], theme: 'light', bathymetry: true, densify: undefined, list: false, outdir: null };
  for (const a of argv) {
    if (a === '--list') out.list = true;
    else if (a === '--no-bathymetry') out.bathymetry = false;
    else if (a.startsWith('--theme=')) out.theme = a.slice('--theme='.length);
    else if (a.startsWith('--densify=')) out.densify = Number(a.slice('--densify='.length));
    else if (a.startsWith('--outdir=')) out.outdir = a.slice('--outdir='.length);
    else out.positional.push(a);
  }
  return out;
}

function usageAndExit(code = 0) {
  const text = `dump-ramp.mjs — emit gdaldem color-relief ramp text from src/style/hypso

  tools/dump-ramp.mjs <ramp-id> [--theme=light|dark] [--no-bathymetry] [--densify=N]
  tools/dump-ramp.mjs --list
  tools/dump-ramp.mjs all --outdir=<dir> [--theme=light|dark] [--no-bathymetry]
`;
  process[code === 0 ? 'stdout' : 'stderr'].write(text);
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { RAMP_IDS, RAMPS, getRampStops } = await importEsm('src/style/hypso/ramps.js');
  const { buildGdaldemRamp } = await importEsm('src/style/hypso/expression.js');

  if (args.list) {
    for (const id of RAMP_IDS) console.log(id);
    return;
  }

  if (args.positional.length === 0) usageAndExit(2);

  if (!['light', 'dark'].includes(args.theme)) {
    process.stderr.write(`unknown theme '${args.theme}' (expected 'light' or 'dark')\n`);
    process.exit(2);
  }

  const target = args.positional[0];

  if (target === 'all') {
    if (!args.outdir) {
      process.stderr.write(`--outdir=<dir> is required with 'all'\n`);
      process.exit(2);
    }
    await fs.mkdir(args.outdir, { recursive: true });
    for (const id of RAMP_IDS) {
      const stops = getRampStops(id, args.theme);
      const text = buildGdaldemRamp(stops, {
        bathymetry: args.bathymetry,
        densify: args.densify,
      });
      const file = path.join(args.outdir, `${id}.${args.theme}.txt`);
      await fs.writeFile(file, text);
      process.stderr.write(`wrote ${file}\n`);
    }
    return;
  }

  if (!RAMPS[target]) {
    process.stderr.write(`unknown ramp '${target}'. Run 'tools/dump-ramp.mjs --list' to see options.\n`);
    process.exit(2);
  }

  const stops = getRampStops(target, args.theme);
  const text = buildGdaldemRamp(stops, {
    bathymetry: args.bathymetry,
    densify: args.densify,
  });
  process.stdout.write(text);
}

main().catch((err) => {
  process.stderr.write(`dump-ramp.mjs crashed: ${err?.stack || err}\n`);
  process.exit(2);
});
