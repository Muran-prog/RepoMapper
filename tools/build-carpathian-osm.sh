#!/usr/bin/env bash
# Build the Carpathian OSM vector PMTiles overlay using a custom Planetiler
# profile. Emits the source-layers the renderer expects:
#
#   hiking_route      lines  with osmc_symbol/network/ref/name
#   mountain_feature  points with class/ele/name/prominence/rank
#   forest_road       lines  with tracktype/surface/sac_scale/trail_visibility
#   ski_piste         lines
#   cableway          lines
#
# Output: tools/.work/carpathian-osm/carpathian-osm.pmtiles
#
# Requires the Ukraine Geofabrik extract (~700 MB) and a working Planetiler
# install (planetiler.jar — see tools/README.md). Total run time on a
# modern laptop: ~5-10 minutes.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# Allow overriding the Java + pmtiles binaries (e.g. when using a portable
# JRE in tools/.work/jre and the pmtiles binary in tools/.work/bin) and
# the Planetiler heap size for low-RAM hosts. Defaults match a system
# install with 12 GB free RAM.
JAVA_BIN="${JAVA_BIN:-java}"
PMTILES_BIN="${PMTILES_BIN:-pmtiles}"
PLANETILER_XMX="${PLANETILER_XMX:-12g}"
NEED_CMDS=(curl)
[ "$JAVA_BIN" = "java" ] && NEED_CMDS+=(java)
[ "$PMTILES_BIN" = "pmtiles" ] && NEED_CMDS+=(pmtiles)
need "${NEED_CMDS[@]}"

WORK="$(work_dir carpathian-osm)"
cd "$WORK"

PLANETILER_JAR="${PLANETILER_JAR:-$TOOLS_DIR/planetiler.jar}"
if [ ! -f "$PLANETILER_JAR" ]; then
  echo "planetiler.jar not found at $PLANETILER_JAR" >&2
  echo "Download a release from https://github.com/onthegomap/planetiler/releases" >&2
  exit 2
fi

EXTRACT_URL="${OSM_EXTRACT_URL:-https://download.geofabrik.de/europe/ukraine-latest.osm.pbf}"
EXTRACT_PBF="$WORK/ukraine-latest.osm.pbf"
if [ ! -f "$EXTRACT_PBF" ]; then
  echo "downloading $EXTRACT_URL …"
  curl -L -o "$EXTRACT_PBF" "$EXTRACT_URL"
fi

# Bbox to clip to the Carpathian extent (saves output size on a Ukraine-wide build).
read -r W S E N <<<"$(carpathian_bbox)"

"$JAVA_BIN" "-Xmx$PLANETILER_XMX" -jar "$PLANETILER_JAR" \
  generate-custom \
  --schema="$TOOLS_DIR/carpathian-profile.yml" \
  --osm-path="$EXTRACT_PBF" \
  --bounds="$W,$S,$E,$N" \
  --output="$WORK/carpathian-osm.mbtiles" \
  --force

ARCHIVE="$WORK/carpathian-osm.pmtiles"
"$PMTILES_BIN" convert "$WORK/carpathian-osm.mbtiles" "$ARCHIVE"
final_url_hint "$ARCHIVE" "TERRAIN.carpathianOsm.url"
