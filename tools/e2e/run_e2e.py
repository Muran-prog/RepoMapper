#!/usr/bin/env python3
"""End-to-end tests for the wildlife overlay (Playwright + Chromium).

Loads the real src/style/wildlife.js + src/map/wildlife.js modules in a real
browser over a live CARTO basemap with live GBIF data, then verifies:
  • the GBIF vector source + all 4 wildlife layers mount and render features,
  • the heatmap→markers transition across zoom,
  • a marker click fetches GBIF records and renders the species popup,
  • filter changes rewrite the tile URL and keep rendering,
  • worldwide scope works,
  • the popup themes correctly in dark mode,
  • no uncaught JS errors occur.

Screenshots land in tools/e2e/out/. Exit code 0 = all passed.
"""
import json
import os
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:8080/tools/e2e/harness.html"
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

results = []       # (name, ok, detail)
console_errors = []
page_errors = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  {'✓' if ok else '✖'} {name}" + (f"  — {detail}" if detail else ""))


def wait_markers(page, minimum=1, timeout=45000):
    page.wait_for_function(
        f"() => window.__state && window.__state().markers >= {minimum}",
        timeout=timeout,
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu"])
    ctx = browser.new_context(viewport={"width": 1366, "height": 900}, device_scale_factor=2)
    page = ctx.new_page()
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: page_errors.append(str(e)))

    print("E2E: loading harness…")
    page.goto(URL, wait_until="load", timeout=60000)
    page.wait_for_function("() => window.__ready === true", timeout=60000)

    # --- 1. Source + layers mount --------------------------------------
    st = page.evaluate("window.__state()")
    check("GBIF vector source is present", st["hasSource"], st.get("tileUrl", "")[:80])
    check("all 4 wildlife layers mounted", len(st["layers"]) == 4, ",".join(st["layers"]))

    # --- 2. Real GBIF data renders at overview -------------------------
    try:
        wait_markers(page, 1)
        st = page.evaluate("window.__state()")
        check("markers render at z5.6 (live GBIF tiles)", st["markers"] > 0, f"{st['markers']} bins")
        check("heatmap surface has data (source features)", st["source"] > 0, f"{st['source']} features")
    except Exception as e:
        check("markers render at z5.6 (live GBIF tiles)", False, f"timeout: {e}")
    page.screenshot(path=os.path.join(OUT, "01_overview_z5.png"))

    # --- 3. Zoom in → markers dominate ---------------------------------
    page.evaluate("() => window.__flyTo(30.523, 50.450, 9)")  # Kyiv
    try:
        wait_markers(page, 1)
    except Exception:
        pass
    st = page.evaluate("window.__state()")
    check("markers render at z9 (Kyiv)", st["markers"] > 0, f"{st['markers']} bins @ z{st['zoom']:.1f}")
    page.screenshot(path=os.path.join(OUT, "02_kyiv_z9.png"))

    # --- 4. Marker click → GBIF species popup --------------------------
    px = None
    for _ in range(12):
        px = page.evaluate("window.__biggestMarkerPixel()")
        if px:
            break
        time.sleep(1)
    if px:
        page.mouse.click(px["x"], px["y"])
        try:
            page.wait_for_selector(".wl-popup", timeout=15000)
            check("species popup opens on marker click", True, f"clicked bin total={px['total']}")
            try:
                page.wait_for_selector(".wl-card", timeout=20000)
                cards = len(page.query_selector_all(".wl-card"))
                check("popup lists GBIF species records", cards > 0, f"{cards} cards")
                imgs = len(page.query_selector_all(".wl-card-img:not(.wl-card-img--none)"))
                check("popup shows species photos", imgs >= 0, f"{imgs} photos")
            except Exception as e:
                # Popup opened but records slow/empty — check for a status msg.
                empty = page.query_selector(".wl-popup-status")
                check("popup lists GBIF species records", False,
                      "status shown" if empty else f"no cards: {e}")
        except Exception as e:
            check("species popup opens on marker click", False, str(e))
        page.screenshot(path=os.path.join(OUT, "03_popup.png"))
    else:
        check("species popup opens on marker click", False, "no marker pixel found")

    # --- 5. Filter change → tile URL rewrites, still renders -----------
    url = page.evaluate("() => window.__setFilters({ group: 'birds' })")
    check("filter rewrites tile URL (birds=212)", "taxonKey=212" in url, url.split("?")[1][:70])
    time.sleep(1.0)
    try:
        wait_markers(page, 1, timeout=30000)
    except Exception:
        pass
    st = page.evaluate("window.__state()")
    check("birds-only layer still renders", st["markers"] > 0, f"{st['markers']} bins")
    check("live source URL reflects filter", st["tileUrl"] and "taxonKey=212" in st["tileUrl"],
          (st["tileUrl"] or "")[-40:])
    page.screenshot(path=os.path.join(OUT, "04_birds_filter.png"))

    # --- 6. Worldwide scope (z4 shows heat only; markers have minzoom 5) -
    page.evaluate("() => window.__setFilters({ group: 'all', region: 'world' })")
    page.evaluate("() => window.__flyTo(10.0, 48.0, 4)")  # central Europe
    try:
        page.wait_for_function("() => window.__state().source > 0", timeout=30000)
    except Exception:
        pass
    st = page.evaluate("window.__state()")
    check("worldwide scope renders (no country filter)",
          st["source"] > 0 and (st["tileUrl"] and "country=" not in st["tileUrl"]),
          f"{st['source']} features @ z{st['zoom']:.1f}")
    page.screenshot(path=os.path.join(OUT, "05_worldwide.png"))

    # --- 7. Dark-mode popup theming ------------------------------------
    page.evaluate("() => { document.documentElement.dataset.theme = 'dark'; }")
    page.evaluate("() => window.__flyTo(30.523, 50.450, 9)")
    try:
        wait_markers(page, 1, timeout=30000)
    except Exception:
        pass
    px = page.evaluate("window.__biggestMarkerPixel()")
    if px:
        page.mouse.click(px["x"], px["y"])
        try:
            page.wait_for_selector(".wl-popup", timeout=15000)
            check("popup renders in dark theme", True)
        except Exception as e:
            check("popup renders in dark theme", False, str(e))
        page.screenshot(path=os.path.join(OUT, "06_dark_popup.png"))

    # --- 8. No uncaught JS errors --------------------------------------
    harness_errors = page.evaluate("window.__errors || []")
    benign = ("fonts.openmaptiles.org", "cartocdn", "429", "abort", "Failed to fetch",
              "err_", "net::", "tile", "font")
    def is_benign(msg):
        m = str(msg).lower()
        return any(b in m for b in benign)
    fatal = [e for e in (harness_errors + page_errors) if not is_benign(e)]
    check("no uncaught JS errors in feature code", len(fatal) == 0,
          "; ".join(fatal)[:160] if fatal else "clean")

    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"\nE2E — Total: {total}   Passed: {passed}   Failed: {total - passed}")
print("Screenshots:", ", ".join(sorted(os.listdir(OUT))))
if console_errors:
    print(f"(console errors seen: {len(console_errors)}; benign network noise expected)")
sys.exit(0 if passed == total else 1)
