import assert from "node:assert/strict";
import test from "node:test";
import {haversineKm, rankFacilities, resolveOrigin} from "../ranking.js";

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
      Dialysis: [0, 1, 2].map(index => ({index, kind: "directory", match: 100, confidence: 90,
        term: "dialysis", excerpt: "The branch provides dialysis.", projectionEligible: true})),
    },
    projections: [projection("near", 1000, 100), projection("nearby", 100, 900), projection("far", 0, 1000)],
  };
}

function search(data, options = {}) {
  return rankFacilities(data, {service: "Dialysis", origin, ...options});
}

test("uses distance and the published service-evidence penalties", () => {
  const data = fixture();
  data.matches.Dialysis[0] = {...data.matches.Dialysis[0], confidence: 25, kind: "mention", match: 40};
  data.matches.Dialysis[2] = {...data.matches.Dialysis[2], kind: "conflict"};
  const {results} = search(data);
  assert.deepEqual(results.map(result => result.facility.name), ["Nearby", "Nearest"]);
  assert.equal(results[1].scoreParts.matchPenalty, 3);
  assert.ok(results[1].scoreParts.confidencePenalty > 29.9);
  assert.equal(results[0].distanceKm, haversineKm(origin, data.facilities[1]));
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
