"""Use CI's Databricks identity to retrieve the publication-ready Pages feed."""

import json
import math
import os
from pathlib import Path, PurePosixPath
import sys


MAX_BYTES = 32 * 1024 * 1024
METADATA = {"sourceName", "publishedAt", "classifiedAsOf", "sourceUrl", "projectionSourceUrl", "locationAuditUrl"}
FACILITY_TEXT = {
    "id", "name", "pin", "city", "district", "state", "address", "phone", "phoneSourceUrl", "website",
    "capacityStatus", "capacitySource", "capacitySourceUrl",
}
FACILITY_NUMBERS = {"lat", "lon", "beds", "bedsLow", "bedsHigh"}
MATCH_TEXT = {"kind", "term", "excerpt"}
MATCH_NUMBERS = {"index", "confidence", "match", "servicePoints", "branchPoints"}
PROJECTION_FIELDS = {
    "facility_id", "projection_facility_id", "care_needed", "unit", "scope", "period", "caseload",
    "capacity", "caseload_predicted", "capacity_predicted", "caseload_method", "capacity_method",
    "source_url", "capacity_source_url",
}


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or not all(
        isinstance(snapshot.get(field), field_type) and snapshot[field]
        for field, field_type in {"publishedAt": str, "sourceUrl": str, "facilities": list,
                                  "services": list, "matches": dict}.items()
    ) or not isinstance(snapshot.get("projections"), list):
        raise ValueError("The Databricks file does not match the Facility Finder public feed schema.")
    if (snapshot.keys() - METADATA - {"facilities", "services", "matches", "projections"}
            or any(not isinstance(snapshot[key], str) for key in METADATA & snapshot.keys())):
        raise ValueError("The public feed has unrecognized metadata.")

    labels = set()
    for service in snapshot["services"]:
        if (not isinstance(service, dict) or service.keys() != {"label", "urgent"}
                or not isinstance(service["label"], str) or not isinstance(service["urgent"], bool)
                or service["label"] in labels):
            raise ValueError("The public feed contains an invalid service entry.")
        labels.add(service["label"])
    if snapshot["matches"].keys() != labels:
        raise ValueError("The public feed must contain one match list for each service.")

    for facility in snapshot["facilities"]:
        if (not isinstance(facility, dict) or facility.keys() - FACILITY_TEXT - FACILITY_NUMBERS
                or not isinstance(facility.get("name"), str)
                or not all(finite_number(facility.get(key)) for key in ("lat", "lon"))
                or any(not isinstance(facility[key], str) for key in FACILITY_TEXT & facility.keys())
                or any(facility[key] is not None and not finite_number(facility[key])
                       for key in FACILITY_NUMBERS & facility.keys())):
            raise ValueError("The public feed contains an invalid or unrecognized facility field.")

    for matches in snapshot["matches"].values():
        if not isinstance(matches, list):
            raise ValueError("The public feed contains an invalid service match list.")
        for match in matches:
            if (not isinstance(match, dict) or match.keys() != MATCH_TEXT | MATCH_NUMBERS | {"urls", "projectionEligible"}
                    or type(match["index"]) is not int or not 0 <= match["index"] < len(snapshot["facilities"])
                    or not all(isinstance(match[key], str) for key in MATCH_TEXT)
                    or not all(finite_number(match[key]) for key in MATCH_NUMBERS)
                    or not isinstance(match["projectionEligible"], bool) or not isinstance(match["urls"], list)
                    or not all(isinstance(url, str) for url in match["urls"])):
                raise ValueError("The public feed contains an invalid or unrecognized service match field.")

    for projection in snapshot["projections"]:
        if (not isinstance(projection, dict) or projection.keys() != PROJECTION_FIELDS
                or not all(isinstance(value, str) for value in projection.values())):
            raise ValueError("The public feed contains an invalid or unrecognized projection field.")


def read_snapshot(contents):
    raw = bytearray()
    for chunk in iter(lambda: contents.read(1024 * 1024), b""):
        raw.extend(chunk)
        if len(raw) > MAX_BYTES:
            raise ValueError("The public snapshot exceeds the 32 MB build limit.")
    snapshot = json.loads(raw)
    validate_snapshot(snapshot)
    snapshot["sourceName"] = "Databricks published snapshot"
    return snapshot


def main(output):
    from databricks.sdk import WorkspaceClient

    path = PurePosixPath(os.environ.get("DATABRICKS_PAGES_SNAPSHOT", ""))
    if path.parts[:2] != ("/", "Volumes") or len(path.parts) < 6 or ".." in path.parts or path.name != "data.json":
        raise ValueError("Set DATABRICKS_PAGES_SNAPSHOT to the approved data.json in a Unity Catalog volume.")
    response = WorkspaceClient().files.download(str(path))
    with response.contents as contents:
        snapshot = read_snapshot(contents)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n",
                      encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
