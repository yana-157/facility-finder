import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {attachClassicData, haversineKm, parseRouteMatrix, rankFacilities, resolveOrigin} from "../ranking.js";

const origin = {lat: 18.52, lon: 73.85};

function projection(id, caseload, capacity, override = {}) {
  return {
    facility_id: `fdr:${id}`, projection_facility_id: `fdr:${id}`,
    care_needed: "Dialysis", unit: "sessions", scope: "Haemodialysis", period: "Typical month",
    caseload, capacity, caseload_predicted: "True", capacity_predicted: "True", ...override,
  };
}

function fixture() {
  return {
    facilities: [
      {id: "fdr:near", name: "Nearest", ...origin, city: "Pune", district: "Pune", state: "Maharashtra", pin: "411001"},
      {id: "fdr:nearby", name: "Nearby", ...origin, lon: 73.855, city: "Pune", district: "Pune", state: "Maharashtra", pin: "411001"},
      {id: "fdr:far", name: "Outside detour", ...origin, lon: 74.15, city: "Daund", district: "Pune", state: "Maharashtra", pin: "413801"},
    ],
    services: [{label: "Dialysis", urgent: false}, {label: "NICU", urgent: true}],
    matches: {
      Dialysis: [0, 1, 2].map(index => ({index, kind: "directory", match: 100, confidence: 90, capability: 1,
        term: "dialysis", excerpt: "The branch provides dialysis.", projectionEligible: true})),
    },
    projections: [projection("near", 1000, 100), projection("nearby", 100, 900), projection("far", 0, 1000)],
  };
}

function search(data, options = {}) {
  return rankFacilities(data, {service: "Dialysis", origin, ...options});
}

function matrix(data, routes, travelMode = "driving") {
  return parseRouteMatrix({routes, travelMode, calculatedAt: "2026-11-24T12:00:00Z"}, data.matches.Dialysis, travelMode);
}

test("restored fields attach only to the exact published service and facility snapshot", async () => {
  const [source, companionSource] = await Promise.all(["data.json", "classic-data.json"].map(name =>
    readFile(new URL("../" + name, import.meta.url))));
  const data = JSON.parse(source);
  const companion = JSON.parse(companionSource);
  const digest = createHash("sha256").update(source).digest("hex");
  assert.throws(() => attachClassicData(data, companion, "0".repeat(64)), /do not match/);
  assert.throws(() => attachClassicData(data, {...companion, matches: {}}, digest), /catalog/);
  attachClassicData(data, companion, digest);
  assert.deepEqual(data.services.find(row => row.label === "Dialysis").equipment, ["hemodialysis machine", "RO water plant"]);
  assert.equal(new Set(data.services.map(row => row.specialty)).size, 13);
  assert.ok(data.facilities.some(row => row.ownership === "Public"));
  assert.ok(data.facilities.some(row => row.open24h === true));
  assert.ok(data.facilities.every(row => row.occupancy === null && row.hours === null && row.lastVerified === null));
  assert.ok(data.matches.Dialysis.some(row => row.matchedEquipment.length));
});

test("fit and occupancy only score reachable evidence-backed branches, retaining missing values", () => {
  const data = fixture();
  data.facilities[0].occupancy = 0.75;
  data.facilities[0].open24h = true;
  data.facilities[1].occupancy = 0.1;
  data.facilities[2].occupancy = 0;
  data.matches.Dialysis[0].capability = 0.25;
  data.matches.Dialysis[1].capability = 0.75;
  const routeMatrix = matrix(data, [{index: 0, seconds: 60}, {index: 1, seconds: 120}], "walking");
  const byFit = weights => search(data, {sort: "fit", routeMatrix, fitWeights: weights}).results;
  assert.deepEqual(byFit({capability: 1}).map(row => row.fitScore), [75, 25]);
  assert.deepEqual(byFit({availability: 1}).map(row => row.fitScore), [100, null]);
  assert.deepEqual(byFit({quality: 1}).map(row => row.fitScore), [null, null]);
  assert.deepEqual(byFit({capability: 0}).map(row => row.fitScore), [null, null]);
  assert.deepEqual(search(data, {sort: "occupancy", routeMatrix}).results.map(row => row.facility.occupancy), [0.1, 0.75]);
  data.matches.Dialysis[1].excerpt = "";
  assert.deepEqual(byFit({capability: 1}).map(row => row.fitScore), [25]);
});

test("ordered priorities use the selected mode's journey time and disclose missing observations", () => {
  const data = fixture();
  data.matches.Dialysis[0].confidence = 80;
  data.matches.Dialysis[1].confidence = 40;
  const routeMatrix = matrix(data, [{index: 0, seconds: 600}, {index: 1, seconds: 300}], "cycling");
  const result = priorities => search(data, {sort: "priorities", priorities, routeMatrix}).results;
  const [quick] = result(["travel", "evidence"]);
  assert.equal(quick.facility.name, "Nearby");
  assert.deepEqual(quick.priorityParts, [
    {criterion: "travel", value: 1, weight: 0.75}, {criterion: "evidence", value: 0.4, weight: 0.25},
  ]);
  assert.equal(quick.priorityScore, 85);
  assert.equal(result(["evidence", "travel"])[0].facility.name, "Nearest");
  assert.deepEqual(result(["spare"]).map(row => row.priorityScore), [null, null]);
  assert.deepEqual(result(["travel", "spare"]).map(row => row.priorityScore), [100, 0]);
  data.facilities[0].occupancy = 0.9;
  const [documented, unknown] = result(["spare"]);
  assert.equal(documented.facility.name, "Nearest");
  assert.equal(unknown.priorityScore, null);
  assert.equal(unknown.priorityParts[0].value, null);
});

test("the facility fit priority uses the slider weights and branch service match", () => {
  const data = fixture();
  data.facilities[0].open24h = false;
  data.facilities[1].open24h = true;
  Object.assign(data.matches.Dialysis[1], {kind: "mention", confidence: 25, match: 40, capability: 0.2});
  delete data.matches.Dialysis[2].capability;
  const options = {sort: "priorities", priorities: ["fit"]};
  assert.deepEqual(search(data, options).results.map(row => row.assessment.index), [0, 1, 2]);

  const fitWeights = {capability: 0.1, availability: 0.9, quality: 0, freshness: 0};
  const results = search(data, {...options, fitWeights}).results;
  assert.deepEqual(results.map(row => row.assessment.index), [1, 0, 2]);
  assert.deepEqual(results.map(row => row.fitScore), [36.8, 10, null]);
  for (const row of results) {
    assert.equal(row.priorityScore, row.fitScore);
    assert.deepEqual(row.priorityParts, [
      {criterion: "fit", value: row.fitScore === null ? null : row.fitScore / 100, weight: 1},
    ]);
  }
});

test("driving minutes reverse the distance order and exclude omitted branches for every sort", () => {
  const data = fixture();
  const routeMatrix = matrix(data, [{index: 0, seconds: 1800}, {index: 1, seconds: 600}]);
  assert.equal(search(data).results[0].facility.name, "Nearest");
  const routed = search(data, {routeMatrix}).results;
  assert.deepEqual(routed.map(row => row.facility.name), ["Nearby", "Nearest"]);
  assert.deepEqual(routed.map(row => row.driveMinutes), [10, 30]);
  assert.equal(search(data, {routeMatrix, sort: "beds"}).results.length, 2);
  assert.equal(search(data, {routeMatrix: matrix(data, [])}).results.length, 0);
  data.matches.Dialysis[1] = {...data.matches.Dialysis[1], confidence: 25, kind: "mention", match: 40};
  const [fastest] = search(data, {routeMatrix, sort: "distance"}).results;
  assert.equal(fastest.facility.name, "Nearby");
  assert.equal(fastest.fitScore, 40);
  assert.ok(fastest.scoreParts.confidencePenalty > 59.8);
  assert.equal(search(data, {routeMatrix}).results[0].facility.name, "Nearest");
});

test("routing preserves zero-second trips and rejects malformed or mismatched route rows", () => {
  const data = fixture();
  assert.equal(search(data, {routeMatrix: matrix(data, [{index: 0, seconds: 0}])}).results[0].driveMinutes, 0);
  for (const routes of [[{index: 0, seconds: -1}], [{index: 0, seconds: 10801}],
    [{index: 30, seconds: 5}], [{index: 0, seconds: 1}, {index: 0, seconds: 2}]]) {
    assert.throws(() => matrix(data, routes), /Invalid facility travel time/);
  }
  assert.throws(() => parseRouteMatrix({routes: []}, data.matches.Dialysis), /Invalid routing response/);
});

test("adjusted starts require permission and valid coordinates and apply to facility distances", () => {
  const data = fixture();
  const payload = {routes: [{index: 0, seconds: 600}, {index: 1, seconds: 120}], travelMode: "driving",
    calculatedAt: "2026-11-24T12:00:00Z", routedOrigin: {lat: origin.lat, lon: 73.855, label: "unused"}};
  const parse = (value, allow) => parseRouteMatrix(value, data.matches.Dialysis, "driving", allow);
  assert.throws(() => parse(payload, false), /starting point/);
  for (const invalid of [null, {}, {lat: "18", lon: 73}, {lat: NaN, lon: 73}, {lat: 18, lon: 181}, {lat: 72, lon: 18}]) {
    assert.throws(() => parse({...payload, routedOrigin: invalid}, true), /starting point/);
  }
  const routeMatrix = parse(payload, true);
  assert.deepEqual(routeMatrix.routedOrigin, {lat: origin.lat, lon: 73.855});
  assert.deepEqual(parse({...payload, routes: []}, true).routedOrigin, routeMatrix.routedOrigin);
  const {results} = search(data, {sort: "straightLine", routeMatrix});
  assert.equal(results[0].facility.name, "Nearby");
  assert.equal(results[0].distanceKm, 0);
  assert.equal(results[0].travelMinutes, 2);
  assert.equal(results[1].distanceKm, haversineKm(routeMatrix.routedOrigin, data.facilities[0]));
});

test("each transport mode ranks by its own estimates and preserves an empty result", () => {
  const data = fixture();
  for (const [mode, fastestIndex] of [["driving", 0], ["walking", 2], ["cycling", 1], ["public_transport", 2]]) {
    const routes = [0, 1, 2].map(index => ({index, seconds: index === fastestIndex ? 30 : 900}));
    const routeMatrix = matrix(data, routes, mode);
    assert.equal(routeMatrix.travelMode, mode);
    for (const sort of ["distance", "recommended"]) {
      const fastest = search(data, {routeMatrix, sort}).results[0];
      assert.equal(fastest.facility.id, data.facilities[fastestIndex].id);
      assert.equal(fastest.travelMinutes, 0.5);
      assert.equal(fastest.driveMinutes, mode === "driving" ? 0.5 : null);
    }
    assert.deepEqual(search(data, {routeMatrix: matrix(data, [], mode)}).results, []);
  }
});

test("rejects untagged matrices and matrices for another or unknown travel mode", () => {
  const {matches} = fixture();
  const payload = {routes: [{index: 0, seconds: 5}], calculatedAt: "2026-11-24T12:00:00Z"};
  assert.throws(() => parseRouteMatrix(payload, matches.Dialysis), /Invalid routing response/);
  assert.throws(() => parseRouteMatrix({...payload, travelMode: "driving"}, matches.Dialysis, "walking"), /Invalid routing response/);
  assert.throws(() => parseRouteMatrix({...payload, travelMode: "taxi"}, matches.Dialysis, "taxi"), /Invalid routing response/);
});

test("routed load comparison enforces both the driving-time and geographic detour limits", () => {
  const data = fixture();
  const searchWithDetour = seconds => search(data, {considerLoad: true,
    routeMatrix: matrix(data, [{index: 0, seconds: 600}, {index: 1, seconds}, {index: 2, seconds: 610}])});
  assert.equal(searchWithDetour(1501).loadStatus, "unavailable");
  const changed = searchWithDetour(660);
  assert.equal(changed.results[0].facility.name, "Nearby");
  assert.equal(changed.comparisonCount, 2);
  const load = changed.results[0].projectedLoad;
  assert.equal(load.comparisonScore, (1 / 15 + load.pressure) / 2);
});

test("projected load uses the selected mode's minutes for non-driving detours", () => {
  const data = fixture();
  const compare = seconds => search(data, {considerLoad: true, routeMatrix: matrix(data,
    [{index: 0, seconds: 60}, {index: 1, seconds}], "walking")});
  assert.equal(compare(960).comparisonCount, 2);
  assert.equal(compare(961).comparisonCount, 0);
});

test("the geographic fallback ranks by fit tier and then confidence-adjusted kilometres", () => {
  const data = fixture();
  data.matches.Dialysis[0] = {...data.matches.Dialysis[0], confidence: 25, kind: "mention", match: 40};
  data.matches.Dialysis[2] = {...data.matches.Dialysis[2], kind: "conflict"};
  const {results} = search(data);
  assert.deepEqual(results.map(result => result.facility.name), ["Nearby", "Nearest"]);
  assert.equal(results[1].fitTier, 0);
  assert.ok(results[1].scoreParts.confidencePenalty > 29.9);
  assert.equal(results[0].distanceKm, haversineKm(origin, data.facilities[1]));
});

test("all sorts require confidence of at least 25 and remove zero fit before limiting the list", () => {
  const data = fixture();
  const [zero, belowFloor, qualifiedMention] = data.matches.Dialysis;
  zero.capability = 0;
  Object.assign(belowFloor, {kind: "mention", match: 40, confidence: 24});
  Object.assign(qualifiedMention, {kind: "mention", match: 40, confidence: 25});
  const routeMatrix = matrix(data, [0, 1, 2].map(index => ({index, seconds: 60 * index})));
  for (const sort of ["recommended", "fit", "distance", "straightLine", "name", "confidence", "beds", "occupancy", "priorities"]) {
    const filtered = search(data, {sort, routeMatrix, limit: 1, priorities: ["travel"]});
    assert.equal(filtered.candidateCount, 3);
    assert.equal(filtered.lowConfidenceCount, 1);
    assert.deepEqual(filtered.results.map(row => row.assessment.index), [2], sort);
  }
  delete qualifiedMention.capability;
  const missing = search(data, {routeMatrix});
  assert.equal(missing.unknownFitCount, 1);
  assert.deepEqual(missing.results, []);
  assert.deepEqual(search(data, {routeMatrix, sort: "distance"}).results.map(row => row.fitScore), [null]);
  assert.deepEqual(search(data, {routeMatrix, fitWeights: {capability: 0}}).results, []);
});

test("a higher fit tier precedes even a zero-minute trip and the displayed score sets each boundary", () => {
  const data = fixture();
  const [quicker, longer] = data.matches.Dialysis;
  const routeMatrix = matrix(data, [{index: 0, seconds: 0}, {index: 1, seconds: 10800}]);
  longer.confidence = 50;
  for (const [lower, higher, tier] of [[49.9, 50, 1], [54.9, 55, 2], [59.9, 60, 3]]) {
    quicker.capability = lower / 100;
    longer.capability = higher / 100;
    const [first, second] = search(data, {routeMatrix}).results;
    assert.deepEqual([first.fitScore, first.fitTier, first.travelMinutes], [higher, tier, 180]);
    assert.deepEqual([second.fitScore, second.fitTier, second.travelMinutes], [lower, tier - 1, 0]);
  }
  quicker.capability = 0.5998;
  assert.equal(search(data, {routeMatrix}).results[0].fitTier, 3);
});

test("within the top fit tier confidence justifies a limited detour and the trip estimate stays intact", () => {
  const data = fixture();
  data.matches.Dialysis[0].capability = 0.85;
  data.matches.Dialysis[0].confidence = 60;
  data.matches.Dialysis[1].capability = 0.65;
  data.matches.Dialysis[1].confidence = 90;
  const trips = minutes => search(data, {routeMatrix: matrix(data,
    [{index: 0, seconds: 1200}, {index: 1, seconds: minutes * 60}], "walking")}).results;
  const [first, second] = trips(27);
  assert.deepEqual([first.assessment.index, first.fitTier, first.travelMinutes], [1, 3, 27]);
  assert.ok(Math.abs(second.recommendedScore - 31.60) < 0.01);
  assert.equal(second.travelMinutes, 20);
  assert.equal(trips(35)[0].assessment.index, 0);
});

test("changing fit weights can change the top recommendation on the same routes", () => {
  const data = fixture();
  data.facilities[0].open24h = false;
  data.facilities[1].open24h = true;
  data.matches.Dialysis[1].capability = 0.5;
  const routeMatrix = matrix(data, [{index: 0, seconds: 600}, {index: 1, seconds: 300}]);
  const results = fitWeights => search(data, {fitWeights, routeMatrix}).results.map(row => row.assessment.index);
  assert.deepEqual(results({capability: 1}), [0, 1]);
  assert.deepEqual(results({availability: 1}), [1]);
});

test("the workload option cannot cross fit tiers or exceed the confidence-adjusted detour cap", () => {
  const data = fixture();
  const routeMatrix = matrix(data, [{index: 0, seconds: 600}, {index: 1, seconds: 600}]);
  const comparison = () => search(data, {routeMatrix, considerLoad: true});
  assert.equal(comparison().results[0].assessment.index, 1);
  data.matches.Dialysis[1].capability = 0.55;
  assert.equal(comparison().loadStatus, "unavailable");
  assert.equal(comparison().results[0].assessment.index, 0);
  data.matches.Dialysis[1].capability = 0.8;
  data.matches.Dialysis[1].confidence = 50;
  assert.equal(comparison().loadStatus, "unavailable");
  assert.equal(comparison().results[0].assessment.index, 0);
});

test("only a routine opt-in can promote a comparable branch within the detour cap", () => {
  const data = fixture();
  const baseline = search(data);
  assert.equal(baseline.results[0].facility.name, "Nearest");
  assert.equal(baseline.loadStatus, "off");
  const optIn = search(data, {considerLoad: true});
  assert.equal(optIn.loadStatus, "changed");
  assert.equal(optIn.baselineFirst.name, "Nearest");
  assert.equal(optIn.comparisonCount, 2);
  assert.deepEqual(optIn.results.map(result => result.facility.name), ["Nearby", "Nearest", "Outside detour"]);
  assert.equal(optIn.results[0].baselineRank, 2);
  assert.ok(optIn.results[0].projectedLoad.comparisonScore < optIn.results[1].projectedLoad.comparisonScore);
  assert.equal(optIn.results[2].projectedLoad, undefined);
  assert.equal(search(data, {considerLoad: true, severity: "Urgent"}).loadStatus, "urgency");
  assert.equal(search(data, {considerLoad: true, sort: "distance"}).loadStatus, "sort");
  assert.equal(search(data, {considerLoad: true, service: "NICU"}).loadStatus, "urgency");
});

test("keeps the baseline when the projection anchor or comparable evidence is unavailable", () => {
  const data = fixture();
  data.projections[1].scope = "All services";
  assert.equal(search(data, {considerLoad: true}).loadStatus, "unavailable");
  data.projections[1].scope = data.projections[0].scope;
  data.projections.push(projection("near", 250, 200));
  const result = search(data, {considerLoad: true});
  assert.equal(result.loadStatus, "unavailable");
  assert.equal(result.results[0].facility.name, "Nearest");
  assert.equal(result.comparisonCount, 0);
});

test("uses labelled approximate centroids and rejects ambiguous or invalid origins", () => {
  const data = fixture();
  assert.deepEqual(resolveOrigin(data, {type: "pin", query: "411002"}), {
    lat: 18.52, lon: (73.85 + 73.855) / 2, label: "PIN area 411xxx near 411002", approximate: true,
  });
  assert.equal(resolveOrigin(data, {type: "city", query: " PUNE  "}).label, "Pune, Maharashtra");
  assert.equal(resolveOrigin(data, {type: "district", query: "Pune"}).approximate, true);
  assert.equal(resolveOrigin(data, {type: "coordinates", lat: "18.52", lon: "73.85"}).approximate, false);
  assert.throws(() => resolveOrigin(data, {type: "coordinates", lat: "abc", lon: "73.85"}), /decimal/);
  assert.throws(() => resolveOrigin(data, {type: "pin", query: "900100"}), /six-digit Indian PIN/);
  data.facilities.push({...data.facilities[0], state: "Other state"});
  assert.throws(() => resolveOrigin(data, {type: "city", query: "Pune"}), /state to distinguish/);
  assert.equal(resolveOrigin(data, {type: "city", query: "Pune", state: "Maharashtra"}).label, "Pune, Maharashtra");
});
