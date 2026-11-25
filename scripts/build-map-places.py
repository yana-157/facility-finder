"""Build the local map's named postal landmarks from the team India Post directory.

Run in the Pages checkout with the path to load-balancing-pipeline/india_post_pincode_directory.csv.
The pinned source is documented in map-places.json. Coordinates are published office locations.
"""
import argparse
import csv
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

SOURCE = "https://github.com/augustchu/datathon-F26/blob/ed9d1a87692ce4990d6932cb6fdb337efd38ffd4/load-balancing-pipeline/india_post_pincode_directory.csv"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
facilities = json.loads(Path("data.json").read_text())["facilities"]
by_cell = defaultdict(list)
for facility in facilities:
    lat, lon = facility["lat"], facility["lon"]
    if isinstance(lat, (float, int)) and isinstance(lon, (float, int)):
        by_cell[math.floor(lat * 10), math.floor(lon * 10)].append((lat, lon))

city_counts = Counter(facility["city"].casefold() for facility in facilities if facility["city"])
landmarks = {}
with args.directory.open(encoding="utf-8-sig") as csvfile:
    for office in csv.DictReader(csvfile):
        try:
            lat, lon = float(office["latitude"]), float(office["longitude"])
        except (ValueError, TypeError):
            continue
        if not 6.5 <= lat <= 37.5 or not 68 <= lon <= 97.5:
            continue
        name = re.sub(r"\s+(?:[bsh]\.?\s*o\.?|g\.?\s*p\.?\s*o\.?)$", "", office["officename"].strip(), flags=re.I)
        if not name:
            continue
        # Every head office can label the regional view. Keep other offices close to
        # facility catchments. Thin dense areas to one landmark per ~1.5 km cell.
        tier = {"HO": 0, "PO": 1, "BO": 2}.get(office["officetype"])
        if tier is None:
            continue
        if tier:
            y, x = math.floor(lat * 10), math.floor(lon * 10)
            longitude_scale = math.cos(math.radians(lat))
            near = any(
                (lat - a) ** 2 + ((lon - b) * longitude_scale) ** 2 <= (6 / 111.32) ** 2
                for i in range(y - 1, y + 2) for j in range(x - 1, x + 2)
                for a, b in by_cell.get((i, j), ())
            )
            if not near:
                continue
        cell = (math.floor(lat * 70), math.floor(lon * 70))
        candidate = (tier, -city_counts[name.casefold()], len(name), name, round(lat, 4), round(lon, 4))
        if cell not in landmarks or candidate < landmarks[cell]:
            landmarks[cell] = candidate

rows = []
rural_cells = set()
for tier, _, _, name, lat, lon in sorted(landmarks.values()):
    cell = (math.floor(lat * 20), math.floor(lon * 20))
    if tier == 2 and cell in rural_cells:
        continue
    rural_cells.add(cell)
    rows.append([lat, lon, name, tier])
Path("map-places.json").write_text(json.dumps({"source": SOURCE, "places": rows}, separators=(",", ":"), ensure_ascii=False) + "\n")
