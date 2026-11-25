import { attachClassicData, haversineKm, parseRouteMatrix, resolveOrigin, rankFacilities, RouteOriginError, ROUTING_URL, TRAVEL_MODES } from "./ranking.js?v=d4b77316";
import { facilityMap } from "./map.js?v=7f50ffd6";
import { resultCard, contactsTable, formatTravelTime, formatRouteDistance } from "./results.js?v=450878f0";

const get = id => document.getElementById(id);
const form = get("finder-form");
const service = get("service");
const travelMode = get("travel-mode");
const equity = get("consider-equity");
const workloadUrgencyText = "Workload comparisons are available for routine, non-time-critical care.";
const equityUrgencyText = "Equity comparisons are paused for time-critical care.";
const group = get("service-group");
const weightInputs = {
  capability: get("weight-capability"), availability: get("weight-availability"),
  quality: get("weight-quality"), freshness: get("weight-confidence"),
};
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
const originStatus = get("origin-status");
const retryRoutes = get("retry-routes");
const drivingAlternatives = get("driving-alternatives");
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
const formatDeparture = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
});
class RouteRequestError extends Error {}
let data;
let snapshotSha256;
let origin;
let activeResults = [];
const routeLookups = new Map();
let searchVersion = 0;
let displayedRouting;
let searchStarted = false;
let locationTimer;

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

function status(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function scrollTo(node) {
  node.scrollIntoView({ block: "nearest" });
  node.focus({ preventScroll: true });
}

const map = facilityMap({
  street: get("street-map"), feedback: get("map-status"), retry: get("map-retry"),
  onSelect: index => focusResult(index),
});

function focusResult(index, fromCard = false) {
  const result = activeResults[index];
  if (!result) return;
  for (const card of list.children) {
    card.dataset.active = card.id === `facility-${index + 1}`;
  }
  const title = element("strong", `${index + 1}. ${result.facility.name}`);
  const mode = TRAVEL_MODES[travelMode.value].label;
  const distance = Number.isFinite(result.routeDistanceKm) ? formatRouteDistance(result.routeDistanceKm) : "Route distance unavailable";
  const journey = document.createTextNode(` · ${mode} · ${formatTravelTime(result.travelMinutes)} · ${distance} `);
  const jump = element("button", "View option", "button-text");
  jump.type = "button";
  jump.addEventListener("click", () => scrollTo(get(`facility-${index + 1}`)));
  mapSelection.replaceChildren(title, journey, jump);
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

function updateComparisonHelp() {
  const serviceInfo = data?.services.find(item => item.label === service.value);
  const routine = serviceInfo && !serviceInfo.urgent && severity.value === "routine";
  let help = "Compare expected monthly workload at nearby facilities in the same fit range.";
  if (serviceInfo && !routine) help = workloadUrgencyText;
  else if (sort.value !== "recommended") help = "Choose Recommended sorting to compare expected workloads.";
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

function fitWeights() {
  return Object.fromEntries(Object.entries(weightInputs).map(([name, input]) => [name, Number(input.value)]));
}

function renderSearch(routeMatrix) {
  const weights = fitWeights();
  const serviceInfo = data.services.find(item => item.label === service.value);
  const result = rankFacilities(data, {
    service: service.value, origin, severity: severity.value, sort: sort.value,
    considerLoad: considerLoad.checked, limit: Number(limit.value), routeMatrix, fitWeights: weights,
  });
  activeResults = result.results;
  const place = origin.label + (origin.approximate ? " (approximate)" : "");
  const mode = TRAVEL_MODES[travelMode.value];
  const routedOrigin = routeMatrix.routedOrigin;
  const adjusted = routedOrigin && (routedOrigin.lat !== origin.lat || routedOrigin.lon !== origin.lon);
  const startLabel = adjusted ? `${routedOrigin.lat.toFixed(5)}, ${routedOrigin.lon.toFixed(5)}` : "";
  const count = activeResults.length;
  const noRoutes = routeMatrix.secondsByIndex.size === 0;
  const onlyLowConfidence = !count && result.candidateCount > 0 && result.lowConfidenceCount === result.candidateCount;
  const noQualifyingFit = !count && result.candidateCount > result.lowConfidenceCount;
  const canShowUnscored = noQualifyingFit && sort.value === "recommended" && result.unknownFitCount > 0;
  let emptyHint = "Try another service, travel mode or starting location.";
  if (count) {
    context.textContent = `${count} option${count === 1 ? "" : "s"} for ${service.value} near ${place}.`;
  } else if (noRoutes) {
    context.textContent = `No ${mode.label.toLowerCase()} estimates within three hours were available for ${service.value} near ${place}.`;
    if (travelMode.value === "public_transport") context.textContent += " TravelTime covers only some public transport routes in India.";
  } else if (onlyLowConfidence) {
    context.textContent = `All branches with a returned route for ${service.value} near ${place} fall below the minimum service confidence of 25/100.`;
  } else if (noQualifyingFit) {
    context.textContent = `Among branches with a returned route for ${service.value} near ${place}, none with service confidence of at least 25/100 has a positive documented fit under these weights.`;
    emptyHint = canShowUnscored
      ? "Choose another sort to see branches whose fit could not be scored, or adjust the fit weights."
      : "Try adjusting the fit weights, service or starting location.";
  } else {
    context.textContent = `No options with service evidence for ${service.value} were found near ${place}.`;
  }
  get("travel-sort").textContent = `Fastest ${mode.trip}`;
  let sortNote = count && sort.value === "recommended"
    ? "Facilities in the strongest fit range come first. Within each range, shorter travel times and stronger service evidence rank higher." : "";
  if (count && sort.value === "distance") sortNote = `Facilities with qualifying service evidence are ordered by estimated ${mode.label.toLowerCase()} time.`;
  if (count && sort.value === "routeDistance") sortNote = `Shortest ${mode.label.toLowerCase()} routes come first. Facilities with unknown route length appear last.`;
  if (count && sort.value === "occupancy" && activeResults.every(item => item.facility.occupancy == null))
    sortNote = "These branches have no recorded occupancy. Ties use the available ranking evidence.";
  status(get("sort-status"), sortNote);
  status(originStatus, "");
  routeStatus.hidden = false;
  const timing = routeMatrix.departureTime
    ? `${mode.label.toLowerCase()} estimates for departure on ${formatDeparture.format(routeMatrix.departureTime)} IST`
    : `weekday-morning ${mode.label.toLowerCase()} estimates`;
  routeStatus.replaceChildren(externalLink("TravelTime", "https://traveltime.com/"),
    ` ${timing} · calculated ${formatPublication.format(routeMatrix.calculatedAt)} UTC.`);
  if (adjusted) {
    const km = haversineKm(origin, routedOrigin);
    const separation = km < 1 ? `${formatNumber.format(Math.round(km * 1000))} m` : `${formatDecimal.format(km)} km`;
    const detail = element("details", "", "origin-details");
    detail.append(element("summary", "Starting point details"));
    const sources = element("p");
    sources.append(`From your coordinates (${origin.lat}, ${origin.lon}) to the road (${startLabel}). `,
      externalLink("Road lookup by FOSSGIS", "https://routing.openstreetmap.de/about.html"), " · ",
      externalLink("© OpenStreetMap contributors", "https://www.openstreetmap.org/copyright"), " · ",
      externalLink("Fix the map", "https://www.openstreetmap.org/fixthemap"));
    detail.append(sources);
    originStatus.replaceChildren(element("strong", `Your route starts ${separation} from the point you entered.`),
      document.createTextNode(" Travel time, route distance and directions start at the road. The estimates exclude the gap to your point."), detail);
    originStatus.hidden = false;
  }
  controls.hidden = !count && !canShowUnscored;
  get("adjust-fit").hidden = !noQualifyingFit;
  drivingAlternatives.hidden = travelMode.value === "driving" || !noRoutes;
  const loadText = {
    urgency: workloadUrgencyText,
    sort: "Choose Recommended sorting to compare expected workloads.",
    unavailable: "There are too few comparable workload estimates to change the recommendation.",
    compared: `Compared expected workloads at ${result.comparisonCount} nearby facilities in the same fit range. The first recommendation stayed the same.`,
    changed: `Compared expected workloads at ${result.comparisonCount} nearby facilities in the same fit range. ${activeResults[0]?.facility.name} moved to first.`,
  };
  status(loadStatus, count ? loadText[result.loadStatus] ?? "" : "");
  let equityStatus = "";
  if (equity.checked && count) {
    equityStatus = serviceInfo?.urgent || severity.value !== "routine" ? equityUrgencyText
      : "The published snapshot has no paired evidence on patient-reported respect and clinical outcomes for these facilities. The displayed order uses your selected sort.";
  }
  status(get("equity-status"), equityStatus);
  const cardOptions = {activeResults, service: service.value, serviceInfo, travelMode: travelMode.value, sort: sort.value, origin: routedOrigin ?? origin,
    fitWeights: weights, departureTime: routeMatrix.departureTime, snapshotDate: data.classifiedAsOf, sourceUrl: data.sourceUrl, projectionSourceUrl: data.projectionSourceUrl,
    onShowMap: index => focusResult(index, true)};
  list.replaceChildren(...activeResults.map((item, index) => resultCard(item, index, cardOptions)));
  get("contacts").hidden = !count;
  get("contact-table").replaceChildren(...(count ? [contactsTable(activeResults, cardOptions)] : []));
  if (!count) list.append(element("p", emptyHint, "empty-card"));
  get("map-context").textContent = adjusted
    ? `The house marks your location. The arrow marks the route start at ${startLabel}.` : place;
  status(mapSelection, "");
  map.show(origin, activeResults, {travelMode: travelMode.value, routedOrigin: adjusted ? {...routedOrigin, label: startLabel} : undefined});
}

function fetchRoutes(location, serviceName, selectedMode, allowOriginAdjustment) {
  const {lat, lon} = location;
  const request = {origin: {lat, lon}, service: serviceName, travelMode: selectedMode, snapshotSha256};
  if (allowOriginAdjustment) request.allowOriginAdjustment = true;
  const body = JSON.stringify(request);
  const routeLookup = routeLookups.get(selectedMode);
  if (routeLookup?.body === body && routeLookup.expires > Date.now()) return routeLookup.promise;
  const lookup = {body, expires: Date.now() + 30 * 60 * 1000};
  lookup.promise = fetch(ROUTING_URL, {
    method: "POST", headers: {"Content-Type": "application/json"}, body,
    credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(allowOriginAdjustment || selectedMode === "public_transport" ? 95000 : 35000),
  }).then(async response => {
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      if (response.status === 422 && problem?.code === "unroutable_origin") {
        throw new RouteOriginError(`TravelTime couldn’t start a ${TRAVEL_MODES[selectedMode].trip} from this location. Enter coordinates on a nearby road, or search by city or PIN code.`);
      }
      if ([429, 502].includes(response.status) && problem?.code === "origin_adjustment_unavailable") {
        throw new RouteRequestError("TravelTime couldn’t check a nearby road right now. Try again shortly, or enter another location.");
      }
      if (response.status === 429) throw new RouteRequestError("TravelTime is temporarily limiting requests. Try again shortly.");
      if (response.status === 409) throw new RouteRequestError("The routing service and facility data are out of sync. Refresh the page and try again.");
      throw new Error("Routing unavailable.");
    }
    return parseRouteMatrix(await response.json(), data.matches[serviceName], selectedMode, allowOriginAdjustment);
  }).catch(error => {
    if (routeLookups.get(selectedMode) === lookup) routeLookups.delete(selectedMode);
    throw error;
  });
  routeLookups.set(selectedMode, lookup);
  return lookup.promise;
}

function clearResults(message) {
  displayedRouting = undefined;
  activeResults = [];
  controls.hidden = true;
  retryRoutes.hidden = true;
  get("adjust-fit").hidden = true;
  drivingAlternatives.hidden = true;
  list.replaceChildren();
  get("contacts").hidden = true;
  get("contact-table").replaceChildren();
  status(get("equity-status"), "");
  status(mapSelection, "");
  status(loadStatus, "");
  status(routeStatus, "");
  status(originStatus, "");
  status(get("sort-status"), "");
  context.textContent = message;
  get("map-context").textContent = origin?.label ?? "India";
  map.show(origin, []);
}

function invalidateSearch() {
  if (!origin) return;
  searchVersion++;
  origin = undefined;
  delete get("finder-output").dataset.searched;
  clearResults("Choose a service and enter a location to see options.");
}

async function search({ focus = true } = {}) {
  if (!data) return;
  clearTimeout(locationTimer);
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
  searchStarted = true;
  get("finder-output").dataset.searched = "true";
  const selectedMode = travelMode.value;
  clearResults(`Finding ${TRAVEL_MODES[selectedMode].label.toLowerCase()} routes for ${service.value} near ${origin.label}…`);
  if (focus) {
    const heading = get("results-title");
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start" });
  }
  let matrix;
  try {
    matrix = await fetchRoutes(origin, service.value, selectedMode, locationType.value === "coordinates");
  } catch (cause) {
    if (version !== searchVersion) return;
    context.textContent = `${service.value} near ${origin.label}`;
    status(routeStatus, cause instanceof RouteOriginError || cause instanceof RouteRequestError ? cause.message
      : `${TRAVEL_MODES[selectedMode].label} routes are unavailable right now. Try again to get journey times and distances.`);
    retryRoutes.hidden = false;
    return;
  }
  if (version !== searchVersion) return;
  displayedRouting = matrix;
  renderSearch(matrix);
}

function rerank() {
  if (displayedRouting !== undefined) renderSearch(displayedRouting);
}

function locationReady() {
  if (locationType.value === "coordinates") return latitude.value.trim() && longitude.value.trim();
  return locationType.value === "pin" ? /^\d{6}$/u.test(query.value.trim()) : query.value.trim();
}

function updateSearchButton() {
  get("search-button").disabled = !(data && service.value);
}

function selectService() {
  const info = data.services.find(item => item.label === service.value);
  if (!info) return;
  get("service-meta").textContent = [info.specialty, info.area, info.urgent && "Time-critical"].filter(Boolean).join(" · ");
  severity.value = info.urgent ? "urgent" : "routine";
  updateSearchButton();
  updateComparisonHelp();
  if (origin) search({focus: false});
}

function groupField() {
  return get("browse-area").checked ? "area" : "specialty";
}

function updateServices() {
  const previous = service.value;
  const key = groupField();
  const services = data.services.filter(item => !group.value || item[key] === group.value)
    .sort((a, b) => a[key].localeCompare(b[key]));
  service.replaceChildren(...services.map(item => new Option(item.label, item.label)));
  if (services.some(item => item.label === previous)) service.value = previous;
  if (previous !== service.value) selectService();
}

function updateGroups() {
  const key = groupField();
  const groups = [...new Set(data.services.map(item => item[key]))].sort();
  get("service-group-label").textContent = key === "area" ? "Body area" : "Specialty";
  const choices = groups.map(value => new Option(value, value));
  if (key === "specialty") choices.unshift(new Option("All specialties", ""));
  group.replaceChildren(...choices);
  updateServices();
}

form.addEventListener("submit", event => {
  event.preventDefault();
  search();
});
service.addEventListener("change", selectService);
for (const radio of document.querySelectorAll('[name="browse-by"]')) radio.addEventListener("change", updateGroups);
group.addEventListener("change", updateServices);
travelMode.addEventListener("change", () => { if (origin) search({focus: false}); });
retryRoutes.addEventListener("click", () => search());
drivingAlternatives.addEventListener("click", () => {
  travelMode.value = "driving";
  search();
});
get("adjust-fit").addEventListener("click", () => {
  get("fit-settings").open = true;
  weightInputs.capability.focus();
});
severity.addEventListener("change", () => { updateComparisonHelp(); rerank(); });
sort.addEventListener("change", () => {
  updateComparisonHelp();
  rerank();
});
for (const control of [equity, considerLoad]) control.addEventListener("change", rerank);
for (const control of [limit, ...Object.values(weightInputs)]) {
  const display = get(control.id + "-value");
  const update = () => { display.value = control === limit ? control.value : Number(control.value).toFixed(2); };
  update();
  control.addEventListener("input", () => {
    update();
    if (control !== limit) {
      const hasWeight = Object.values(fitWeights()).some(weight => weight > 0);
      status(get("fit-weight-status"), hasWeight ? "" : "Set at least one weight above zero to calculate documented fit.");
    }
    rerank();
  });
}
function locationChanged() {
  clearTimeout(locationTimer);
  clearError();
  invalidateSearch();
  updateSearchButton();
  if (searchStarted && locationReady() && !get("search-button").disabled) {
    locationTimer = setTimeout(() => search({focus: false}), 700);
  }
}
locationType.addEventListener("change", () => {
  query.value = "";
  state.value = "";
  switchLocation();
  locationChanged();
});
for (const input of [query, state, latitude, longitude]) input.addEventListener("input", locationChanged);

function openLinkedCitySearch() {
  const params = new URLSearchParams(window.location.search);
  const city = params.get("city")?.trim();
  const selected = params.get("service");
  const mode = params.get("mode") || "driving";
  const region = params.get("state") || "";
  if (!city || city.length > 80 || region.length > 80 || !Object.hasOwn(TRAVEL_MODES, mode)
    || !data.services.some(item => item.label === selected)) return;
  service.value = selected;
  selectService();
  locationType.value = "city";
  switchLocation();
  query.value = city;
  state.value = region;
  travelMode.value = mode;
  search({focus: window.location.hash === "#results"});
}

async function start() {
  try {
    const [response, classic] = await Promise.all(["./data.json", "./classic-data.json"].map(file =>
      fetch(new URL(file, import.meta.url), {cache: "no-cache"})));
    if (!response.ok || !classic.ok) throw new Error("The facility snapshot could not be loaded.");
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    snapshotSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    data = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(data.services) || !Array.isArray(data.facilities)) throw new Error("The snapshot is incomplete.");
    attachClassicData(data, await classic.json(), snapshotSha256);
    updateGroups();
    get("snapshot-count").textContent = `${formatNumber.format(data.facilities.length)} facilities`;
    const published = new Date(data.publishedAt);
    get("snapshot-date").textContent = Number.isNaN(published.getTime())
      ? "Publication date unavailable"
      : `${formatPublication.format(published)} UTC`;
    const assessed = new Date(data.classifiedAsOf || "");
    get("evidence-date").textContent = Number.isNaN(assessed.getTime())
      ? "Evidence assessment date unavailable"
      : formatDate.format(assessed);
    const href = safeLink(data.sourceUrl);
    if (href) get("source-link").href = href;
    get("search-fields").disabled = false;
    severity.disabled = false;
    switchLocation();
    updateSearchButton();
    updateComparisonHelp();
    openLinkedCitySearch();
  } catch {
    get("snapshot-count").textContent = "health facilities";
    get("snapshot-date").textContent = get("evidence-date").textContent = "Unavailable";
    markError("The facility snapshot could not be loaded. Refresh this page to retry.", [], false);
    context.textContent = "Search will be available when the published snapshot loads.";
  }
}
start();
