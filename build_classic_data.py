"""Build the public fit and contact companion for the exact Pages snapshot."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import sys

import pandas as pd

from build_data import FACILITIES_PATH, SOURCE_REF, git, source_url, taxonomy

CLASSIC_REF = "ed9d1a87692ce4990d6932cb6fdb337efd38ffd4"
ROOT = Path(__file__).resolve().parent
# Clinical observations lasting 24 hours are common. Require an explicit opening-hours statement.
OPEN_ALL_DAY = re.compile(
    r"\b(?:open|operates?|operating|remains? open|stays? open)\s+(?:for\s+)?"
    r"(?:24\s*(?:[×x/]\s*7|hours?\b)|around the clock|round the clock)\b", re.I,
)
NEGATED_HOURS = re.compile(r"\b(?:not|never|no longer|doesn['’]t|isn['’]t|used to)\s+(?:\w+\s+){0,2}$", re.I)


def matched_indices(required, recorded):
    """An empty list indicates documented text with no matching term; null means missing text."""
    if not recorded:
        return None
    return [index for index, term in enumerate(required)
            if any(term.casefold() in entry or entry in term.casefold() for entry in recorded)]


def build(source, snapshot_path):
    # Load the same taxonomy and point screening code that built the original public file.
    for filename in ("classic_dashboard.py", "pipeline.py", "location_routing_holds.json"):
        path = "first-prototype/" + filename
        if (source / path).read_text() != git(source, "show", f"{CLASSIC_REF}:{path}"):
            raise ValueError(f"Use the prototype at {CLASSIC_REF} for {filename}.")
    sys.path.insert(0, str(source / "first-prototype"))
    from pipeline import _items, eligible_facility_locations

    raw = snapshot_path.read_bytes()
    snapshot = json.loads(raw)
    if snapshot["sourceUrl"] != source_url(SOURCE_REF, FACILITIES_PATH):
        raise ValueError("The public file and classic fields must come from the same source release.")
    catalog = taxonomy(source)
    if [option["label"] for option in snapshot["services"]] != list(catalog):
        raise ValueError("Service catalog differs from the pinned prototype.")
    services = {name: {"specialty": row["specialty"], "area": row["area"],
                       "equipment": row["equip"], "staff": row["staff"]} for name, row in catalog.items()}
    release = pd.read_csv(io.StringIO(git(source, "show", f"{SOURCE_REF}:{FACILITIES_PATH}")),
                          dtype=str, keep_default_na=False)
    rows = eligible_facility_locations(release).to_dict("records")
    fields = []
    equipment = []
    staff = []
    for index, (facility, row) in enumerate(zip(snapshot["facilities"], rows, strict=True)):
        if (facility["id"] and facility["id"] != row["facility_id"]
            or (facility["name"], facility["lat"], facility["lon"], facility["address"]) !=
                (row["name"] or "Unnamed facility", float(row["latitude"]), float(row["longitude"]), row["address"])):
            raise ValueError(f"Facility {index} does not match the reviewed release row.")
        details = {}
        # A few shifted CSV fields contain coordinates, URLs or IDs. Only publish known categories.
        if row["operatorTypeId"] in {"public", "private", "government"}:
            details["ownership"] = row["operatorTypeId"].title()
        if row["facilityTypeId"] in {"hospital", "clinic", "dentist", "doctor", "pharmacy", "farmacy"}:
            details["facilityType"] = row["facilityTypeId"].replace("farmacy", "pharmacy").title()
        if row["source"] == "kie":
            details["source"] = row["source"]
        for field in ("description", "capability", "specialties", "procedure"):
            statement = row[field]
            if any(not NEGATED_HOURS.search(statement[max(0, match.start() - 35):match.start()])
                   for match in OPEN_ALL_DAY.finditer(statement)):
                details["open24h"] = True
                break
        fields.append(details)
        equipment.append([term.casefold() for term in _items(row["equipment"])])
        staff.append([term.casefold() for term in _items(row["specialties"])])
    matches = {}
    for name, assessments in snapshot["matches"].items():
        matches[name] = [[matched_indices(services[name]["equipment"], equipment[a["index"]]),
                          matched_indices(services[name]["staff"], staff[a["index"]])] for a in assessments]
    return {"snapshotSha256": hashlib.sha256(raw).hexdigest(), "sourceRef": SOURCE_REF, "prototypeRef": CLASSIC_REF,
            "services": services, "facilities": fields, "matches": matches}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Team checkout at " + CLASSIC_REF)
    parser.add_argument("--snapshot", type=Path, default=ROOT / "data.json")
    parser.add_argument("--output", type=Path, default=ROOT / "classic-data.json")
    args = parser.parse_args()
    companion = build(args.source.resolve(), args.snapshot)
    args.output.write_text(json.dumps(companion, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n",
                           encoding="utf-8")
    print(f"Wrote {len(companion['facilities']):,} source-matched facilities to {args.output.name}")


if __name__ == "__main__":
    main()
