import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {ROUTING_URL, parseRouteMatrix, rankFacilities, resolveOrigin} from "../ranking.js";

// Use a public city centroid, with the same facility snapshot and ranking code as the page.
const file = process.argv[2] || new URL("../data.json", import.meta.url);
const bytes = await readFile(file);
const data = JSON.parse(bytes);
const jaipur = resolveOrigin(data, {type: "city", query: "Jaipur", state: "Rajasthan"});
const mumbai = resolveOrigin(data, {type: "city", query: "Mumbai", state: "Maharashtra"});
const service = "Dialysis";
const snapshotSha256 = createHash("sha256").update(bytes).digest("hex");
const siteOrigin = "https://yana-157.github.io";
const headers = {Origin: siteOrigin};
const options = {credentials: "omit", redirect: "error"};
const preflight = await fetch(ROUTING_URL, {
  ...options, method: "OPTIONS", signal: AbortSignal.timeout(45000), headers: {...headers, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type"},
});
assert.ok(preflight.ok, "The public page's routing preflight returned HTTP " + preflight.status);
assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), siteOrigin);
assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /content-type/i);
assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /POST/i);
async function requestMatrix(travelMode, origin) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(ROUTING_URL, {
      ...options, method: "POST", signal: AbortSignal.timeout(45000),
      headers: {...headers, "Content-Type": "application/json"},
      body: JSON.stringify({origin: {lat: origin.lat, lon: origin.lon}, service, snapshotSha256, travelMode}),
    });
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

const curve = confidence => 1 / (1 + Math.exp((confidence - 55) / 3.5));
const jaipurMatrices = new Set();
for (const travelMode of ["driving", "walking", "cycling", "public_transport"]) {
  const origin = travelMode === "public_transport" ? mumbai : jaipur;
  const routeMatrix = await requestMatrix(travelMode, origin);
  assert.equal(routeMatrix.travelMode, travelMode);
  const seconds = routeMatrix.secondsByIndex;
  assert.ok(new Set(seconds.values()).size >= 2, `Need two distinct ${travelMode} times to verify the ranking.`);
  if (origin === jaipur) jaipurMatrices.add(JSON.stringify([...seconds].sort(([a], [b]) => a - b)));
  const args = {service, origin, routeMatrix, limit: 5};
  const fastest = rankFacilities(data, {...args, sort: "distance"}).results;
  const expectedTimes = [...seconds.values()].sort((a, b) => a - b).slice(0, 5);
  assert.deepEqual(fastest.map(r => r.travelMinutes), expectedTimes.map(s => s / 60));

  // Reconstruct Recommended from the selected mode's raw seconds and the published evidence.
  const expectedScores = data.matches[service].filter(row => seconds.has(row.index)).map(row => {
    const confidenceCost = 60 * (curve(row.confidence) - curve(100)) / (curve(0) - curve(100));
    return seconds.get(row.index) / 60 + 10 * (1 - row.match / 100) + confidenceCost;
  }).sort((a, b) => a - b).slice(0, 5);
  const recommended = rankFacilities(data, args).results;
  assert.equal(recommended.length, expectedScores.length);
  for (const [i, result] of recommended.entries()) {
    assert.equal(result.scoreParts.travel, seconds.get(result.assessment.index) / 60);
    assert.ok(Math.abs(result.recommendedScore - expectedScores[i]) < 1e-8, `Incorrect Recommended order for ${travelMode}.`);
  }
  console.log(`${origin.label} dialysis, ${travelMode}: ${seconds.size} reachable; fastest is ${fastest[0].facility.name} (${fastest[0].travelMinutes.toFixed(1)} minutes).`);
}
assert.equal(jaipurMatrices.size, 3, "Driving, walking, and cycling must return distinct route matrices for this Jaipur search.");
