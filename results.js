import { TRAVEL_MODES } from "./ranking.js";

const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-IN", { style: "percent", maximumFractionDigits: 0 });
const evidenceLabels = {
  corroborated: "Hospital source and independent corroboration",
  hospital_site: "Listed by the hospital",
  directory: "Listed in a reviewed directory",
  record_listing: "Listed in the facility record",
  mention: "Mentioned in the facility record",
};
const criterionLabels = {
  travel: "Journey length", distance: "Journey length", evidence: "Service evidence",
  capability: "Equipment and staff", availability: "Round-the-clock operation",
  quality: "Accreditation and rating", freshness: "Record freshness", spare: "Spare capacity",
};
const capacityLabels = {
  xgboost_estimate: "XGBoost model estimate", fdr_reported: "Facility Data Registry",
  dated_external_report: "Dated external report", explicit_fdr_description: "Facility Data Registry description",
  direct_review: "Direct source review", approved_source_recovery: "Reviewed source recovery",
  review_unresolved: "Withheld pending review", missing: "Missing from the release",
};
const emptyText = /^(?:n\/a|null|none|nan)$/i;

function text(value) {
  const string = String(value ?? "").trim();
  return emptyText.test(string) ? "" : string;
}

function node(tag, content = "", className = "") {
  const element = document.createElement(tag);
  if (content) element.append(content);
  if (className) element.className = className;
  return element;
}

function link(label, url) {
  try {
    const address = new URL(url);
    if (!["https:", "http:"].includes(address.protocol) || address.username || address.password) return null;
    const result = node("a", label);
    result.href = address.href;
    result.target = "_blank";
    result.rel = "noopener noreferrer";
    return result;
  } catch {
    return null;
  }
}

function links(pairs) {
  const row = node("div", "", "card-links");
  for (const [title, url] of pairs) {
    const anchor = link(title, url);
    if (anchor) row.append(anchor);
  }
  return row;
}

function addressOf(facility) {
  return text(facility.address).split(",").map(text).filter(Boolean).join(", ") || "Not listed";
}

function phoneOf(facility) {
  const display = text(facility.phone);
  if (!display) return "Not listed";
  const numbers = display.split(/\s*(?:;|\/|,|\s+or\s+)\s*/i);
  const group = node("span");
  numbers.forEach((item, i) => {
    if (i) group.append(" / ");
    const dial = item.replace(/[\s().-]/g, "");
    if (/^\+?\d{7,15}$/.test(dial)) {
      const anchor = node("a", item);
      anchor.href = "tel:" + dial;
      group.append(anchor);
    } else {
      group.append(item);
    }
  });
  return group;
}

function hoursOf(facility) {
  return text(facility.hours) || (facility.open24h === true ? "Open 24 hours, per facility record" : "Not listed");
}

function bedsOf(facility) {
  const status = text(facility.capacityStatus);
  const value = facility.beds;
  const source = text(facility.capacitySource);
  const provenance = capacityLabels[status] || status.replaceAll("_", " ");
  if (!Number.isFinite(value) || value <= 0 || ["review_unresolved", "missing"].includes(status)) {
    return { label: "Beds", value: "Unavailable", detail: provenance || "No published bed count" };
  }
  const estimate = /estimat|model|predict/i.test(status);
  const description = [provenance, source && source !== "FDR" ? source.replaceAll("_", " ") : ""].filter(Boolean).join(" · ");
  const range = estimate && Number.isFinite(facility.bedsLow) && Number.isFinite(facility.bedsHigh)
    ? `. Published prediction range ${number.format(facility.bedsLow)}–${number.format(facility.bedsHigh)} beds` : "";
  return {
    label: estimate ? "Estimated beds" : "Reported beds", value: number.format(value),
    detail: `${estimate ? "Estimated" : "Reported"} capacity of ${number.format(value)} beds${description ? " · " + description : ""}${range}.`,
  };
}

function directionsTo(facility, origin, travelMode) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${facility.lat},${facility.lon}`);
  if (origin) url.searchParams.set("origin", `${origin.lat},${origin.lon}`);
  url.searchParams.set("travelmode", TRAVEL_MODES[travelMode].mapsMode);
  return url.href;
}

function facts(rows, className) {
  const list = node("dl", "", className);
  for (const [title, value] of rows) {
    const term = node("dt", title), definition = node("dd", value);
    if (className === "card-facts") list.append(term, definition);
    else {
      const pair = node("div");
      pair.append(term, definition);
      list.append(pair);
    }
  }
  return list;
}

function details(title) {
  const element = node("details", "", "card-details");
  element.append(node("summary", title));
  return element;
}

function table(headers, rows, className, label) {
  const grid = node("table", "", className);
  grid.setAttribute("aria-label", label);
  const head = grid.createTHead().insertRow();
  for (const name of headers) {
    const heading = node("th", name);
    heading.scope = "col";
    head.append(heading);
  }
  const body = grid.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) row.insertCell().append(value);
  }
  return grid;
}

function section(title, bullets) {
  const area = node("section", "", "card-section");
  const list = node("ul", "", "card-reasons");
  for (const bullet of bullets) list.append(node("li", bullet));
  area.append(node("h4", title), list);
  return area;
}

function routingMetric(result, travelMode) {
  if (!Number.isFinite(result.travelMinutes)) return null;
  return [TRAVEL_MODES[travelMode].label + " time", number.format(result.travelMinutes) + " min"];
}

function reasons(result, options) {
  const {assessment, facility} = result;
  const why = [`${evidenceLabels[assessment.kind]} for ${options.service}. Matched text: “${assessment.term}”.`];
  const mode = routingMetric(result, options.travelMode);
  if (mode) why.push(`${mode[1]} by ${TRAVEL_MODES[options.travelMode].label.toLowerCase()} on a typical weekday morning.`);
  if (assessment.matchedEquipment?.length) why.push("Documented equipment: " + assessment.matchedEquipment.join(", ") + ".");
  if (assessment.matchedStaff?.length) why.push("Documented staff: " + assessment.matchedStaff.join(", ") + ".");
  if (facility.open24h === true) why.push("The facility record mentions round-the-clock operation.");
  if (text(facility.accreditation)) why.push("Accreditation on record: " + facility.accreditation + ".");
  if (Number.isFinite(facility.rating)) why.push(`Recorded facility rating: ${number.format(facility.rating)}/5.`);
  const caveats = [];
  if (options.serviceInfo && Array.isArray(assessment.matchedEquipment) && Array.isArray(assessment.matchedStaff)) {
    const equipment = (options.serviceInfo.equipment || []).filter(item => !assessment.matchedEquipment.includes(item));
    const staff = (options.serviceInfo.staff || []).filter(item => !assessment.matchedStaff.includes(item));
    const missing = [...equipment, ...staff];
    if (missing.length) caveats.push("The reviewed text does not document " + missing.join(", ") + ". Ask the branch about these resources.");
  }
  if (assessment.kind === "mention") caveats.push("The record mentions the service. Call this branch to confirm it offers the requested care.");
  if (options.serviceInfo?.urgent && facility.open24h !== true) caveats.push("Round-the-clock service at this branch is unconfirmed.");
  if (!Number.isFinite(facility.occupancy)) caveats.push("Current occupancy and available beds are unknown.");
  if (facility.lastVerified) caveats.push("Branch record last verified " + facility.lastVerified + ".");
  else caveats.push("The branch record has no verification date.");
  if (!mode) caveats.push("The routing service did not supply a journey time. Distance is measured in a straight line.");
  return [section("Why this facility", why), section("Caveats", caveats)];
}

function sourceEvidence(result, options) {
  const {assessment, facility} = result;
  const evidence = details("Service evidence and sources");
  evidence.append(node("p", `${evidenceLabels[assessment.kind]} · service evidence ${assessment.servicePoints}/80 · branch identity ${assessment.branchPoints}/20.`));
  evidence.append(node("p", "Matched service text: " + assessment.term));
  if (assessment.excerpt) evidence.append(node("blockquote", assessment.excerpt));
  const refs = links((assessment.urls || []).map((url, i) => ["Service source " + (i + 1), url]));
  if (refs.childElementCount) evidence.append(refs);
  else evidence.append(node("p", "No separate source link is listed for this text."));
  evidence.append(node("p", bedsOf(facility).detail));
  const sources = links([
    ["Capacity source", facility.capacitySourceUrl], ["Phone source", facility.phoneSourceUrl],
    ["Published facility release", options.sourceUrl],
  ]);
  if (sources.childElementCount) evidence.append(sources);
  const source = [text(facility.source), facility.id, options.snapshotDate ? "Service assessment " + options.snapshotDate : ""].filter(Boolean);
  if (source.length) evidence.append(node("p", source.join(" · "), "card-note"));
  return evidence;
}

function scoreBreakdown(result, options) {
  const panel = details("Fit breakdown and ranking");
  const {fitComponents, scoreParts, priorityParts} = result;
  if (fitComponents) {
    const hasWeights = options.fitWeights && Object.keys(options.fitWeights).length > 0;
    const rows = Object.entries(fitComponents).map(([key, value]) => {
      const row = [criterionLabels[key] || key, Number.isFinite(value) ? number.format(value * 100) + "/100" : "Not recorded"];
      if (hasWeights) row.push(Number.isFinite(options.fitWeights[key]) ? percent.format(options.fitWeights[key]) : "—");
      return row;
    });
    panel.append(table(hasWeights ? ["Fit component", "Value", "Weight"] : ["Fit component", "Value"], rows, "score-table", "Fit components"));
    panel.append(node("p", "Fit combines documented components with your weights and the selected service match. Missing components are excluded from its weighted average."));
  }
  if (options.sort === "recommended" && scoreParts) {
    const units = Number.isFinite(result.travelMinutes) ? "min equivalent" : "km equivalent";
    const items = [["Travel", scoreParts.travel], ["Service match penalty", scoreParts.matchPenalty], ["Service confidence penalty", scoreParts.confidencePenalty], ["Total", result.recommendedScore]];
    panel.append(table(["Recommended score component", units], items.map(([label, value]) => [label, number.format(value)]), "score-table", "Recommended score breakdown"));
    panel.append(node("p", "A lower total ranks first before comparing expected workloads."));
  }
  if (priorityParts?.length) {
    panel.append(table(["Personal priority", "Value", "Weight"], priorityParts.map(({criterion, value, weight}) =>
      [criterionLabels[criterion] || criterion, Number.isFinite(value) ? percent.format(value) : "Not recorded", percent.format(weight)]), "score-table", "Your ranked priorities"));
  }
  return panel;
}

function projectionDetails(result, options) {
  const load = result.projectedLoad;
  if (!load) return null;
  const panel = details("Expected workload comparison");
  panel.append(facts([
    [load.caseloadPredicted ? "Projected demand" : "Historical demand", `${number.format(load.caseload)} ${load.unit}/month`],
    [load.capacityPredicted ? "Modeled throughput" : "Reported throughput", `${number.format(load.capacity)} ${load.unit}/month`],
  ], "card-facts"));
  panel.append(node("p", `${load.scope} · ${load.period}. Planning estimate.`));
  panel.append(node("p", `Load comparison score ${load.comparisonScore.toFixed(3)} · lower ranks first · baseline rank #${result.baselineRank}.`));
  panel.append(links([["Demand source", load.sourceUrl], ["Throughput source", load.capacitySourceUrl], ["Projection methods", options.projectionSourceUrl]]));
  return panel;
}

export function resultCard(result, index, options) {
  const {facility, assessment} = result;
  const rank = index + 1;
  const card = node("article", "", "result-card");
  card.id = "facility-" + rank;
  card.tabIndex = -1;
  const name = node("h3", facility.name);
  name.id = "facility-title-" + rank;
  card.setAttribute("aria-labelledby", name.id);
  const header = node("div", "", "card-header");
  const numberPin = node("span", String(rank), "rank");
  numberPin.setAttribute("aria-label", "Rank " + rank);
  const heading = node("div");
  const place = [...new Set([facility.city, facility.district, facility.state, facility.pin && "PIN " + facility.pin, facility.ownership].map(text).filter(Boolean))];
  heading.append(name, node("p", place.join(" · "), "card-place"));
  header.append(numberPin, heading);
  const beds = bedsOf(facility);
  const travel = routingMetric(result, options.travelMode);
  const metrics = [
    ...(travel ? [travel] : []), ["Straight-line distance", number.format(result.distanceKm) + " km"],
    ["Fit (/100)", Number.isFinite(result.fitScore) ? number.format(result.fitScore) : "Unavailable"],
    [beds.label, beds.value],
  ];
  if (Number.isFinite(facility.occupancy)) metrics.push(["Recorded occupancy", percent.format(facility.occupancy)]);
  card.append(header, facts(metrics, "card-metrics"));
  if (options.sort === "recommended") {
    const units = travel ? "min equivalent" : "km equivalent";
    card.append(node("p", `${result.projectedLoad ? "Baseline recommended" : "Recommended"} score ${number.format(result.recommendedScore)} ${units} · lower ranks first.`, "card-note"));
  }
  if (result.priorityParts?.length) card.append(node("p", "Personal criteria score " + (Number.isFinite(result.priorityScore) ? number.format(result.priorityScore) + "/100" : "unavailable"), "card-note"));
  card.append(facts([["Address", addressOf(facility)], ["Phone", phoneOf(facility)], ["Hours", hoursOf(facility)]], "card-facts"));
  card.append(node("p", "Call the branch to confirm the service, hours and current availability before travelling.", "card-note"));
  const actions = links([["Directions", directionsTo(facility, options.origin, options.travelMode)], ["Facility website", facility.website]]);
  const locate = node("button", "Show on map", "button-text");
  locate.type = "button";
  locate.addEventListener("click", () => options.onShowMap(index));
  actions.prepend(locate);
  card.append(actions, ...reasons(result, options));
  card.append(node("p", `Service confidence ${assessment.confidence}/100 · ${evidenceLabels[assessment.kind]}`, "card-note"));
  const load = projectionDetails(result, options);
  if (load) card.append(load);
  card.append(sourceEvidence(result, options), scoreBreakdown(result, options));
  return card;
}

export function contactsTable(results, {travelMode}) {
  const columns = ["#", "Facility", "Phone", "Hours", "Address", "Straight-line km", TRAVEL_MODES[travelMode].label + " min"];
  return table(columns, results.map(({facility, distanceKm, travelMinutes}, index) => [
    String(index + 1), facility.name, phoneOf(facility), hoursOf(facility), addressOf(facility),
    number.format(distanceKm), Number.isFinite(travelMinutes) ? number.format(travelMinutes) : "Unavailable",
  ]), "classic-contacts", "Facility contact details in result order");
}

export function facilityPopup(result, index, {origin, travelMode}) {
  const {facility} = result;
  const popup = node("div", "", "facility-popup");
  const beds = bedsOf(facility);
  const travel = routingMetric(result, travelMode);
  popup.append(node("strong", `${index + 1}. ${facility.name}`));
  popup.append(facts([
    ["Address", addressOf(facility)], ["Phone", phoneOf(facility)], ["Hours", hoursOf(facility)],
    ["Straight-line distance", number.format(result.distanceKm) + " km"], ...(travel ? [travel] : []),
    [beds.label, beds.value],
  ], "card-facts"));
  popup.append(links([["Directions", directionsTo(facility, origin, travelMode)], ["Facility website", facility.website]]));
  popup.append(node("small", "Call to confirm current availability."));
  return popup;
}
