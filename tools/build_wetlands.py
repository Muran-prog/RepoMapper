#!/usr/bin/env python3
"""
build_wetlands.py — classified wetland archive builder for the Swamp-cover layer.

Analogue of tools/build-forest10m.sh, but for wetlands. Where the forest
high-detail archive is derived from ESA WorldCover raster, the wetland archive
is derived from the RICHEST available classification source for swamp type and
traversability: raw OpenStreetMap `natural=wetland` polygons carrying the
`wetland=<subtype>` subtag.

Why OSM raw and not the base-map tiles?
  The base map reads OpenFreeMap (OpenMapTiles schema). Its `landcover` layer
  DECLARES a `subclass` field, but the published planet build collapses every
  wetland to subclass='wetland' (verified by decoding live z12-z14 tiles across
  Polissia, the Danube Delta, Sivash, Shatsky and Kherson). The fine subtype we
  need for a graded traversability palette only survives in the raw OSM tags.

Pipeline (offline, run occasionally — the output is committed as a data file):
  1. Tile Ukraine into boxes and query the Overpass API for
     `natural=wetland` ways + relations WITH geometry.
  2. Assemble shapely polygons (multipolygon relations included), dedupe by
     OSM id, drop slivers.
  3. Classify each polygon into a TRAVERSABILITY TIER from its `wetland` value
     (see TIER_BY_TYPE) and attach compact, render-ready properties.
  4. Simplify geometry (Douglas-Peucker) to keep the GeoJSON light enough for
     an in-browser `geojson` source without hurting the map's frame budget.
  5. Write data/ukraine-wetlands.geojson.

The consuming style (src/style/swamp-cover.js) is a pure function of the `tier`
property, so re-tuning the palette never requires rebuilding this archive, and
re-running this archive never requires touching the style.
"""
from __future__ import annotations
import json, sys, time, argparse
from collections import OrderedDict
import requests
from shapely.geometry import Polygon, MultiPolygon, mapping
from shapely.ops import polygonize, unary_union

# --- Traversability classification ------------------------------------------
# OSM wetland=<value>  ->  tier id consumed by src/style/swamp-cover.js.
# Ordering rationale (easiest -> impassable) is documented per tier in the
# style module; kept here as the single source of truth for the mapping.
TIER_BY_TYPE = {
    'wet_meadow': 't1',                          # seasonally wet grassland — firmest
    'marsh': 't2', 'saltmarsh': 't2',            # herbaceous, shallow water
    'reedbed': 't3', 'swamp': 't3', 'fen': 't3', # dense veg / woody / soft peat
    'bog': 't4', 'string_bog': 't4',             # quaking raised peat — treacherous
    'tidalflat': 't5', 'mud': 't5', 'mangrove': 't5',  # open mud / permanent inundation
    'saltern': 'mm',                             # man-made salt-evaporation ponds
}
SALT_TYPES = {'saltmarsh', 'tidalflat', 'saltern'}

# Human-readable (Russian, to match the UI) label per raw subtype.
TYPE_LABEL_RU = {
    'wet_meadow': 'Влажный луг', 'marsh': 'Марш (травяное болото)',
    'saltmarsh': 'Солончаковый марш', 'reedbed': 'Тростниковые заросли',
    'swamp': 'Лесное болото', 'fen': 'Низинное болото',
    'bog': 'Верховое болото', 'string_bog': 'Грядово-мочажинное болото',
    'tidalflat': 'Илистая приливная отмель', 'mud': 'Грязевая топь',
    'mangrove': 'Мангры', 'saltern': 'Соляные пруды',
}

UA_BOXES = [   # (south, west, north, east) — tiles covering Ukraine's wetland belt
    (50.9, 28.7, 52.1, 30.9),  # Polissia / Chornobyl-Prypiat
    (50.4, 26.0, 52.1, 28.7),  # central-north Polissia
    (50.9, 23.2, 52.0, 26.0),  # Volyn / Shatsky
    (48.6, 22.0, 50.4, 26.0),  # west / upper Dnister
    (48.0, 26.0, 50.9, 30.0),  # central Ukraine
    (48.0, 30.0, 50.9, 34.0),  # central-east
    (48.0, 34.0, 50.4, 40.2),  # east (Donbas floodplains)
    (46.3, 30.0, 48.0, 34.5),  # lower Dnipro
    (46.3, 34.5, 48.0, 40.2),  # Azov coast
    (45.0, 28.9, 46.6, 34.6),  # Danube Delta · Sivash · Dnipro delta
    (44.3, 32.0, 46.0, 36.7),  # Crimea north (Sivash) / south coast
]
ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
HDRS = {'User-Agent': 'RepoMapper-wetlands-builder/1.0'}


def overpass(query: str, tries: int = 4):
    for ep in ENDPOINTS:
        for a in range(tries):
            try:
                r = requests.post(ep, data={'data': query}, headers=HDRS, timeout=180)
                if r.status_code == 200:
                    return r.json()
                print(f"  {r.status_code} {ep.split('/')[2]} try{a+1}", file=sys.stderr)
            except Exception as ex:
                print("  ERR", ep.split('/')[2], str(ex)[:70], file=sys.stderr)
            time.sleep(4)
    return None


def ring(coords):
    pts = [(p['lon'], p['lat']) for p in coords]
    if len(pts) >= 4 and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def poly_from_way(el):
    if not el.get('geometry'):
        return None
    pts = ring(el['geometry'])
    if len(pts) < 4:
        return None
    try:
        p = Polygon(pts)
        if not p.is_valid:
            p = p.buffer(0)
        return p if (not p.is_empty and p.area > 0) else None
    except Exception:
        return None


def poly_from_relation(el):
    outers, inners = [], []
    for m in el.get('members', []):
        if m.get('type') != 'way' or not m.get('geometry'):
            continue
        line = [(p['lon'], p['lat']) for p in m['geometry']]
        if len(line) < 2:
            continue
        (outers if m.get('role') != 'inner' else inners).append(line)
    if not outers:
        return None
    try:
        shell = unary_union(list(polygonize(outers)))
        if inners:
            holes = unary_union(list(polygonize(inners)))
            if not holes.is_empty:
                shell = shell.difference(holes)
        if shell.is_empty:
            return None
        return shell if shell.is_valid else shell.buffer(0)
    except Exception:
        return None


def classify(tags):
    wt = (tags.get('wetland') or '').strip().lower()
    tier = TIER_BY_TYPE.get(wt, 'u0')
    salt = (wt in SALT_TYPES) or (tags.get('salt') == 'yes')
    seasonal = tags.get('seasonal') in ('yes', 'spring', 'summer') or tags.get('intermittent') == 'yes'
    return {
        'tier': tier,
        'wetland': wt or 'unknown',
        'label': TYPE_LABEL_RU.get(wt, 'Болото (тип не указан)'),
        'salt': 1 if salt else 0,
        'seasonal': 1 if seasonal else 0,
        'name': tags.get('name:uk') or tags.get('name') or '',
    }


def build(simplify_tol: float, min_area_deg2: float, boxes):
    feats = OrderedDict()  # (type,id) -> (geom, props)
    for i, (s, w, n, e) in enumerate(boxes):
        q = (f"[out:json][timeout:170];"
             f'(way["natural"="wetland"]({s},{w},{n},{e});'
             f'relation["natural"="wetland"]({s},{w},{n},{e}););out geom;')
        print(f"[{i+1}/{len(boxes)}] box {s},{w},{n},{e}", file=sys.stderr)
        data = overpass(q)
        if not data:
            print("  FAILED box", file=sys.stderr); continue
        added = 0
        for el in data.get('elements', []):
            key = (el['type'], el['id'])
            if key in feats:
                continue
            geom = poly_from_way(el) if el['type'] == 'way' else poly_from_relation(el)
            if geom is None or geom.area < min_area_deg2:
                continue
            if simplify_tol:
                geom = geom.simplify(simplify_tol, preserve_topology=True)
                if geom.is_empty:
                    continue
            feats[key] = (geom, classify(el.get('tags', {})))
            added += 1
        print(f"  +{added} (total {len(feats)})", file=sys.stderr)
        time.sleep(1)
    return feats


def _round_coords(coords, nd):
    if isinstance(coords[0], (float, int)):
        return [round(coords[0], nd), round(coords[1], nd)]
    return [_round_coords(c, nd) for c in coords]


def to_geojson(feats, ndigits=5, full=False):
    """Serialize to a compact FeatureCollection.

    Coordinates are rounded to `ndigits` decimals (~1 m at 5 dp) to keep the
    in-browser `geojson` source light. By default only render-critical props
    ship (`tier` + raw `wetland` subtype, plus `salt` when set); `full=True`
    keeps the label / name / seasonal / osm-id metadata too.
    """
    out = []
    for (typ, oid), (geom, props) in feats.items():
        if geom.is_empty or not isinstance(geom, (Polygon, MultiPolygon)):
            continue
        if full:
            p = {**props, 'osm': f'{typ[0]}{oid}'}
        else:
            p = {'tier': props['tier'], 'wetland': props['wetland']}
            if props.get('salt'):
                p['salt'] = 1
        gm = mapping(geom)
        gm['coordinates'] = _round_coords(gm['coordinates'], ndigits)
        out.append({'type': 'Feature', 'properties': p, 'geometry': gm})
    return {'type': 'FeatureCollection', 'features': out}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default='data/ukraine-wetlands.geojson')
    ap.add_argument('--tol', type=float, default=0.0016,
                    help='simplify tolerance in deg (~0.0016 ≈ 175 m; keeps the '
                         'national GeoJSON light enough for an in-browser source)')
    ap.add_argument('--min-area', type=float, default=8.0e-7,
                    help='drop polygons below this area in deg^2 (~8e-7 ≈ 1 ha)')
    ap.add_argument('--round', type=int, default=5, dest='ndigits',
                    help='coordinate decimal places (5 ≈ 1 m)')
    ap.add_argument('--full-props', action='store_true',
                    help='keep label/name/seasonal/osm metadata (larger file)')
    ap.add_argument('--boxes', default='all', help='"all" or comma index list e.g. 9,10')
    a = ap.parse_args()
    boxes = UA_BOXES if a.boxes == 'all' else [UA_BOXES[int(i)] for i in a.boxes.split(',')]
    feats = build(a.tol, a.min_area, boxes)
    gj = to_geojson(feats, ndigits=a.ndigits, full=a.full_props)
    import os
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(gj, f, ensure_ascii=False, separators=(',', ':'))
    from collections import Counter
    tc = Counter(f['properties']['tier'] for f in gj['features'])
    print(f"\nWROTE {a.out}: {len(gj['features'])} features", file=sys.stderr)
    print("tier distribution:", dict(tc), file=sys.stderr)
