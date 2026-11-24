import { parseRouteMatrix, resolveOrigin, rankFacilities, ROUTING_URL } from "./ranking.js";
import { facilityMap } from "./map.js";

const get = id => document.getElementById(id);
const form = get("finder-form");
const service = get("service");
const locationType = get("location-type");
const severity = get("severity");
const query = get("query");
const state = get("state");
const latitude = get("latitude");
const longitude = get("longitude");
const considerLoad = get("projected-load");
const sort = get("sort");
const limit = get("limit");
const error = get("search-error");
const list = get("result-list");
const context = get("search-context");
const loadStatus = get("load-status");
const routeStatus = get("route-status");
const controls = get("results-controls");
const mapSelection = get("map-selection");

const formatNumber = new Intl.NumberFormat("en-IN");
const formatDecimal = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
const formatDate = new Intl.DateTimeFormat("en-GB", {
  year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
});
const formatPublication = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
});
const evidenceLabels = {
  corroborated: "Hospital source and independent corroboration",
  hospital_site: "Listed by hospital",
  directory: "Listed in a reviewed directory",
  record_listing: "Listed in facility record",
  mention: "Mentioned in facility record",
};

let data;
let snapshotSha256;
let origin;
let activeResults = [];
let routeLookup;
let searchVersion = 0;
let displayedRouting;

function element(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function safeLink(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const link = new URL(url);
    if (["https:", "http:"].includes(link.protocol) && !link.username && !link.password) return link.href;
  } catch {
    return null;
  }
  return null;
}

function externalLink(text, url) {
  const href = safeLink(url);
  if (!href) return null;
  const link = element("a", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function appendLinks(container, definitions) {
  for (const [title, url] of definitions) {
    const link = externalLink(title, url);
    if (link) container.append(link);
  }
}

function status(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function scrollTo(node) {
  node.scrollIntoView({ block: "nearest" });
  node.focus({ preventScroll: true });
}

const map = facilityMap({
  stage: get("map-stage"), canvas: get("map-canvas"), markerLayer: get("local-markers"),
  local: get("local-map"), street: get("street-map"), button: get("street-toggle"),
  onSelect: index => focusResult(index),
  onUnavailable: message => status(mapSelection, message),
});

function focusResult(index, fromCard = false) {
  const result = activeResults[index];
  if (!result) return;
  for (const card of list.children) {
    card.dataset.active = card.id === `facility-${index + 1}`;
  }
  const title = element("strong", `${index + 1}. ${result.facility.name}`);
  const travel = result.driveMinutes == null
    ? `${result.distanceKm.toFixed(1)} km straight line`
    : `${formatDecimal.format(result.driveMinutes)} min drive`;
  const distance = document.createTextNode(` · ${travel} `);
  const jump = element("button", "View option", "button-text");
  jump.type = "button";
  jump.addEventListener("click", () => scrollTo(get(`facility-${index + 1}`)));
  mapSelection.replaceChildren(title, distance, jump);
  mapSelection.hidden = false;
  if (fromCard) get("map-title").scrollIntoView({ block: "nearest" });
  map.highlight(index, fromCard);
}

function switchLocation() {
  const type = locationType.value;
  const coordinateMode = type === "coordinates";
  const pinMode = type === "pin";
  get("query-field").hidden = coordinateMode;
  get("state-field").hidden = pinMode || coordinateMode;
  get("coordinate-fields").hidden = !coordinateMode;
  const settings = {
    pin: ["PIN code", "e.g. 302004", 6, "numeric"],
    city: ["City", "e.g. Jaipur", 80, "text"],
    district: ["District", "e.g. Kullu", 80, "text"],
  };
  if (!coordinateMode) {
    const [label, placeholder, maxLength, mode] = settings[type];
    get("query-label").textContent = label;
    query.placeholder = placeholder;
    query.maxLength = maxLength;
    query.inputMode = mode;
  }
  clearError();
}

function updateLoadControl() {
  const serviceInfo = data?.services.find(item => item.label === service.value);
  const routine = serviceInfo && !serviceInfo.urgent && severity.value === "routine";
  const eligible = routine && sort.value === "recommended";
  considerLoad.disabled = !eligible;
  if (!eligible) considerLoad.checked = false;
  let help = "Turn on to compare monthly caseload and throughput at nearby facilities for routine care.";
  if (serviceInfo && !routine) help = "Load balancing is available for routine, non-time-critical care.";
  else if (sort.value !== "recommended") help = "Choose Recommended sorting to use load balancing.";
  get("load-help").textContent = help;
}

function clearError() {
  status(error, "");
  for (const field of [service, query, latitude, longitude]) field.removeAttribute("aria-invalid");
}

function markError(message, fields, focus = true) {
  status(error, message);
  for (const field of fields) field.setAttribute("aria-invalid", "true");
  if (focus) fields[0]?.focus();
}

function numberMetric(label, value) {
  const metric = element("div");
  metric.append(element("dt", label), element("dd", value));
  return metric;
}

function formatBeds(facility) {
  const beds = Number(facility.beds);
  if (!Number.isFinite(beds) || beds <= 0) return ["Beds", "Unavailable"];
  const kind = String(facility.capacityStatus || "").toLowerCase();
  return [/(estimat|model|predict)/.test(kind) ? "Estimated beds" : "Reported beds", formatNumber.format(beds)];
}

function callLink(phone) {
  if (!phone) return null;
  const first = String(phone).split(/[/;]/, 1)[0];
  const number = first.replace(/[^+\d]/g, "");
  if (!/^\+?\d{7,15}$/.test(number)) return element("span", String(phone));
  const phoneLink = element("a", first.trim());
  phoneLink.href = "tel:" + number;
  return phoneLink;
}

function reportEvidence(result) {
  const { assessment, facility, scoreParts, projectedLoad, recommendedScore } = result;
  const details = element("details", "", "card-details");
  details.append(element("summary", "Service evidence and score"));
  const label = evidenceLabels[assessment.kind] ?? "Service evidence";
  details.append(element("p", `${label} · service evidence ${assessment.servicePoints}/80 · branch identity ${assessment.branchPoints}/20`));
  if (assessment.excerpt) details.append(element("blockquote", assessment.excerpt));
  const evidenceLinks = element("div", "", "card-links");
  appendLinks(evidenceLinks, (assessment.urls ?? []).map((url, index) => [`Service source ${index + 1}`, url]));
  appendLinks(evidenceLinks, [["Capacity source", facility.capacitySourceUrl]]);
  if (evidenceLinks.childElementCount) details.append(evidenceLinks);
  if (sort.value === "recommended") {
    const score = formatDecimal.format(recommendedScore);
    const unit = result.driveMinutes == null ? "km" : "min";
    details.append(element("p", `Recommended score ${score} ${unit} equivalent. Travel contributes ${formatDecimal.format(scoreParts.travel)} ${unit}, the service match adds ${formatDecimal.format(scoreParts.matchPenalty)}, and evidence confidence adds ${formatDecimal.format(scoreParts.confidencePenalty)}.`));
  }
  if (projectedLoad) {
    const demand = projectedLoad.caseloadPredicted ? "Projected demand" : "Historical demand";
    details.append(
      element("p", `${demand} ${formatDecimal.format(projectedLoad.caseload)} ${projectedLoad.unit}/month · modeled throughput ${formatDecimal.format(projectedLoad.capacity)} ${projectedLoad.unit}/month.`),
      element("p", `${projectedLoad.scope} · ${projectedLoad.period} · planning estimate.`),
      element("p", `Load comparison score ${projectedLoad.comparisonScore.toFixed(3)} · lower is better · baseline rank #${result.baselineRank}.`),
    );
    const sourceLinks = element("div", "", "card-links");
    appendLinks(sourceLinks, [["Demand source", projectedLoad.sourceUrl], ["Throughput source", projectedLoad.capacitySourceUrl]]);
    if (sourceLinks.childElementCount) details.append(sourceLinks);
  }
  return details;
}

function resultCard(result, index) {
  const { facility, assessment, distanceKm, driveMinutes } = result;
  const rank = index + 1;
  const card = element("article", "", "result-card");
  card.id = "facility-" + rank;
  card.tabIndex = -1;
  const name = element("h3", facility.name || "Unnamed facility");
  name.id = "facility-title-" + rank;
  card.setAttribute("aria-labelledby", name.id);
  const header = element("div", "", "card-header");
  const rankElement = element("span", String(rank), "rank");
  rankElement.setAttribute("aria-label", "Rank " + rank);
  const headerText = element("div");
  headerText.append(name);
  const place = [...new Set([facility.city, facility.district, facility.state, facility.pin && "PIN " + facility.pin].filter(Boolean))].join(" · ");
  if (place) headerText.append(element("p", place, "card-place"));
  header.append(rankElement, headerText);
  card.append(header);
  const address = (facility.address ?? "").split(",").map(part => part.trim())
    .filter(part => part && !/^(null|none|nan|n\/a)$/i.test(part)).join(", ");
  if (address) card.append(element("p", address, "card-address"));

  const metrics = element("dl", "", "card-metrics");
  metrics.append(
    driveMinutes == null
      ? numberMetric("Straight-line distance", `${distanceKm.toFixed(1)} km`)
      : numberMetric("Estimated drive", `${formatDecimal.format(driveMinutes)} min`),
    numberMetric("Service confidence", `${assessment.confidence}/100`),
    numberMetric(...formatBeds(facility)),
  );
  card.append(metrics);

  const links = element("div", "", "card-links");
  const call = callLink(facility.phone);
  if (call) links.append(call);
  const locate = element("button", "Show on map", "button-text");
  locate.type = "button";
  locate.addEventListener("click", () => focusResult(index, true));
  links.append(locate);
  const directions = new URL("https://www.google.com/maps/search/");
  directions.searchParams.set("api", "1");
  directions.searchParams.set("query", `${facility.lat},${facility.lon}`);
  appendLinks(links, [["Directions", directions.href], ["Facility website", facility.website]]);
  card.append(links);
  if (!call) card.append(element("p", "Phone unavailable in this snapshot.", "card-note"));
  if (result.projectedLoad && result.baselineRank > 1 && rank === 1) {
    card.append(element("p", `Moved up from #${result.baselineRank} after projected load comparison.`, "card-note"));
  }
  card.append(reportEvidence(result));
  return card;
}

function renderSearch(routeMatrix) {
  const result = rankFacilities(data, {
    service: service.value, origin, severity: severity.value, sort: sort.value,
    considerLoad: considerLoad.checked, limit: Number(limit.value), routeMatrix,
  });
  activeResults = result.results;
  const place = origin.label + (origin.approximate ? " (approximate)" : "");
  const count = activeResults.length;
  if (count) {
    context.textContent = `${count} option${count === 1 ? "" : "s"} for ${service.value} near ${place}.`;
  } else if (routeMatrix) {
    context.textContent = `No branches with evidence for ${service.value} had a drive within three hours of ${place} in this search.`;
  } else {
    context.textContent = `No options with service evidence for ${service.value} were found near ${place}.`;
  }
  get("travel-sort").textContent = routeMatrix ? "Fastest drive" : "Shortest straight-line distance";
  if (routeMatrix) {
    routeStatus.hidden = false;
    routeStatus.replaceChildren(externalLink("TravelTime", "https://traveltime.com/"),
      ` weekday-morning driving estimates · calculated ${formatPublication.format(routeMatrix.calculatedAt)} UTC.`);
  } else {
    status(routeStatus, "Driving times are unavailable. The travel measure for this search is straight-line distance.");
  }
  controls.hidden = !count;
  const loadText = {
    sort: "Choose Recommended sorting to compare projected load.",
    unavailable: "The first recommendation has no comparable nearby alternative with usable projected load. Showing the baseline order.",
    compared: `Compared projected monthly load for ${result.comparisonCount} nearby facilities. The first recommendation stayed the same.`,
    changed: `Compared projected monthly load for ${result.comparisonCount} nearby facilities. ${activeResults[0]?.facility.name} moved to first.`,
  };
  status(loadStatus, loadText[result.loadStatus] ?? "");
  list.replaceChildren(...activeResults.map(resultCard));
  if (!count) list.append(element("p", "Try a nearby city or a different service.", "empty-card"));
  get("map-context").textContent = place;
  status(mapSelection, "");
  map.show(origin, activeResults.map(item => item.facility));
}

function fetchRoutes(location, serviceName) {
  const {lat, lon} = location;
  const body = JSON.stringify({origin: {lat, lon}, service: serviceName, snapshotSha256});
  if (routeLookup?.body === body && routeLookup.expires > Date.now()) return routeLookup.promise;
  const lookup = {body, expires: Date.now() + 30 * 60 * 1000};
  lookup.promise = fetch(ROUTING_URL, {
    method: "POST", headers: {"Content-Type": "application/json"}, body,
    credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(35000),
  }).then(async response => {
    if (!response.ok) throw new Error("Routing unavailable.");
    return parseRouteMatrix(await response.json(), data.matches[serviceName]);
  }).catch(error => {
    if (routeLookup === lookup) routeLookup = undefined;
    throw error;
  });
  routeLookup = lookup;
  return lookup.promise;
}

function clearResults(message) {
  displayedRouting = undefined;
  activeResults = [];
  controls.hidden = true;
  list.replaceChildren();
  status(mapSelection, "");
  status(loadStatus, "");
  status(routeStatus, "");
  context.textContent = message;
  get("map-context").textContent = origin?.label ?? "India";
  map.show(origin, []);
}

function invalidateSearch() {
  if (!origin) return;
  searchVersion++;
  origin = undefined;
  clearResults("Choose a service and enter a location to see options.");
}

async function search({ focus = true } = {}) {
  if (!data) return;
  const version = ++searchVersion;
  clearError();
  if (!service.value) {
    invalidateSearch();
    markError("Choose a service.", [service], focus);
    return;
  }
  try {
    origin = resolveOrigin(data, {
      type: locationType.value, query: query.value, state: state.value,
      lat: latitude.value, lon: longitude.value,
    });
  } catch (cause) {
    invalidateSearch();
    markError(cause.message, locationType.value === "coordinates" ? [latitude, longitude] : [query], focus);
    return;
  }
  clearResults(`Finding driving times for ${service.value} near ${origin.label}…`);
  if (focus) scrollTo(get("results-title"));
  let matrix;
  try {
    matrix = await fetchRoutes(origin, service.value);
  } catch {
    matrix = null;
  }
  if (version !== searchVersion) return;
  displayedRouting = matrix;
  renderSearch(matrix);
}

form.addEventListener("submit", event => {
  event.preventDefault();
  search();
});
service.addEventListener("change", () => {
  if (data?.services.find(option => option.label === service.value)?.urgent && severity.value === "routine") {
    severity.value = "urgent";
  }
  updateLoadControl();
  if (origin) search({ focus: false });
});
locationType.addEventListener("change", () => {
  invalidateSearch();
  query.value = "";
  state.value = "";
  switchLocation();
});
severity.addEventListener("change", () => {
  updateLoadControl();
  if (displayedRouting !== undefined) renderSearch(displayedRouting);
});
for (const control of [sort, limit, considerLoad]) {
  control.addEventListener("change", () => {
    if (control === sort) updateLoadControl();
    if (displayedRouting !== undefined) renderSearch(displayedRouting);
  });
}
for (const input of [query, state, latitude, longitude]) {
  input.addEventListener("input", () => {
    clearError();
    invalidateSearch();
  });
}

async function start() {
  try {
    const response = await fetch(new URL("./data.json", import.meta.url), { cache: "no-cache" });
    if (!response.ok) throw new Error("The facility snapshot could not be loaded.");
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    snapshotSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    data = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(data.services) || !Array.isArray(data.facilities)) throw new Error("The snapshot is incomplete.");
    service.replaceChildren(new Option("Choose a service", ""), ...data.services.map(item => new Option(item.label, item.label)));
    get("snapshot-count").textContent = `${formatNumber.format(data.facilities.length)} facility records`;
    const published = new Date(data.publishedAt);
    get("snapshot-date").textContent = Number.isNaN(published.getTime())
      ? "Publication date unavailable"
      : `Facility data published ${formatPublication.format(published)} UTC`;
    const assessed = new Date(data.classifiedAsOf || "");
    get("evidence-date").textContent = Number.isNaN(assessed.getTime())
      ? "Evidence assessment date unavailable"
      : `Service evidence assessed ${formatDate.format(assessed)}`;
    const href = safeLink(data.sourceUrl);
    if (href) get("source-link").href = href;
    get("search-fields").disabled = false;
    switchLocation();
    updateLoadControl();
  } catch {
    get("snapshot-count").textContent = "Facility data unavailable";
    markError("The facility snapshot could not be loaded. Refresh this page to retry.", [], false);
    context.textContent = "Search will be available when the published snapshot loads.";
  }
}
start();
