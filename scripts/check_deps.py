#!/usr/bin/env python3
"""
TripCalc external-dependency monitor.

Verifies CONTENT, not HTTP status. Every provider that has silently broken on us
returned HTTP 200 the whole time:
  - Carto served an "API KEY REQUIRED" watermark PNG at 200.
  - Esri dark serves a 2521-byte "Map data not yet available" tile at 200.

The core detector is CROSS-LOCATION UNIQUENESS: a real tile layer returns a
different image for every coordinate, while a watermark or placeholder is
byte-identical everywhere. That needs no maintained byte-size baseline and
catches any future constant-tile failure, whatever the provider does.

Run locally:  python3 scripts/check_deps.py
Exit 0 = all good, 1 = at least one FAIL.
"""

import hashlib
import json
import sys
import urllib.error
import urllib.request

TIMEOUT = 45
UA = "Mozilla/5.0 (compatible; TripCalc-depcheck/1.0; +https://tripcalc.bopaero.com)"
ORIGIN = "https://tripcalc.bopaero.com"

results = []  # (status, name, detail)


def record(ok, name, detail):
    results.append(("PASS" if ok else "FAIL", name, detail))


def get(url, headers=None):
    """Return (status, body_bytes). Raises only on transport errors."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# Three widely separated z12 tiles: NYC, Los Angeles, Chicago.
# Esri paths are /{z}/{y}/{x}; OSM is /{z}/{x}/{y}.
# name -> (url template, expected mime, min plausible bytes)
# The floor is per-layer on purpose. "Esri dark labels" is a TRANSPARENT OVERLAY:
# over open country it legitimately carries only a few labels and can be well
# under 1 KB, so a shared 3 KB floor false-positives on it. Opaque basemap tiles
# are never that small. The uniqueness check below is the real detector for all
# four layers; these floors are only a cheap second net.
TILE_TRIPLES = {
    "Esri dark base": (
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/12/{y}/{x}",
        "image/jpeg", 3000,
    ),
    "Esri dark labels": (
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/12/{y}/{x}",
        "image/png", 300,
    ),
    "Esri World_Imagery (SAT)": (
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/{y}/{x}",
        "image/jpeg", 3000,
    ),
    "OSM street": (
        "https://a.tile.openstreetmap.org/12/{x}/{y}.png",
        "image/png", 3000,
    ),
}

# (x, y) at z12
COORDS = [(1207, 1539), (700, 1636), (1050, 1520)]  # NYC, LAX, CHI

MAGIC = {
    "image/jpeg": b"\xff\xd8\xff",
    "image/png": b"\x89PNG\r\n\x1a\n",
}


def check_tiles():
    for name, (tmpl, mime, min_bytes) in TILE_TRIPLES.items():
        digests, sizes, bad = [], [], None
        for x, y in COORDS:
            url = tmpl.format(x=x, y=y)
            try:
                status, body = get(url)
            except Exception as e:
                bad = f"transport error: {e}"
                break
            if status != 200:
                bad = f"HTTP {status} from {url}"
                break
            if not body.startswith(MAGIC[mime]):
                bad = f"not a valid {mime} (got {body[:16]!r}) from {url}"
                break
            digests.append(hashlib.sha256(body).hexdigest())
            sizes.append(len(body))

        if bad:
            record(False, name, bad)
            continue

        # THE detector: identical bytes at three distant coordinates means the
        # provider is serving one constant image — a watermark or placeholder.
        if len(set(digests)) == 1:
            record(
                False,
                name,
                f"IDENTICAL tile at NYC/LAX/CHI ({sizes[0]} bytes, sha {digests[0][:12]}). "
                "This is the watermark/placeholder signature — look at the pixels.",
            )
            continue

        # Secondary: a real z12 map tile is never trivially small.
        if min(sizes) < min_bytes:
            record(False, name, f"suspiciously small tiles: {sizes} bytes (floor {min_bytes})")
            continue

        record(True, name, f"3 distinct tiles, {min(sizes)}-{max(sizes)} bytes")


def check_workers():
    org = {"Origin": ORIGIN}

    # Directions: must return real route geometry, not just a 200.
    try:
        status, body = get(
            "https://tripcalc-directions.compilotrc.workers.dev/"
            "?from=-73.7781,40.6413&to=-73.9857,40.7484",
            org,
        )
        d = json.loads(body)
        coords = d.get("coordinates") or []
        if status == 200 and len(coords) > 10 and d.get("durationS", 0) > 0:
            record(True, "Worker tripcalc-directions",
                   f"{len(coords)} coords, {d['durationS']/60:.0f} min")
        else:
            record(False, "Worker tripcalc-directions",
                   f"HTTP {status}, {len(coords)} coords, body={body[:160]!r}")
    except Exception as e:
        record(False, "Worker tripcalc-directions", f"error: {e}")

    # Fuel: must return a plausible price, not null/zero.
    try:
        status, body = get(
            "https://wandering-star-ec81.compilotrc.workers.dev/?icao=KJFK", org)
        d = json.loads(body)
        price = d.get("avgas_100ll")
        if status == 200 and isinstance(price, (int, float)) and 1 < price < 50:
            record(True, "Worker fuel", f"KJFK 100LL ${price}")
        else:
            record(False, "Worker fuel", f"HTTP {status}, body={body[:160]!r}")
    except Exception as e:
        record(False, "Worker fuel", f"error: {e}")

    # FBO fees: must return at least one FBO with fees.
    try:
        status, body = get(
            "https://fbo-fees.compilotrc.workers.dev/?icao=KJFK", org)
        d = json.loads(body)
        fbos = d.get("fbos") or []
        if status == 200 and fbos and fbos[0].get("fees"):
            record(True, "Worker fbo-fees", f"{len(fbos)} FBO(s) at KJFK")
        else:
            record(False, "Worker fbo-fees", f"HTTP {status}, body={body[:160]!r}")
    except Exception as e:
        record(False, "Worker fbo-fees", f"error: {e}")

    # Sync: token-gated. 401 without a token is the CORRECT, healthy answer.
    # A 200 here would mean the gate is open; a 404/5xx means it is broken.
    try:
        status, _ = get("https://tripcalc-sync.compilotrc.workers.dev/data", org)
        if status == 401:
            record(True, "Worker tripcalc-sync", "401 without token (correct)")
        else:
            record(False, "Worker tripcalc-sync",
                   f"expected 401 without token, got HTTP {status}")
    except Exception as e:
        record(False, "Worker tripcalc-sync", f"error: {e}")


def check_data_feeds():
    # OurAirports CSVs: check the header row and a floor on size, so a truncated
    # or error-page response cannot pass as a CSV.
    feeds = [
        ("OurAirports airports.csv",
         "https://davidmegginson.github.io/ourairports-data/airports.csv",
         b"ident", 5_000_000),
        ("OurAirports runways.csv",
         "https://davidmegginson.github.io/ourairports-data/runways.csv",
         b"airport_ref", 1_000_000),
        ("US cities CSV",
         "https://raw.githubusercontent.com/kelvins/US-Cities-Database/main/csv/us_cities.csv",
         b"CITY", 500_000),
    ]
    for name, url, header_token, min_bytes in feeds:
        try:
            status, body = get(url)
            first = body[:200].upper()
            if status == 200 and header_token.upper() in first and len(body) >= min_bytes:
                record(True, name, f"{len(body):,} bytes, header OK")
            else:
                record(False, name,
                       f"HTTP {status}, {len(body):,} bytes, first bytes={body[:80]!r}")
        except Exception as e:
            record(False, name, f"error: {e}")

    # Census geocoder (JSONP in the app; JSON here) must actually resolve an address.
    try:
        status, body = get(
            "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
            "?address=1600+Pennsylvania+Ave+NW+Washington+DC&benchmark=4&format=json")
        d = json.loads(body)
        matches = d.get("result", {}).get("addressMatches") or []
        if status == 200 and matches and "coordinates" in matches[0]:
            record(True, "Census geocoder", f"{len(matches)} match(es)")
        else:
            record(False, "Census geocoder",
                   f"HTTP {status}, {len(matches)} matches")
    except Exception as e:
        record(False, "Census geocoder", f"error: {e}")


def check_selftest():
    """Negative control: prove the uniqueness detector can still SEE a break.

    Esri dark caches street detail only to z16; above that it returns a
    "Map data not yet available" placeholder at HTTP 200 that is byte-identical
    everywhere. If we fetch it at three distant coordinates and DON'T get three
    identical hashes, the detector has lost its teeth and every PASS above is
    worthless. (Carto, the original watermark case, serves real tiles again as
    of 2026-09-12, so it is no longer usable as a control.)
    """
    tmpl = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
            "Canvas/World_Dark_Gray_Base/MapServer/tile/18/{y}/{x}")
    spots = [(77256, 98523), (44800, 104700), (67200, 97300)]
    try:
        digests = []
        for x, y in spots:
            status, body = get(tmpl.format(x=x, y=y))
            if status != 200:
                record(False, "SELFTEST detector", f"control tile HTTP {status}")
                return
            digests.append(hashlib.sha256(body).hexdigest())
        if len(set(digests)) == 1:
            record(True, "SELFTEST detector",
                   f"control placeholder correctly identical (sha {digests[0][:12]})")
        else:
            record(False, "SELFTEST detector",
                   "control tiles differ - detector can no longer prove it "
                   "catches constant-tile failures; re-pick a control")
    except Exception as e:
        record(False, "SELFTEST detector", f"error: {e}")


def main():
    check_selftest()
    check_tiles()
    check_workers()
    check_data_feeds()

    width = max(len(n) for _, n, _ in results)
    lines = [f"{s}  {n.ljust(width)}  {d}" for s, n, d in results]
    report = "\n".join(lines)
    print(report)

    failures = [r for r in results if r[0] == "FAIL"]
    print(f"\n{len(results) - len(failures)}/{len(results)} checks passed.")

    # Expose the report to later workflow steps (issue body, job summary).
    import os
    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a") as f:
            f.write("report<<TRIPCALC_EOF\n" + report + "\nTRIPCALC_EOF\n")
            f.write(f"failed={'true' if failures else 'false'}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as f:
            f.write("## TripCalc dependency check\n\n```\n" + report + "\n```\n")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
