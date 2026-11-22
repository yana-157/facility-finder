# Databricks notebook source
"""Publish the checked-in Facility Finder Pages snapshot to Unity Catalog Delta tables."""

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
from urllib.parse import urlsplit


FACILITIES_TABLE = "workspace.default.first_prototype_facilities"
METADATA_TABLE = "workspace.default.first_prototype_snapshot_metadata"
PAGES_REPOSITORY = "https://github.com/yana-157/facility-finder"
CONVERTER_VERSION = 1
BRANCH_ID = re.compile(r"fdr:[^:\s]+")
EVIDENCE_POINTS = {"corroborated": 80, "hospital_site": 75, "directory": 70, "record_listing": 50, "mention": 15}
REVIEWED_KINDS = {"corroborated", "hospital_site", "directory"}
FACILITY_COLUMNS = {
    "facility_id": "STRING", "source_id": "STRING", "facility_name": "STRING", "pin": "STRING",
    "latitude": "DOUBLE", "longitude": "DOUBLE", "address": "STRING", "city": "STRING", "district": "STRING",
    "state": "STRING", "phone": "STRING", "phone_source_url": "STRING", "website_url": "STRING",
    "beds_for_scenario": "DOUBLE", "beds_provenance": "STRING", "capacity_release_status": "STRING",
    "capacity_release_source": "STRING", "capacity_release_source_url": "STRING",
    "capacity_prediction_lower": "DOUBLE", "capacity_prediction_upper": "DOUBLE",
    "branch_confidence_points": "INT", "branch_routing_hold": "BOOLEAN", "location_search_eligible": "BOOLEAN",
    "service_text": "STRING", "source_urls_json": "STRING", "facility_display_source": "STRING",
    "snapshot_prepared_at": "STRING", "snapshot_source_sha256": "STRING", "snapshot_converter_version": "INT",
}
METADATA_COLUMNS = {
    "prepared_at": "STRING", "facility_rows": "LONG", "service_count": "INT", "service_matches": "LONG",
    "source_name": "STRING", "source_url": "STRING", "source_published_at": "STRING", "source_classified_as_of": "STRING",
    "projection_source_url": "STRING", "location_audit_url": "STRING", "source_repository": "STRING",
    "snapshot_source_sha256": "STRING", "snapshot_converter_version": "INT",
}


def source_link(value):
    if not isinstance(value, str) or re.search(r"[\s<>\x00-\x1f\x7f]", value):
        return ""
    parsed = urlsplit(value)
    return value if parsed.scheme in {"https", "http"} and parsed.hostname and parsed.username is None else ""


def positive_number(value):
    if value is None:
        return None
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("The published capacity must be positive and finite.")
    return number


def service_columns(service_keys):
    return {
        f"{field}_{key}": data_type
        for key in service_keys
        for field, data_type in (
            ("service_evidence_kind", "STRING"), ("term", "STRING"), ("excerpt", "STRING"),
            ("service_evidence_sources", "STRING"), ("claim_citable", "BOOLEAN"),
        )
    }


def convert_snapshot(payload, prepared_at):
    """Validate the public artifact and prepare data, schema and provenance for a Delta publish."""
    snapshot = json.loads(payload)
    checksum = hashlib.sha256(payload).hexdigest()
    facilities = snapshot["facilities"]
    names = [service["label"] for service in snapshot["services"]]
    keys = {name: re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_") for name in names}
    if (not facilities or not names or len(keys) != len(names) or not all(keys.values())
            or len(set(keys.values())) != len(keys) or set(snapshot["matches"]) != set(names)):
        raise ValueError("The published snapshot has invalid facilities or service lists.")

    rows = []
    known_ids = set()
    for index, facility in enumerate(facilities):
        branch_id = facility["id"]
        if branch_id:
            if not BRANCH_ID.fullmatch(branch_id) or branch_id in known_ids:
                raise ValueError(f"Invalid or duplicate exact branch ID at facility index {index}.")
            known_ids.add(branch_id)
        latitude, longitude = float(facility["lat"]), float(facility["lon"])
        if not (6.5 <= latitude <= 37.5 and 68 <= longitude <= 97.5):
            raise ValueError(f"Invalid routing point at facility index {index}.")
        pin = facility["pin"]
        if pin and not re.fullmatch(r"[1-8][0-9]{5}", pin):
            raise ValueError(f"Invalid PIN at facility index {index}.")
        status = facility["capacityStatus"]
        rows.append({
            "facility_id": branch_id or f"pages-row:{index}", "source_id": branch_id.removeprefix("fdr:"),
            "facility_name": facility["name"], "pin": pin, "latitude": latitude, "longitude": longitude,
            "address": facility.get("address", ""), "city": facility["city"], "district": facility["district"],
            "state": facility["state"], "phone": facility["phone"], "phone_source_url": source_link(facility.get("phoneSourceUrl")),
            "website_url": source_link(facility["website"]), "beds_for_scenario": positive_number(facility["beds"]),
            "beds_provenance": f"release: {status}" if status else "", "capacity_release_status": status,
            "capacity_release_source": facility["capacitySource"], "capacity_release_source_url": source_link(facility["capacitySourceUrl"]),
            "capacity_prediction_lower": positive_number(facility.get("bedsLow")),
            "capacity_prediction_upper": positive_number(facility.get("bedsHigh")),
            "branch_confidence_points": None, "branch_routing_hold": False, "location_search_eligible": True,
            "service_text": "", "facility_display_source": snapshot["sourceName"],
            "snapshot_prepared_at": prepared_at, "snapshot_source_sha256": checksum,
            "snapshot_converter_version": CONVERTER_VERSION,
        })

    record_urls = [{} for _ in rows]
    match_count = 0
    for service, key in keys.items():
        seen = set()
        for match in snapshot["matches"][service]:
            index, kind = match["index"], match["kind"]
            if type(index) is not int or not 0 <= index < len(rows) or index in seen or kind not in EVIDENCE_POINTS:
                raise ValueError(f"Invalid service match for {service} at index {index}.")
            seen.add(index)
            row = rows[index]
            term, excerpt = match["term"], match["excerpt"]
            branch = match["branchPoints"]
            points = EVIDENCE_POINTS[kind]
            if (not isinstance(term, str) or not term.strip() or not isinstance(excerpt, str) or not excerpt.strip()
                    or branch not in {0, 10, 20} or points != match["servicePoints"]
                    or match["confidence"] != points + branch or match["match"] != (40 if kind == "mention" else 100)
                    or row["branch_confidence_points"] not in {None, branch}):
                raise ValueError(f"Invalid service evidence or confidence for {service} at index {index}.")
            urls = tuple(dict.fromkeys(url for text in match["urls"] if (url := source_link(text))))
            if kind in REVIEWED_KINDS:
                minimum_urls = 2 if kind == "corroborated" else 1
                if not row["source_id"] or not row["pin"] or len(urls) < minimum_urls:
                    raise ValueError(f"Reviewed evidence for {service} lacks required branch details or links.")
            else:
                record_urls[index].update(dict.fromkeys(urls))
            row.update({
                "branch_confidence_points": branch,
                f"service_evidence_kind_{key}": kind,
                f"term_{key}": term,
                f"excerpt_{key}": excerpt,
                f"service_evidence_sources_{key}": json.dumps([{"url": url, "excerpt": excerpt} for url in urls], ensure_ascii=False),
                f"claim_citable_{key}": bool(urls),
            })
            match_count += 1

    for row, urls in zip(rows, record_urls, strict=True):
        row["branch_confidence_points"] = row["branch_confidence_points"] or 0
        row["source_urls_json"] = json.dumps(list(urls), ensure_ascii=False)

    metadata = {
        "prepared_at": prepared_at, "facility_rows": len(rows), "service_count": len(keys), "service_matches": match_count,
        "source_name": snapshot["sourceName"], "source_url": source_link(snapshot["sourceUrl"]),
        "source_published_at": snapshot["publishedAt"], "source_classified_as_of": snapshot.get("classifiedAsOf", ""),
        "projection_source_url": source_link(snapshot.get("projectionSourceUrl")),
        "location_audit_url": source_link(snapshot.get("locationAuditUrl")), "source_repository": PAGES_REPOSITORY,
        "snapshot_source_sha256": checksum, "snapshot_converter_version": CONVERTER_VERSION,
    }
    return rows, {**FACILITY_COLUMNS, **service_columns(keys.values())}, metadata


# COMMAND ----------

def ddl(columns):
    return ", ".join(f"`{name}` {data_type}" for name, data_type in columns.items())


def previous_publication(spark, table, timestamp_field):
    if not spark.catalog.tableExists(table):
        return None
    data = spark.table(table)
    columns = [timestamp_field, "snapshot_source_sha256", "snapshot_converter_version"]
    if not set(columns).issubset(data.columns):
        raise ValueError(f"{table} already exists with a different data source. Choose a new destination before overwriting it.")
    distinct = data.select(*columns).distinct().limit(2).collect()
    return distinct[0] if len(distinct) == 1 else None


def publish_snapshot(spark, payload):
    checksum = hashlib.sha256(payload).hexdigest()
    prior = previous_publication(spark, FACILITIES_TABLE, "snapshot_prepared_at")
    prior_meta = previous_publication(spark, METADATA_TABLE, "prepared_at")
    matches = prior is not None and (
        prior["snapshot_source_sha256"], prior["snapshot_converter_version"]
    ) == (checksum, CONVERTER_VERSION)
    if matches and prior_meta is not None and tuple(prior) == tuple(prior_meta):
        print(f"Pages snapshot {checksum[:12]} is already published. No Delta tables changed.")
        return

    prepared_at = prior["snapshot_prepared_at"] if matches else datetime.now(timezone.utc).isoformat()
    rows, columns, metadata = convert_snapshot(payload, prepared_at)
    if not matches:
        facilities = spark.createDataFrame(rows, schema=ddl(columns))
        facilities.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(FACILITIES_TABLE)
    # If a previous run could publish the rows but not the metadata, repair only the metadata.
    spark.createDataFrame([metadata], schema=ddl(METADATA_COLUMNS)).write.format("delta").mode("overwrite").option(
        "overwriteSchema", "true",
    ).saveAsTable(METADATA_TABLE)
    print(f"Published {len(rows):,} facilities and {metadata['service_matches']:,} service matches from Pages snapshot {checksum[:12]}.")


# COMMAND ----------

if "spark" in globals():
    # Runtime 14+ and serverless notebooks read local workspace files relative to the notebook.
    cwd = Path.cwd()
    root = cwd.parent if cwd.name == "databricks" else cwd
    public_snapshot = root / "data.json"
    if not public_snapshot.is_file():
        raise FileNotFoundError("Run this notebook from a Git checkout containing the public data.json.")
    publish_snapshot(spark, public_snapshot.read_bytes())
