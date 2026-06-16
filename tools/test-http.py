#!/usr/bin/env python3
"""End-to-end HTTP integration test against a live deployment.

Simulates multiple devices via independent cookie jars and exercises the
full account + sync + export/import + security surface.

Usage: BASE_URL=https://... python3 tools/test-http.py
"""
import os, json, time, urllib.request, urllib.error, http.cookiejar as cj

BASE = os.environ["BASE_URL"].rstrip("/")
passed = failed = 0
def ok(cond, msg):
    global passed, failed
    if cond: passed += 1; print("  \u2713", msg)
    else: failed += 1; print("  \u2717 FAIL:", msg)
def section(t): print("\n== " + t + " ==")

class Device:
    """A browser-like client with its own cookie jar."""
    def __init__(self):
        self.jar = cj.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            r = self.op.open(req, timeout=40)
            raw = r.read().decode()
            return r.status, dict(r.headers), (json.loads(raw) if raw.strip() and raw.strip()[0] in "{[" else raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, dict(e.headers), (json.loads(raw) if raw.strip() and raw.strip()[0] in "{[" else raw)
    def cookies(self):
        return {c.name: c for c in self.jar}

U = "u_" + str(int(time.time())) + "x"
P = "Sup3rSecret!"

# ---------------- health ----------------
section("health")
d0 = Device()
st, h, b = d0.call("GET", "/api/health")
ok(st == 200 and isinstance(b, dict) and b.get("storage") == "connected", "health: storage connected")
ok(b.get("version") == "2.0.0", "health: new version 2.0.0")
ok("ip" not in b, "health: no IP field (IP system removed)")

# ---------------- unauth guards ----------------
section("unauthenticated access is blocked")
st, _, b = d0.call("GET", "/api/auth/me"); ok(st == 401, "me -> 401 without session")
st, _, b = d0.call("GET", "/api/sync"); ok(st == 401, "sync GET -> 401 without session")
st, _, b = d0.call("POST", "/api/sync", {"features": []}); ok(st == 401, "sync POST -> 401 without session")
st, _, b = d0.call("GET", "/api/export"); ok(st == 401, "export -> 401 without session")
st, _, b = d0.call("GET", "/api/access"); ok(st == 404, "legacy /api/access is gone (404)")

# ---------------- registration validation ----------------
section("registration validation")
st, _, b = d0.call("POST", "/api/auth/register", {"username": "ab", "password": P})
ok(st == 400, "short username rejected")
st, _, b = d0.call("POST", "/api/auth/register", {"username": "bad name", "password": P})
ok(st == 400, "username with space rejected")
st, _, b = d0.call("POST", "/api/auth/register", {"username": U, "password": "short"})
ok(st == 400, "short password rejected")

# ---------------- register ----------------
section("registration")
dA = Device()
st, h, b = dA.call("POST", "/api/auth/register", {"username": U, "password": P})
ok(st == 201 and b.get("ok") and b["user"]["username"] == U, "register succeeds + returns user")
sc = h.get("Set-Cookie", "")
ok("rm_session=" in sc and "HttpOnly" in sc and "Secure" in sc and "SameSite=Lax" in sc, "session cookie is HttpOnly+Secure+SameSite=Lax")
ok("rm_session" in dA.cookies(), "device A has a session cookie")
st, _, b = dA.call("GET", "/api/auth/me")
ok(st == 200 and b["user"]["username"] == U, "me works right after registration (propagation handled)")

# duplicate
st, _, b = d0.call("POST", "/api/auth/register", {"username": U, "password": P})
ok(st == 409, "duplicate username -> 409")
st, _, b = d0.call("POST", "/api/auth/register", {"username": U.upper(), "password": P})
ok(st == 409, "duplicate username is case-insensitive")

# ---------------- sync round-trip ----------------
section("sync round-trip (device A)")
st, _, b = dA.call("GET", "/api/sync")
ok(st == 200 and b["data"]["features"]["features"] == [], "fresh account has empty data")
payload = {
    "features": {"version": 1, "features": [
        {"id": "m1", "type": "Feature", "geometry": {"type": "Point", "coordinates": [30.52, 50.45]}, "properties": {"name": "Kyiv"}},
        {"id": "l1", "type": "Feature", "geometry": {"type": "LineString", "coordinates": [[30, 50], [24, 49]]}, "properties": {"label": "route"}},
    ]},
    "prefs": {"color": "#ff0000", "weight": 5, "connectionMode": "sequence"},
    "settings": {"mapMode": "3d", "uiPrefs": {"theme": "dark"}},
    "contours": {"outlines": [{"id": "c1", "pts": [[1, 2], [3, 4]]}]},
}
st, _, b = dA.call("POST", "/api/sync", payload)
ok(st == 200 and b.get("ok"), "POST snapshot saves")
st, _, b = dA.call("GET", "/api/sync")
ok(len(b["data"]["features"]["features"]) == 2, "features persisted (2)")
ok(b["data"]["prefs"]["color"] == "#ff0000", "prefs persisted")
ok(b["data"]["settings"]["mapMode"] == "3d", "settings persisted")
ok(b["data"]["contours"]["outlines"][0]["id"] == "c1", "contours persisted")

# ---------------- CROSS-DEVICE ----------------
section("cross-device data (device B, same account)")
dB = Device()
st, _, b = dB.call("POST", "/api/auth/login", {"username": U, "password": P})
ok(st == 200 and b.get("ok"), "device B logs in")
st, _, b = dB.call("GET", "/api/sync")
ok(len(b["data"]["features"]["features"]) == 2, "device B sees device A's features (account-bound, not device-bound)")
ok(b["data"]["settings"]["uiPrefs"]["theme"] == "dark", "device B sees settings too")

# device B adds a feature, device A should see it after refresh
st, _, b = dB.call("PUT", "/api/sync", {"features": {"features": [
    {"id": "m2", "type": "Feature", "geometry": {"type": "Point", "coordinates": [24, 49.8]}, "properties": {"name": "Lviv"}}
]}})
ok(st == 200, "device B merges a new feature (PUT)")
st, _, b = dA.call("GET", "/api/sync")
ids = sorted(f["id"] for f in b["data"]["features"]["features"])
ok(ids == ["l1", "m1", "m2"], "device A now sees device B's added feature (merge union)")

# ---------------- export / import ----------------
section("export / import")
st, h, b = dA.call("GET", "/api/export")
ok(st == 200 and isinstance(b, dict) and b.get("__repomapper_export"), "export returns a valid blob")
ok("attachment" in h.get("Content-Disposition", ""), "export is a downloadable attachment")
exported = b
# wipe via replace-import with only one feature
imp = {**exported, "data": {**exported["data"], "features": {"version": 1, "features": [exported["data"]["features"]["features"][0]]}}, "mode": "replace"}
st, _, b = dA.call("POST", "/api/import", imp)
ok(st == 200 and b.get("ok"), "import (replace) succeeds")
st, _, b = dA.call("GET", "/api/sync")
ok(len(b["data"]["features"]["features"]) == 1, "import replaced features")
# restore full set via merge
st, _, b = dA.call("POST", "/api/import", {**exported, "mode": "merge"})
st, _, b = dA.call("GET", "/api/sync")
ok(len(b["data"]["features"]["features"]) == 3, "import (merge) restored all features")
# bad import
st, _, b = dA.call("POST", "/api/import", {"foo": 1})
ok(st == 400, "invalid import format -> 400")

# ---------------- login security ----------------
section("login security")
st, _, b = d0.call("POST", "/api/auth/login", {"username": U, "password": "wrongpass"})
ok(st == 401, "wrong password -> 401")
st, _, b = d0.call("POST", "/api/auth/login", {"username": "no_such_user_zzz", "password": P})
ok(st == 401, "unknown user -> 401 (no enumeration)")

# tampered cookie
dT = Device()
dT.call("POST", "/api/auth/login", {"username": U, "password": P})
# corrupt the cookie value
for c in dT.jar:
    if c.name == "rm_session":
        c.value = c.value[:-3] + "xyz"
st, _, b = dT.call("GET", "/api/auth/me")
ok(st == 401, "tampered cookie -> 401")

# ---------------- password change invalidates other sessions ----------------
section("password change revokes other sessions")
NEWP = "Even-Str0nger!"
# dB currently holds a valid session; dA changes the password
st, _, b = dA.call("POST", "/api/auth/password", {"currentPassword": "wrong", "newPassword": NEWP})
ok(st == 403, "change password with wrong current -> 403")
st, _, b = dA.call("POST", "/api/auth/password", {"currentPassword": P, "newPassword": NEWP})
ok(st == 200 and b.get("ok"), "change password succeeds")
st, _, b = dA.call("GET", "/api/auth/me")
ok(st == 200, "device A still authenticated after change (cookie re-issued)")
st, _, b = dB.call("GET", "/api/auth/me")
ok(st == 401, "device B session invalidated by password change (tokenVersion bump)")
st, _, b = d0.call("POST", "/api/auth/login", {"username": U, "password": P})
ok(st == 401, "old password no longer works")
st, _, b = dB.call("POST", "/api/auth/login", {"username": U, "password": NEWP})
ok(st == 200, "new password works")

# ---------------- logout ----------------
section("logout")
st, h, b = dA.call("POST", "/api/auth/logout", {})
ok(st == 200, "logout returns 200")
ok("Max-Age=0" in h.get("Set-Cookie", ""), "logout clears cookie (Max-Age=0)")
st, _, b = dA.call("GET", "/api/auth/me")
ok(st == 401, "after logout, me -> 401")

# ---------------- lockout ----------------
section("brute-force lockout")
LU = "lock_" + str(int(time.time())) + "y"
dL = Device(); dL.call("POST", "/api/auth/register", {"username": LU, "password": P})
dL.call("POST", "/api/auth/logout", {})
codes = []
for i in range(9):
    st, _, _ = d0.call("POST", "/api/auth/login", {"username": LU, "password": "nope"})
    codes.append(st)
ok(429 in codes, f"account locks after repeated failures (codes={codes})")

print(f"\nRESULT: {passed} passed, {failed} failed")
import sys; sys.exit(1 if failed else 0)
