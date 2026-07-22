/**
 * Wildlife overlay — runtime lifecycle (the biodiversity sibling of the grid
 * lifecycle in interactions.js).
 *
 * Responsibilities:
 *   1. Keep the GBIF tile source reconciled with the live filter state after
 *      every style rebuild (`styledata` → syncWildlifeSource).
 *   2. Turn the cursor into a pointer over clickable markers.
 *   3. On click, query the GBIF Occurrence Search API around the clicked bin
 *      (mirroring the active filters) and render a rich species popup with
 *      photos, common / scientific names, dates and IUCN Red-List status.
 *
 * All network access is best-effort: GBIF is CORS-enabled, but any failure
 * degrades to a friendly message rather than breaking the map.
 */

import { WILDLIFE } from '../config.js';
import {
  WILDLIFE_LAYER_IDS,
  syncWildlifeSource,
  wildlifeSearchParams,
  normalizeWildlifeFilters,
} from '../style/wildlife.js';

const CLICK_LAYERS = ['wildlife-markers', 'wildlife-glow'];

// GBIF class → short Russian label + accent for the popup badges.
const CLASS_RU = {
  Mammalia: 'Млекопитающие',
  Aves: 'Птицы',
  Reptilia: 'Рептилии',
  Amphibia: 'Земноводные',
  Actinopterygii: 'Рыбы',
  Elasmobranchii: 'Рыбы',
  Insecta: 'Насекомые',
  Arachnida: 'Паукообразные',
  Gastropoda: 'Моллюски',
  Bivalvia: 'Моллюски',
  Malacostraca: 'Ракообразные',
};

// IUCN Red-List category → short label + colour.
const IUCN = {
  EX: ['Вымер', '#111827'],
  EW: ['Вымер в природе', '#374151'],
  CR: ['На грани', '#dc2626'],
  EN: ['Под угрозой', '#ea580c'],
  VU: ['Уязвимый', '#d97706'],
  NT: ['Близок к угрозе', '#65a30d'],
  LC: ['Под наименьшей угрозой', '#16a34a'],
  DD: ['Мало данных', '#6b7280'],
  NE: ['Не оценён', '#9ca3af'],
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Build a query string, expanding array values into repeated keys. */
function toQuery(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${k}=${encodeURIComponent(item)}`);
    } else if (v != null) {
      parts.push(`${k}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

/** A sensible lookup radius (km) for the clicked bin, widening at low zoom. */
function radiusKmForZoom(zoom) {
  const km = Math.pow(2, 15 - (zoom ?? 6));
  return Math.max(3, Math.min(150, Math.round(km)));
}

/** Prefer a lighter iNaturalist image variant than the full-size original. */
function thumb(url) {
  if (!url) return '';
  return url.replace(/\/original\.(jpe?g|png)/i, '/medium.$1');
}

function speciesName(rec) {
  return rec.vernacularName || rec.species || rec.scientificName || 'Неизвестный вид';
}

function recordCardHTML(rec) {
  const name = esc(speciesName(rec));
  const sci = rec.scientificName && rec.scientificName !== speciesName(rec)
    ? `<span class="wl-card-sci">${esc(rec.scientificName)}</span>` : '';
  const cls = CLASS_RU[rec.class] || rec.class || '';
  const date = rec.eventDate ? String(rec.eventDate).slice(0, 10) : '';
  const media = Array.isArray(rec.media) ? rec.media.find((m) => m && m.identifier) : null;
  const img = media
    ? `<img class="wl-card-img" src="${esc(thumb(media.identifier))}" alt="${name}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : '<span class="wl-card-img wl-card-img--none" aria-hidden="true">🐾</span>';

  let iucn = '';
  if (rec.iucnRedListCategory && IUCN[rec.iucnRedListCategory]) {
    const [label, color] = IUCN[rec.iucnRedListCategory];
    iucn = `<span class="wl-chip" style="--wl-chip:${color}">${esc(rec.iucnRedListCategory)} · ${esc(label)}</span>`;
  }

  return `
    <li class="wl-card">
      ${img}
      <div class="wl-card-body">
        <div class="wl-card-title">${name}</div>
        ${sci}
        <div class="wl-card-meta">
          ${cls ? `<span class="wl-tag">${esc(cls)}</span>` : ''}
          ${date ? `<span class="wl-date">${esc(date)}</span>` : ''}
        </div>
        ${iucn}
      </div>
    </li>`;
}

function popupShellHTML(bodyHTML, headline) {
  return `
    <div class="wl-popup">
      <div class="wl-popup-head">
        <span class="wl-popup-dot" aria-hidden="true"></span>
        <span class="wl-popup-headline">${headline}</span>
      </div>
      ${bodyHTML}
      <div class="wl-popup-foot">Источник: <a href="https://www.gbif.org/occurrence/search" target="_blank" rel="noopener">GBIF</a></div>
    </div>`;
}

function loadingHTML(total) {
  const count = Number.isFinite(total) && total > 0
    ? `≈ ${total.toLocaleString('ru-RU')} наблюдений в этой точке`
    : 'Загрузка наблюдений…';
  return popupShellHTML(
    `<div class="wl-popup-status"><span class="wl-spinner" aria-hidden="true"></span>Загрузка видов…</div>`,
    count,
  );
}

export function installWildlifeLifecycle(map) {
  // 1) Keep the tile source reconciled with the live filter state. Fires on
  //    every style settle (theme / mode / toggle rebuilds) and is a cheap
  //    signature no-op when nothing changed.
  const sync = () => {
    const tokens = map._cart && map._cart.tokens;
    syncWildlifeSource(map, tokens);
  };
  map.on('styledata', sync);
  map.once('load', sync);

  // 2) Pointer affordance over clickable markers.
  for (const layer of CLICK_LAYERS) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }

  // 3) Rich species popup on click.
  const ml = window.maplibregl;
  let popup = null;
  let requestToken = 0;

  const onClick = async (e) => {
    if (!ml || !map._cart || !map._cart.features || !map._cart.features.wildlife) return;
    const feature = (e.features && e.features[0]) || null;
    const total = feature && feature.properties ? Number(feature.properties.total) : NaN;
    const { lng, lat } = e.lngLat;

    if (!popup) {
      popup = new ml.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: '320px',
        className: 'wl-popup-container',
      });
    }
    popup.setLngLat([lng, lat]).setHTML(loadingHTML(total)).addTo(map);

    const token = ++requestToken;
    const radius = radiusKmForZoom(map.getZoom());
    const filters = normalizeWildlifeFilters(map._cart.wildlife && map._cart.wildlife.filters);
    const params = {
      ...wildlifeSearchParams(filters),
      geoDistance: `${lat.toFixed(4)},${lng.toFixed(4)},${radius}km`,
      hasCoordinate: 'true',
      limit: 12,
    };

    try {
      const res = await fetch(`${WILDLIFE.searchUrl}?${toQuery(params)}`);
      if (token !== requestToken) return; // superseded by a newer click
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];
      // Records with photos first — the popup leads with imagery.
      results.sort((a, b) => (b.media ? 1 : 0) - (a.media ? 1 : 0));

      const headline = data.count
        ? `${data.count.toLocaleString('ru-RU')} наблюдений в радиусе ${radius} км`
        : 'Наблюдения рядом';

      if (!results.length) {
        popup.setHTML(popupShellHTML(
          '<div class="wl-popup-status wl-popup-empty">Здесь нет записей по текущим фильтрам.</div>',
          headline,
        ));
        return;
      }
      const list = results.slice(0, 8).map(recordCardHTML).join('');
      popup.setHTML(popupShellHTML(`<ul class="wl-cards">${list}</ul>`, headline));
    } catch (err) {
      if (token !== requestToken) return;
      popup.setHTML(popupShellHTML(
        '<div class="wl-popup-status wl-popup-error">Не удалось загрузить данные GBIF. Проверьте соединение.</div>',
        'Наблюдения рядом',
      ));
    }
  };

  for (const layer of CLICK_LAYERS) {
    map.on('click', layer, onClick);
  }
}
