"""Build Facility Finder's public static data from the team's published release."""

import argparse
from collections import Counter
import csv
from datetime import date
import io
import json
import math
from pathlib import Path
import re
import subprocess
import sys

import pandas as pd


REPOSITORY_URL = "https://github.com/augustchu/datathon-F26"
SOURCE_REF = "9fe804b11058a18001bf78ae6d2a7cd9960281cf"
LOCATION_AUDIT_REF = "af89658"
FACILITIES_PATH = "max-supplemented-data/capacity_and_confidence/facilities_newest_capacity.csv"
PROJECTIONS_PATH = "first-prototype/projected_load.csv"
EXACT_ID = re.compile(r"fdr:[^:\s]+")
PROJECTION_KINDS = {"corroborated", "hospital_site", "directory", "record_listing"}
WITHHELD_CAPACITY = {"missing", "branch_identity_hold", "review_unresolved", "target_quality_hold", "withheld"}


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], text=True, encoding="utf-8")


def source_url(ref, path):
    return f"{REPOSITORY_URL}/blob/{ref}/{path}"


def taxonomy(source):
    """Read the classifier's service choices without starting the Streamlit app."""
    import ast

    tree = ast.parse((source / "first-prototype/classic_dashboard.py").read_text(encoding="utf-8"))
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "SERVICES" for target in statement.targets
        ):
            return {
                ast.literal_eval(key): {keyword.arg: ast.literal_eval(keyword.value) for keyword in value.keywords}
                for key, value in zip(statement.value.keys, statement.value.values, strict=True)
            }
    raise ValueError("The prototype service taxonomy is unavailable.")


def pin_code(value):
    match = re.search(r"(?<!\d)([1-8]\d{5})(?!\d)", value)
    return match[1] if match else ""


def positive_number(value):
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) and number > 0 else None


def contact_phone(value):
    value = value.strip().strip("'")
    digits = re.sub(r"\D", "", value)
    if re.fullmatch(r"[+0-9 .()-]+", value) and 10 <= len(digits) <= 13 and len(set(digits)) > 2:
        return value
    return ""


def record_urls(value, safe_url):
    try:
        urls = json.loads(value)
    except ValueError:
        urls = [value]
    if isinstance(urls, str):
        urls = [urls]
    if not isinstance(urls, list):
        return []
    return list(dict.fromkeys(url for item in urls if (url := safe_url(item))))[:3]


def build(source, as_of):
    sys.path.insert(0, str(source / "first-prototype"))
    from classic_confidence import _source_url, assess_service_confidence
    from pipeline import eligible_facility_locations

    audit_path = "first-prototype/location_routing_holds.json"
    local_audit = (source / audit_path).read_text(encoding="utf-8")
    if local_audit != git(source, "show", f"{LOCATION_AUDIT_REF}:{audit_path}"):
        raise ValueError("The classifier's location holds differ from the published audit.")
    services = taxonomy(source)
    facility_csv = git(source, "show", f"{SOURCE_REF}:{FACILITIES_PATH}")
    published_at = git(source, "log", "-1", "--format=%cI", SOURCE_REF, "--", FACILITIES_PATH).strip()
    columns = {
        "facility_id", "unique_id", "name", "latitude", "longitude", "pin", "city", "district", "state",
        "address", "routing_eligible", "published_phone", "phone_source_url", "website", "capacity",
        "capacity_status", "capacity_source", "capacity_source_url", "capacity_prediction_lower",
        "capacity_prediction_upper", "specialties", "capability", "procedure", "equipment", "description",
        "source_urls",
    }
    raw = pd.read_csv(io.StringIO(facility_csv), usecols=columns, dtype=str, keep_default_na=False)
    source_counts = Counter(raw["unique_id"])
    branch_counts = Counter(raw["facility_id"])
    eligible = eligible_facility_locations(raw)

    facilities = []
    matches = {label: [] for label in services}
    for index, row in enumerate(eligible.to_dict("records")):
        branch = row["facility_id"]
        source_id = row["unique_id"]
        pin = pin_code(row["pin"])
        exact_id = ""
        if (EXACT_ID.fullmatch(branch) and branch == "fdr:" + source_id
                and branch_counts[branch] == 1 and source_counts[source_id] == 1):
            exact_id = branch
        lat, lon = float(row["latitude"]), float(row["longitude"])
        status = row["capacity_status"]
        beds = positive_number(row["capacity"]) if status.casefold() not in WITHHELD_CAPACITY else None
        facilities.append({
            "id": exact_id, "name": row["name"] or "Unnamed facility", "lat": lat, "lon": lon,
            "pin": pin, "city": row["city"], "district": row["district"] or row["city"], "state": row["state"],
            "address": row["address"], "phone": contact_phone(row["published_phone"]),
            "phoneSourceUrl": _source_url(row["phone_source_url"]), "website": _source_url(row["website"]),
            "beds": beds, "capacityStatus": status, "capacitySource": row["capacity_source"],
            "capacitySourceUrl": _source_url(row["capacity_source_url"]),
            "bedsLow": positive_number(row["capacity_prediction_lower"]) if beds is not None else None,
            "bedsHigh": positive_number(row["capacity_prediction_upper"]) if beds is not None else None,
        })
        row.update(pin=pin, source_id=source_id, equity_facility_id=exact_id)
        links = record_urls(row["source_urls"], _source_url)
        for label, details in services.items():
            assessment = assess_service_confidence(row, label, details["aliases"], as_of=as_of)
            if not (assessment.evidence_points and assessment.term and assessment.excerpt):
                continue
            matches[label].append({
                "index": index, "confidence": assessment.score, "match": assessment.match_score,
                "kind": assessment.kind, "term": assessment.term, "excerpt": assessment.excerpt,
                "urls": list(assessment.urls) or links,
                "servicePoints": assessment.evidence_points, "branchPoints": assessment.branch_points,
                "projectionEligible": bool(exact_id and assessment.match_score == 100 and assessment.kind in PROJECTION_KINDS),
            })

    projections_csv = git(source, "show", f"{SOURCE_REF}:{PROJECTIONS_PATH}")
    return {
        "sourceName": "Published GitHub snapshot",
        "publishedAt": published_at,
        "classifiedAsOf": as_of.isoformat(),
        "sourceUrl": source_url(SOURCE_REF, FACILITIES_PATH),
        "projectionSourceUrl": source_url(SOURCE_REF, PROJECTIONS_PATH),
        "locationAuditUrl": source_url(LOCATION_AUDIT_REF, audit_path),
        "services": [{"label": label, "urgent": details["urgent"]} for label, details in services.items()],
        "facilities": facilities,
        "matches": matches,
        "projections": list(csv.DictReader(io.StringIO(projections_csv))),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Team checkout with the corrected Facility Finder classifier")
    parser.add_argument("--as-of", type=date.fromisoformat, default=date(2026, 11, 22),
                        help="Review validity date, in YYYY-MM-DD format")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("data.json"))
    args = parser.parse_args()
    data = build(args.source.resolve(), args.as_of)
    with args.output.open("w", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        output.write("\n")
    print(f"Wrote {len(data['facilities']):,} facilities and {len(data['services'])} services to {args.output}")


if __name__ == "__main__":
    main()
