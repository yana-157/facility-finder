import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {attachClassicData, fetchRoutingResponse, haversineKm, parseRouteMatrix, rankFacilities, resolveOrigin} from "../ranking.js";

// Use a public city centroid, with the same facility snapshot and ranking code as the page.
const file = process.argv[2] ? pathToFileURL(process.argv[2]) : new URL("../data.json", import.meta.url);
const bytes = await readFile(file);
const data = JSON.parse(bytes);
const jaipur = resolveOrigin(data, {type: "city", query: "Jaipur", state: "Rajasthan"});
const mumbai = resolveOrigin(data, {type: "city", query: "Mumbai", state: "Maharashtra"});
const service = "Dialysis";
const snapshotSha256 = createHash("sha256").update(bytes).digest("hex");
const classic = JSON.parse(await readFile(new URL("classic-data.json", file), "utf8"));
attachClassicData(data, classic, snapshotSha256);
const siteOrigin = "https://yana-157.github.io";
const headers = {Origin: siteOrigin};
const options = {credentials: "omit", redirect: "error"};
const preflight = await fetchRoutingResponse({
  ...options, method: "OPTIONS", signal: AbortSignal.timeout(45000), headers: {...headers, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type"},
}, snapshotSha256);
assert.ok(preflight.ok, "The public page's routing preflight returned HTTP " + preflight.status);
assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), siteOrigin);
assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /content-type/i);
assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /POST/i);
async function requestMatrix(travelMode, origin) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchRoutingResponse({
      ...options, method: "POST", signal: AbortSignal.timeout(45000),
      headers: {...headers, "Content-Type": "application/json"},
      body: JSON.stringify({origin: {lat: origin.lat, lon: origin.lon}, service, snapshotSha256, travelMode}),
    }, snapshotSha256);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), siteOrigin);
    if (response.ok) return parseRouteMatrix(await response.json(), data.matches[service], travelMode);
    const problem = await response.json().catch(() => null);
    const retryAfter = Number(response.headers.get("Retry-After"));
    if (response.status === 429 && attempt < 2 && retryAfter > 0 && retryAfter <= 60) {
      console.log(`Retrying ${travelMode} after ${retryAfter} seconds.`);
      await delay((retryAfter + 1) * 1000);
      continue;
    }
    throw new Error(`${travelMode} request returned HTTP ${response.status}. ${problem?.error ?? ""}`);
  }
}

// Compute fit independently from the raw companion's equipment/staff coverage and facility
// records. Missing fields carry no weight. Documented zero remains different from unknown.
function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function snapshotFit(assessment, position, weights) {
  const fields = classic.facilities[assessment.index];
  const {equipment, staff} = classic.services[service];
  const coverage = classic.matches[service][position].flatMap((indices, i) => {
    const required = [equipment, staff][i].length;
    return Array.isArray(indices) && required ? [indices.length / required] : [];
  });
  const quality = [];
  if (fields.accreditation) quality.push(1);
  if (Number.isFinite(fields.rating) && fields.rating >= 0 && fields.rating <= 5) quality.push(fields.rating / 5);
  const ageMonths = (Date.parse(data.classifiedAsOf) - Date.parse(fields.lastVerified)) / (30 * 86400000);
  const freshness = !Number.isFinite(ageMonths) || ageMonths < 0 ? null : ageMonths <= 6 ? 1 : ageMonths <= 12 ? 0.8 : 0.5;
  const components = [
    [average(coverage), weights.capability],
    [typeof fields.open24h === "boolean" ? Number(fields.open24h) : null, weights.availability],
    [average(quality), weights.quality],
    [freshness, weights.freshness],
  ].filter(([value, weight]) => value !== null && weight > 0);
  if (!components.length) return null;
  const weight = components.reduce((sum, [, weight]) => sum + weight, 0);
  const sum = components.reduce((total, [value, weight]) => total + value * weight, 0);
  return Math.round(10 * assessment.match * sum / weight) / 10;
}

const curve = score => 1 / (1 + Math.exp((score - 55) / 3.5));
const penaltyMinutes = score => 60 * (curve(score) - curve(100)) / (curve(0) - curve(100));

// Reuse each live matrix to check real branches across the tier boundaries and with
// undocumented fit. These are ordinary slider settings; they require no extra API calls.
const defaultWeights = {capability: 0.4, availability: 0.25, quality: 0.2, freshness: 0.15};
const weightCases = [undefined,
  {capability: 0.50, availability: 0.50, quality: 0, freshness: 0},
  {capability: 0.45, availability: 0.55, quality: 0, freshness: 0},
  {capability: 0.40, availability: 0.60, quality: 0, freshness: 0},
  {capability: 0, availability: 0, quality: 1, freshness: 0},
];
const expectedCases = weightCases.map(fitWeights => ({
  fitWeights,
  evidence: data.matches[service].map((assessment, position) => {
    const fit = snapshotFit(assessment, position, fitWeights ?? defaultWeights);
    const tier = fit > 0 ? [50, 55, 60].filter(cutoff => fit >= cutoff).length : null;
    return {index: assessment.index, fit, tier, confidence: assessment.confidence,
      confidencePenalty: penaltyMinutes(assessment.confidence)};
  }),
}));

function verifyRanking({origin, routeMatrix, fitWeights, evidence}) {
  const {secondsByIndex, travelMode} = routeMatrix;
  const args = {service, origin, routeMatrix, limit: secondsByIndex.size, fitWeights};
  const eligible = evidence.filter(row => secondsByIndex.has(row.index) && row.confidence >= 25 && row.fit !== 0).map(row => {
    const minutes = secondsByIndex.get(row.index) / 60;
    return {...row, minutes, cost: minutes + row.confidencePenalty, km: haversineKm(origin, data.facilities[row.index])};
  });
  const indices = rows => rows.map(row => row.index).sort((a, b) => a - b);
  const expectedMembers = indices(eligible);
  const fastest = rankFacilities(data, {...args, sort: "distance"}).results;
  assert.deepEqual(indices(fastest.map(row => row.assessment)), expectedMembers,
    `${travelMode}: Fastest eligibility differs from the snapshot.`);
  assert.deepEqual(fastest.map(row => row.travelMinutes), eligible.map(row => row.minutes).sort((a, b) => a - b),
    `${travelMode}: Fastest must sort eligible branches by provider minutes.`);
  for (const sort of ["straightLine", "fit", "confidence", "beds", "name", "occupancy", "priorities"]) {
    const alternate = rankFacilities(data, {...args, sort, priorities: ["evidence", "travel"]}).results;
    assert.deepEqual(indices(alternate.map(row => row.assessment)), expectedMembers,
      `${travelMode}: ${sort} must exclude confidence below 25 and fit of zero, while permitting unknown fit.`);
  }

  const expected = eligible.filter(row => row.fit > 0)
    .sort((a, b) => b.tier - a.tier || a.cost - b.cost || a.minutes - b.minutes || a.km - b.km);
  const recommended = rankFacilities(data, args).results;
  assert.deepEqual(recommended.map(row => row.assessment.index), expected.map(row => row.index),
    `${travelMode}: Recommended order must use descending fit tier, then ascending travel plus confidence penalty.`);
  for (const [i, row] of expected.entries()) {
    const actual = recommended[i];
    assert.ok(actual.fitScore > 0 && Math.abs(actual.fitScore - row.fit) < 1e-8);
    assert.equal(actual.fitTier, row.tier);
    assert.equal(actual.scoreParts.travel, row.minutes);
    assert.ok(Math.abs(actual.scoreParts.confidencePenalty - row.confidencePenalty) < 1e-8);
    assert.ok(Math.abs(actual.recommendedScore - row.cost) < 1e-8);
  }
  return {recommended, fastest};
}

const jaipurMatrices = new Set();
const observedTiers = new Set();
for (const travelMode of ["driving", "walking", "cycling", "public_transport"]) {
  const origin = travelMode === "public_transport" ? mumbai : jaipur;
  const routeMatrix = await requestMatrix(travelMode, origin);
  assert.equal(routeMatrix.travelMode, travelMode);
  const seconds = routeMatrix.secondsByIndex;
  assert.ok(new Set(seconds.values()).size >= 2, `Need two distinct ${travelMode} times to verify the ranking.`);
  if (origin === jaipur) jaipurMatrices.add(JSON.stringify([...seconds].sort(([a], [b]) => a - b)));
  for (const test of expectedCases) {
    const {recommended, fastest} = verifyRanking({origin, routeMatrix, ...test});
    for (const row of recommended) observedTiers.add(row.fitTier);
    if (!test.fitWeights) {
      const first = recommended[0];
      const outcome = first ? `${first.facility.name} (fit ${first.fitScore.toFixed(1)}, ${first.travelMinutes.toFixed(1)} minutes)`
        : "no reachable branch with eligible confidence and documented positive fit";
      console.log(`${origin.label} ${service}, ${travelMode}: ${seconds.size} routed; ${fastest.length} eligible for Fastest, ${recommended.length} for Recommended. Recommended: ${outcome}.`);
    }
  }
}
assert.deepEqual([...observedTiers].sort(), [0, 1, 2, 3], "The live cases need positive-fit branches spanning the four fit tiers.");
assert.equal(jaipurMatrices.size, 3, "Driving, walking, and cycling must return distinct route matrices for this Jaipur search.");
