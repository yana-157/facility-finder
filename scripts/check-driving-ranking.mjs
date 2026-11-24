import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {ROUTING_URL, parseRouteMatrix, rankFacilities, resolveOrigin} from "../ranking.js";

// Use a public city centroid, with the same facility snapshot and ranking code as the page.
const file = process.argv.slice(2).find(arg => arg !== "--private") || new URL("../data.json", import.meta.url);
const bytes = await readFile(file);
const data = JSON.parse(bytes);
const origin = resolveOrigin(data, {type: "city", query: "Jaipur", state: "Rajasthan"});
const service = "Dialysis";
const snapshotSha256 = createHash("sha256").update(bytes).digest("hex");
const siteOrigin = "https://yana-157.github.io";
const headers = {Origin: siteOrigin};
if (process.argv.includes("--private")) {
  // A private Sites service token may be supplied through stdin before public rollout.
  const parts = [];
  for await (const part of process.stdin) parts.push(part);
  const token = Buffer.concat(parts).toString("utf8").trim();
  assert.ok(token, "Private routing verification requires a Sites service token.");
  assert.equal(new URL(ROUTING_URL).origin, "https://facility-finder-routing-yana.yanayana.chatgpt.site");
  headers["OAI-Sites-Authorization"] = "Bearer " + token;
}
const options = {redirect: "error", signal: AbortSignal.timeout(45000)};
const preflight = await fetch(ROUTING_URL, {
  ...options, method: "OPTIONS", headers: {...headers, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type"},
});
assert.ok(preflight.ok, "The public page's routing preflight returned HTTP " + preflight.status);
assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), siteOrigin);
assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /content-type/i);
assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /POST/i);
const response = await fetch(ROUTING_URL, {
  ...options, method: "POST", headers: {...headers, "Content-Type": "application/json"},
  body: JSON.stringify({origin: {lat: origin.lat, lon: origin.lon}, service, snapshotSha256}),
});
if (!response.ok) {
  const problem = await response.json().catch(() => null);
  const message = typeof problem?.error === "string" ? problem.error.slice(0,160) : "No routing error description.";
  throw new Error(`The routing backend returned HTTP ${response.status}. ${message}`);
}
assert.equal(response.headers.get("Access-Control-Allow-Origin"), siteOrigin);
const routeMatrix = parseRouteMatrix(await response.json(), data.matches[service]);
assert.ok(new Set(routeMatrix.secondsByIndex.values()).size >= 2, "Need two distinct driving times for a ranking comparison.");
const args = {service, origin, routeMatrix, limit: 5};
const fastest = rankFacilities(data, {...args, sort: "distance"}).results;
const expectedSeconds = [...routeMatrix.secondsByIndex.values()].sort((a, b) => a - b).slice(0, 5);
assert.deepEqual(fastest.map(r => r.driveMinutes), expectedSeconds.map(s => s / 60));

// Independently reconstruct the default score from the provider's raw seconds and published evidence.
const curve = confidence => 1 / (1 + Math.exp((confidence - 55) / 3.5));
const expectedScores = data.matches[service].filter(row => routeMatrix.secondsByIndex.has(row.index)).map(row => {
  const confidenceCost = 60 * (curve(row.confidence) - curve(100)) / (curve(0) - curve(100));
  return routeMatrix.secondsByIndex.get(row.index) / 60 + 10 * (1 - row.match / 100) + confidenceCost;
}).sort((a, b) => a - b).slice(0, 5);
const recommended = rankFacilities(data, args).results;
assert.equal(recommended.length, expectedScores.length);
for (const [i, result] of recommended.entries()) {
  assert.equal(result.scoreParts.travel, routeMatrix.secondsByIndex.get(result.assessment.index) / 60);
  assert.ok(Math.abs(result.recommendedScore - expectedScores[i]) < 1e-8, "Recommended order differs from the driving/evidence score.");
}
console.log(`Jaipur dialysis: verified ${routeMatrix.secondsByIndex.size} routed branches at ${routeMatrix.calculatedAt.toISOString()}.`);
console.table(recommended.map(r => ({branch: r.facility.name, drivingMinutes: r.driveMinutes.toFixed(1)})));
