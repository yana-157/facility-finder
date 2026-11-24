const EARTH_RADIUS_KM = 6371;
const MATCH_PENALTY_MAX_KM = 5;
const CONFIDENCE_PENALTY_MAX_KM = 30;
const CONFIDENCE_MIDPOINT = 55;
const CONFIDENCE_WIDTH = 3.5;
const BRANCH_ID = /^fdr:[^:\s]+$/u;
const EXACT_EVIDENCE = new Set(["corroborated", "hospital_site", "directory", "record_listing"]);
const TIME_CRITICAL_SERVICES = new Set([
  "Emergency C-section", "Trauma / emergency", "NICU", "Burn care", "Cardiac surgery", "Fracture care", "Stroke care",
]);
const PIN_PREFIX_RANGES = [[11, 28], [30, 34], [36, 53], [56, 64], [67, 85]];
const COLLATOR = new Intl.Collator("en-IN");

export const MAX_EXTRA_KM = 10;
export const ROUTING_URL = "https://facility-finder-routing-yana.yanayana.chatgpt.site/api/routes";
const MAX_EXTRA_MINUTES = 15;
const MINUTES_PER_KM_EQUIVALENT = 2;

export function parseRouteMatrix(payload, assessments) {
  const calculatedAt = new Date(payload?.calculatedAt);
  if (!Array.isArray(payload?.routes) || typeof payload.calculatedAt !== "string"
      || !Number.isFinite(calculatedAt.getTime())) {
    throw new Error("Invalid routing response.");
  }
  const expected = new Set(assessments.map(row => row.index));
  const secondsByIndex = new Map();
  for (const {index, seconds} of payload.routes) {
    if (!expected.has(index) || secondsByIndex.has(index) || !Number.isFinite(seconds)
        || seconds < 0 || seconds > 10800) {
      throw new Error("Invalid facility driving time.");
    }
    secondsByIndex.set(index, seconds);
  }
  return {secondsByIndex, calculatedAt};
}

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function key(value) {
  return cleanText(value).toLowerCase();
}

function decimal(value) {
  if (typeof value === "number") return value;
  const text = cleanText(value);
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(text) ? Number(text) : NaN;
}

function inIndia(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 6.5 && lat <= 37.5 && lon >= 68 && lon <= 97.5;
}

export function haversineKm(origin, destination) {
  const radians = Math.PI / 180;
  const latitudeDelta = (destination.lat - origin.lat) * radians;
  const longitudeDelta = (destination.lon - origin.lon) * radians;
  const term = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(origin.lat * radians) * Math.cos(destination.lat * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, term)));
}

function centroid(facilities, label) {
  const total = facilities.reduce((sum, facility) => ({
    lat: sum.lat + facility.lat,
    lon: sum.lon + facility.lon,
  }), {lat: 0, lon: 0});
  return {lat: total.lat / facilities.length, lon: total.lon / facilities.length, label, approximate: true};
}

export function resolveOrigin(data, {type, query, state, lat, lon}) {
  if (type === "coordinates") {
    const latitude = decimal(lat);
    const longitude = decimal(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Enter latitude and longitude as decimal numbers.");
    }
    if (!inIndia(latitude, longitude)) {
      throw new Error("Enter coordinates within India for this facility dataset.");
    }
    return {lat: latitude, lon: longitude, label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, approximate: false};
  }

  const facilities = data.facilities.filter(facility => inIndia(facility.lat, facility.lon));
  if (type === "pin") {
    const pin = cleanText(query).replace(/\s/gu, "");
    if (!/^[1-8]\d{5}$/u.test(pin)) {
      throw new Error("Enter a six-digit Indian PIN code.");
    }
    const region = Number(pin.slice(0, 2));
    if (!PIN_PREFIX_RANGES.some(([first, last]) => region >= first && region <= last)) {
      throw new Error("Enter a PIN code from an assigned Indian postal region.");
    }
    const exact = facilities.filter(facility => facility.pin === pin);
    if (exact.length) {
      return centroid(exact, `PIN ${pin}`);
    }
    const area = pin.slice(0, 3);
    const nearby = facilities.filter(facility => facility.pin?.startsWith(area));
    if (nearby.length) {
      return centroid(nearby, `PIN area ${area}xxx near ${pin}`);
    }
    throw new Error(`No facility coordinates are available near PIN ${pin}. Try a city or coordinates.`);
  }

  if (type !== "city" && type !== "district") {
    throw new Error("Choose PIN, city, district, or coordinates.");
  }
  const place = cleanText(query);
  const placeKey = key(place);
  const stateKey = key(state);
  if (!place) {
    throw new Error(`Enter a ${type} name.`);
  }
  const matches = facilities.filter(facility => key(facility[type]) === placeKey
    && (!stateKey || key(facility.state) === stateKey));
  if (!matches.length) {
    throw new Error(`No facility coordinates are available for ${place}. Check the spelling or enter coordinates.`);
  }
  const stateKeys = new Set(matches.map(facility => key(facility.state)).filter(Boolean));
  if (stateKeys.size > 1) {
    throw new Error(`Enter the state to distinguish ${place} from other places with this name.`);
  }
  const knownState = matches.find(facility => key(facility.state))?.state;
  return centroid(matches, [matches[0][type], knownState].filter(Boolean).join(", "));
}

function confidencePenalty(confidence) {
  const curve = score => 1 / (1 + Math.exp((score - CONFIDENCE_MIDPOINT) / CONFIDENCE_WIDTH));
  const clamped = Math.min(100, Math.max(0, confidence));
  return CONFIDENCE_PENALTY_MAX_KM * (curve(clamped) - curve(100)) / (curve(0) - curve(100));
}

function compareRecommended(left, right) {
  return left.recommendedScore - right.recommendedScore || left.scoreParts.travel - right.scoreParts.travel
    || left.distanceKm - right.distanceKm;
}

const OTHER_SORTS = {
  distance: (left, right) => left.scoreParts.travel - right.scoreParts.travel,
  confidence: (left, right) => right.assessment.confidence - left.assessment.confidence,
  beds: (left, right) => (right.facility.beds ?? -1) - (left.facility.beds ?? -1),
  name: (left, right) => COLLATOR.compare(left.facility.name, right.facility.name),
};

function projectionsFor(projections, service) {
  const matching = new Map();
  const ambiguous = new Set();
  for (const row of projections) {
    if (key(row.care_needed) !== key(service) || !BRANCH_ID.test(row.facility_id)) continue;
    const prior = matching.get(row.facility_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      ambiguous.add(row.facility_id);
    }
    matching.set(row.facility_id, row);
  }

  const usable = new Map();
  for (const [id, row] of matching) {
    const caseload = decimal(row.caseload);
    const capacity = decimal(row.capacity);
    if (ambiguous.has(id) || !BRANCH_ID.test(row.projection_facility_id)) continue;
    if (!Number.isFinite(caseload) || caseload < 0 || !Number.isFinite(capacity) || capacity <= 0) continue;
    if (![row.unit, row.scope, row.period].every(value => cleanText(value))) continue;
    usable.set(id, {row, caseload, capacity});
  }
  return usable;
}

function compareProjectedLoad(ranked, projections, service) {
  if (!ranked.length) return 0;
  const published = projectionsFor(projections, service);
  const counts = new Map();
  for (const {facility} of ranked) {
    counts.set(facility.id, (counts.get(facility.id) ?? 0) + 1);
  }

  function projectionFor(result) {
    const {assessment, facility} = result;
    if (assessment.projectionEligible !== true || assessment.match !== 100 || !EXACT_EVIDENCE.has(assessment.kind)) {
      return undefined;
    }
    return counts.get(facility.id) === 1 ? published.get(facility.id) : undefined;
  }

  const baseline = ranked[0];
  const anchor = projectionFor(baseline);
  if (!anchor) return 0;
  const detourLimit = baseline.driveMinutes == null ? MAX_EXTRA_KM : MAX_EXTRA_MINUTES;

  const comparable = new Set();
  let winner = 0;
  let winningScore = Infinity;
  for (const [index, result] of ranked.entries()) {
    const extraTravelKm = Math.max(0, result.distanceKm - baseline.distanceKm);
    const extraTravel = Math.max(0, result.scoreParts.travel - baseline.scoreParts.travel);
    if (extraTravelKm > MAX_EXTRA_KM || extraTravel > detourLimit || result.assessment.kind !== baseline.assessment.kind) continue;
    const projection = projectionFor(result);
    if (!projection) continue;
    const {row, caseload, capacity} = projection;
    if (["unit", "scope", "period"].some(field => row[field] !== anchor.row[field])) continue;
    if (comparable.has(row.projection_facility_id)) continue;
    const pressure = 1 - 1 / (1 + caseload / capacity);
    const comparisonScore = (extraTravel / detourLimit + pressure) / 2;
    comparable.add(row.projection_facility_id);
    result.projectedLoad = {
      caseload, capacity, pressure, comparisonScore, extraTravelKm,
      unit: row.unit, scope: row.scope, period: row.period,
      caseloadPredicted: key(row.caseload_predicted) === "true",
      capacityPredicted: key(row.capacity_predicted) === "true",
      sourceUrl: row.source_url,
      capacitySourceUrl: row.capacity_source_url,
    };
    if (comparisonScore < winningScore) {
      winner = index;
      winningScore = comparisonScore;
    }
  }
  if (comparable.size < 2) {
    delete baseline.projectedLoad;
    return 0;
  }
  if (winner > 0) {
    ranked.unshift(...ranked.splice(winner, 1));
  }
  return comparable.size;
}

export function rankFacilities(data, {
  service, origin, sort = "recommended", severity = "routine", considerLoad = false, limit = 5, routeMatrix = null,
}) {
  const ranked = [];
  const penaltyScale = routeMatrix ? MINUTES_PER_KM_EQUIVALENT : 1;
  const assessments = Object.hasOwn(data.matches, service) ? data.matches[service] : [];
  for (const assessment of assessments) {
    const facility = data.facilities[assessment.index];
    if (!facility || !inIndia(facility.lat, facility.lon) || !assessment.term || !assessment.excerpt) continue;
    if (assessment.kind !== "mention" && !EXACT_EVIDENCE.has(assessment.kind)) continue;
    if (!Number.isFinite(assessment.confidence) || assessment.confidence <= 0) continue;
    if (assessment.match !== 40 && assessment.match !== 100) continue;
    if (routeMatrix && !routeMatrix.secondsByIndex.has(assessment.index)) continue;
    const distanceKm = haversineKm(origin, facility);
    const driveMinutes = routeMatrix ? routeMatrix.secondsByIndex.get(assessment.index) / 60 : null;
    const travel = driveMinutes ?? distanceKm;
    const matchPenalty = MATCH_PENALTY_MAX_KM * (1 - assessment.match / 100) * penaltyScale;
    const confidenceCost = confidencePenalty(assessment.confidence) * penaltyScale;
    ranked.push({
      facility,
      assessment,
      distanceKm,
      driveMinutes,
      scoreParts: {travel, matchPenalty, confidencePenalty: confidenceCost},
      recommendedScore: travel + matchPenalty + confidenceCost,
    });
  }
  const compare = Object.hasOwn(OTHER_SORTS, sort) ? OTHER_SORTS[sort] : compareRecommended;
  ranked.sort((left, right) => compare(left, right) || compareRecommended(left, right));
  ranked.forEach((result, index) => {
    result.baselineRank = index + 1;
  });
  const baselineFirst = ranked[0]?.facility ?? null;

  let loadStatus = "off";
  let comparisonCount = 0;
  if (considerLoad) {
    const urgentService = TIME_CRITICAL_SERVICES.has(service) || data.services.find(option => option.label === service)?.urgent;
    if (key(severity) !== "routine" || urgentService) {
      loadStatus = "urgency";
    } else if (sort !== "recommended") {
      loadStatus = "sort";
    } else {
      comparisonCount = compareProjectedLoad(ranked, data.projections, service);
      loadStatus = comparisonCount ? (ranked[0].baselineRank === 1 ? "compared" : "changed") : "unavailable";
    }
  }
  return {results: ranked.slice(0, limit), comparisonCount, baselineFirst, loadStatus};
}
