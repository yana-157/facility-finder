import { facilityPopup } from "./results.js";

const INDIA_CORNERS = [{ lat: 7.3, lon: 68 }, { lat: 37.4, lon: 97.7 }];
const INDIA_CENTER = [22.7, 81.2];
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/";
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function mercatorY(latitude) {
  return Math.log(Math.tan((90 + latitude) * Math.PI / 360)) * 180 / Math.PI;
}

function geographicView(origin, facilities, width, height, view) {
  const points = origin ? [origin, ...facilities] : INDIA_CORNERS;
  const xs = points.map(point => point.lon);
  const ys = points.map(point => mercatorY(point.lat));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const padding = 38;
  const scale = view.zoom * Math.min(
    (width - 2 * padding) / Math.max(xmax - xmin, 0.06),
    (height - 2 * padding) / Math.max(ymax - ymin, 0.06),
  );
  const centerX = (xmin + xmax) / 2 + view.longitudeOffset;
  const centerY = (ymin + ymax) / 2 + view.mercatorOffset;
  const toLatitude = y => Math.atan(Math.sinh(y * Math.PI / 180)) * 180 / Math.PI;
  return {
    scale,
    bounds: {
      west: centerX - width / (2 * scale), east: centerX + width / (2 * scale),
      north: toLatitude(centerY + height / (2 * scale)), south: toLatitude(centerY - height / (2 * scale)),
    },
    latitude: Math.atan(Math.sinh(centerY * Math.PI / 180)) * 180 / Math.PI,
    project: (lat, lon) => ({
      x: (lon - centerX) * scale + width / 2,
      y: (centerY - mercatorY(lat)) * scale + height / 2,
    }),
  };
}

function canvasMap(canvas, project, width, height, boundaries, origin) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#d2e5ed";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#f2f1e9";
  ctx.strokeStyle = "#b9c6bf";
  ctx.lineJoin = "round";
  ctx.lineWidth = .7;
  for (const polygon of boundaries) {
    ctx.beginPath();
    for (const ring of polygon) {
      ring.forEach(([lon, lat], i) => {
        const { x, y } = project(lat, lon);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill("evenodd");
    ctx.stroke();
  }
  if (!origin && boundaries.length) {
    const { x, y } = project(...INDIA_CENTER);
    ctx.textAlign = "center";
    ctx.font = "700 13px system-ui";
    ctx.strokeStyle = "#edf1d9";
    ctx.lineWidth = 4;
    ctx.strokeText("I N D I A", x, y);
    ctx.fillStyle = "#335447";
    ctx.fillText("I N D I A", x, y);
  }
}

function coordinateGrid(ctx, area, width, height) {
  const {bounds, project, scale} = area;
  const steps = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20];
  const step = steps.find(size => size * scale >= 100) || 20;
  const digits = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) + (String(step).endsWith("25") ? 1 : 0) : 1;
  const label = value => Number(value.toFixed(digits)) + "°";
  ctx.save();
  ctx.font = "10px system-ui";
  ctx.textAlign = "left";
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "#b3c0bd";
  ctx.fillStyle = "#667777";
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  for (let i = Math.ceil(bounds.west / step); i <= Math.floor(bounds.east / step); i++) {
    const lon = i * step;
    const {x} = project(area.latitude, lon);
    ctx.moveTo(x, 0); ctx.lineTo(x, height);
    if (x > 47 && x < width - 120) ctx.fillText(label(lon) + " E", x + 3, height - 5);
  }
  for (let i = Math.ceil(bounds.south / step); i <= Math.floor(bounds.north / step); i++) {
    const lat = i * step;
    const {y} = project(lat, bounds.west);
    ctx.moveTo(0, y); ctx.lineTo(width, y);
    if (y > 39 && y < height - 20) ctx.fillText(label(lat) + " N", 4, y - 3);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPlaces(ctx, places, area, width, height, foreground) {
  const {project, bounds} = area;
  const inView = (lat, lon) => lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
  const occupied = [
    {x: 0, y: 0, w: 124, h: 42}, {x: 0, y: height - 25, w: width, h: 25},
    ...foreground.filter(p => inView(p.lat, p.lon)).map(p => {
      const {x, y} = project(p.lat, p.lon);
      return {x: x - 19, y: y - 26, w: 38, h: 48};
    }),
  ];
  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const box = bounds.east - bounds.west;
  const maxTier = box > 0.8 ? 0 : box > 0.3 ? 1 : 2;
  const limit = Math.max(5, Math.min(42, Math.round(width * height / (box > 4 ? 18000 : 9000))));
  let count = 0;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.textAlign = "left";
  for (const [lat, lon, sourceName, tier] of places) {
    if (tier > maxTier || !inView(lat, lon)) continue;
    const {x, y} = project(lat, lon);
    const name = /^[A-Z ]{5,}$/.test(sourceName)
      ? sourceName.toLowerCase().replace(/(^|\s)\p{L}/gu, ch => ch.toUpperCase()) : sourceName;
    ctx.font = tier === 0 ? "600 13px system-ui" : "12px system-ui";
    const w = ctx.measureText(name).width;
    const h = 15;
    const positions = [[x + 5, y - 6], [x - w - 6, y - 6], [x - w / 2, y - h - 4], [x - w / 2, y + 4]];
    const pos = positions.find(([left, top]) => left >= 4 && top >= 4 && left + w + 4 < width && top + h + 4 < height
      && !occupied.some(b => intersects(b, {x: left - 3, y: top - 2, w: w + 6, h: h + 4})));
    if (!pos) continue;
    const [left, top] = pos;
    occupied.push({x: left - 6, y: top - 4, w: w + 12, h: h + 8});
    ctx.beginPath(); ctx.arc(x, y, tier === 0 ? 2.8 : 2, 0, Math.PI * 2);
    ctx.fillStyle = "#647677"; ctx.fill();
    ctx.strokeStyle = "#fafaf4"; ctx.lineWidth = 3.2; ctx.strokeText(name, left, top + 12);
    ctx.fillStyle = tier === 0 ? "#3d5157" : "#53656a"; ctx.fillText(name, left, top + 12);
    if (++count >= limit) break;
  }
  ctx.restore();
}

function addMapAsset(tag, props) {
  return new Promise((resolve, reject) => {
    const element = document.createElement(tag);
    Object.assign(element, props);
    element.onload = resolve;
    element.onerror = () => {
      element.remove();
      reject(new Error("The street map could not be loaded."));
    };
    document.head.append(element);
  });
}

let leafletLoading;
function leaflet() {
  if (!leafletLoading) {
    leafletLoading = Promise.all([
      addMapAsset("link", { rel: "stylesheet", href: LEAFLET + "leaflet.css",
        integrity: "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=", crossOrigin: "anonymous" }),
      addMapAsset("script", { src: LEAFLET + "leaflet.js",
        integrity: "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=", crossOrigin: "anonymous" }),
    ]).then(() => window.L).catch(error => {
      leafletLoading = undefined;
      throw error;
    });
  }
  return leafletLoading;
}

function pin(label, className, text = "", clickable = false) {
  const element = document.createElement(clickable ? "button" : "span");
  if (clickable) element.type = "button";
  element.className = className;
  const inner = document.createElement("span");
  inner.className = "pin-number";
  inner.textContent = text;
  element.append(inner);
  element.title = label;
  if (clickable) element.setAttribute("aria-label", label);
  return element;
}

function placePin(element, point) {
  element.style.left = point.x + "px";
  element.style.top = point.y + "px";
}

export function facilityMap({ stage, canvas, markerLayer, local, street, button, onSelect, onUnavailable }) {
  let origin = null;
  let results = [];
  let travelMode = "driving";
  let boundaries = [];
  let places = [];
  let active = null;
  let streetMap = null;
  let streetMarkers;
  let streetPins = [];
  let streetOn = false;
  let L;
  let scale = 1;
  let drawPending = false;
  const view = {zoom: 1, longitudeOffset: 0, mercatorOffset: 0};
  const localPopup = document.createElement("div");
  localPopup.className = "local-popup";
  localPopup.hidden = true;
  localPopup.setAttribute("role", "region");
  localPopup.setAttribute("aria-label", "Selected facility");
  const tools = document.createElement("div");
  tools.className = "map-tools";
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Map controls");

  function control(label, caption, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = caption;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", handler);
    return button;
  }

  function resetView() {
    Object.assign(view, {zoom: 1, longitudeOffset: 0, mercatorOffset: 0});
  }

  function redraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; drawLocal(); });
  }

  function zoom(factor) {
    view.zoom = Math.min(64, Math.max(0.5, view.zoom * factor));
    redraw();
  }

  const plus = control("Zoom in", "+", () => zoom(2));
  const minus = control("Zoom out", "−", () => zoom(0.5));
  tools.append(plus, minus, control("Fit all locations", "Fit", () => { resetView(); redraw(); }));
  canvas.style.touchAction = "none";
  local.tabIndex = 0;
  local.setAttribute("role", "region");
  local.setAttribute("aria-label", "Local facility map. Use arrow keys to pan, plus and minus to zoom, and Home to fit all locations.");
  local.append(tools, localPopup);
  local.addEventListener("keydown", event => {
    if (event.key === "Escape" && !localPopup.hidden) {
      localPopup.hidden = true;
      markerLayer.querySelector(`[data-rank="${active}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (event.target !== local) return;
    switch (event.key) {
      case "ArrowLeft": view.longitudeOffset -= 60 / scale; break;
      case "ArrowRight": view.longitudeOffset += 60 / scale; break;
      case "ArrowUp": view.mercatorOffset += 60 / scale; break;
      case "ArrowDown": view.mercatorOffset -= 60 / scale; break;
      case "+": case "=": zoom(2); break;
      case "-": zoom(0.5); break;
      case "Home": resetView(); break;
      default: return;
    }
    event.preventDefault();
    redraw();
  });

  let drag;
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary) return;
    drag = {x: event.clientX, y: event.clientY};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!drag || !canvas.hasPointerCapture(event.pointerId)) return;
    view.longitudeOffset -= (event.clientX - drag.x) / scale;
    view.mercatorOffset += (event.clientY - drag.y) / scale;
    drag = {x: event.clientX, y: event.clientY};
    redraw();
  });
  canvas.addEventListener("lostpointercapture", () => { drag = undefined; });

  function drawLocal() {
    if (streetOn) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    if (width < 90 || height < 90) return;
    const facilities = results.map(r => r.facility);
    const area = geographicView(origin, facilities, width, height, view);
    const {project, scale: currentScale, latitude} = area;
    scale = currentScale;
    plus.disabled = view.zoom >= 64;
    minus.disabled = view.zoom <= 0.5;
    canvasMap(canvas, project, width, height, boundaries, origin);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      coordinateGrid(ctx, area, width, height);
      drawPlaces(ctx, places, area, width, height, origin ? [origin, ...facilities] : []);
      // Draw a metric scale at the centre latitude of this Web Mercator view.
      const kmPerPixel = 111.32 * Math.cos(latitude * Math.PI / 180) / scale;
      const maxKm = Math.max(kmPerPixel * Math.min(100, width * 0.25), 0.00001);
      const unit = 10 ** Math.floor(Math.log10(maxKm));
      const km = (maxKm >= 5 * unit ? 5 : maxKm >= 2 * unit ? 2 : 1) * unit;
      const px = km / kmPerPixel;
      const x = width - 12 - px, y = height - 12;
      ctx.font = "11px system-ui";
      ctx.textAlign = "right";
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#425b63";
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
      ctx.fillStyle = "#304b54";
      ctx.fillText(km < 1 ? Math.round(km * 1000) + " m" : km + " km", x + px, y - 7);
    }
    markerLayer.replaceChildren();
    const placed = [];
    if (origin) {
      const home = pin("Your location: " + origin.label, "local-origin", "⌂");
      const exact = project(origin.lat, origin.lon);
      placePin(home, exact);
      placed.push(exact);
      markerLayer.append(home);
    }
    results.forEach(({facility}, index) => {
      const label = `${index + 1}. ${facility.name}`;
      const marker = pin(label, "map-marker", index + 1, true);
      const exact = project(facility.lat, facility.lon);
      if (exact.x < -15 || exact.x > width + 15 || exact.y < -15 || exact.y > height + 15) return;
      let candidate = exact;
      // Distinguish nearby branches without hiding their geographic positions.
      for (let attempt = 1; placed.some(p => Math.hypot(p.x - candidate.x, p.y - candidate.y) < 30) && attempt <= 24; attempt++) {
        const angle = attempt * 2.39996, offset = 12 * Math.sqrt(attempt);
        candidate = {
          x: Math.min(width - 18, Math.max(18, exact.x + Math.cos(angle) * offset)),
          y: Math.min(height - 18, Math.max(18, exact.y + Math.sin(angle) * offset)),
        };
      }
      if (ctx && candidate !== exact) {
        ctx.strokeStyle = "#708b94";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(exact.x, exact.y); ctx.lineTo(candidate.x, candidate.y); ctx.stroke();
      }
      placed.push(candidate);
      placePin(marker, candidate);
      marker.dataset.rank = index;
      marker.dataset.active = index === active;
      marker.addEventListener("click", () => onSelect(index));
      markerLayer.append(marker);
    });
  }

  function fitStreet() {
    const points = origin ? [origin, ...results.map(r => r.facility)] : INDIA_CORNERS;
    streetMap.fitBounds(points.map(p => [p.lat, p.lon]), {padding: [38, 38], maxZoom: origin ? 15 : 5, animate: false});
  }

  function drawStreet() {
    streetMap.invalidateSize();
    streetMarkers.clearLayers();
    if (origin) {
      L.marker([origin.lat, origin.lon], {
        title: "Your location: " + origin.label, alt: "Your location",
        icon: L.divIcon({className: "map-leaflet-pin", html: pin("", "local-origin", "⌂"), iconSize: [30, 30], iconAnchor: [15, 15]}),
      }).bindTooltip(document.createTextNode("Your location: " + origin.label)).addTo(streetMarkers);
    }
    streetPins = results.map((result, index) => {
      const {facility} = result;
      const label = `${index + 1}. ${facility.name}`;
      const marker = pin(label, "map-marker", index + 1);
      marker.dataset.rank = index;
      marker.dataset.active = index === active;
      return L.marker([facility.lat, facility.lon], {
        title: label, alt: label,
        icon: L.divIcon({className: "map-leaflet-pin", html: marker, iconSize: [32, 36], iconAnchor: [16, 34], popupAnchor: [0, -27]}),
        zIndexOffset: index === active ? 200 : 0,
      }).bindPopup(() => facilityPopup(result, index, {origin, travelMode}), {maxWidth: 320, maxHeight: Math.max(140, stage.clientHeight - 105)})
        .on("click", () => onSelect(index)).addTo(streetMarkers);
    });
    fitStreet();
  }

  function localDetails(index, focus) {
    if (focus && !markerLayer.querySelector(`[data-rank="${index}"]`)) {
      resetView();
      drawLocal();
    }
    const close = control("Close facility popup", "×", () => {
      localPopup.hidden = true;
      markerLayer.querySelector(`[data-rank="${index}"]`)?.focus({preventScroll: true});
    });
    close.className = "map-popup-close";
    localPopup.replaceChildren(close, facilityPopup(results[index], index, {origin, travelMode}));
    localPopup.hidden = false;
    if (focus) close.focus({preventScroll: true});
  }

  function setStreet(on) {
    const popupWasOpen = active !== null && (streetOn ? streetPins[active]?.isPopupOpen() : !localPopup.hidden);
    streetOn = on;
    street.hidden = !on;
    local.hidden = on;
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Use local map" : "Use street map";
    if (on) {
      drawStreet();
      if (popupWasOpen) streetPins[active]?.openPopup();
    } else {
      drawLocal();
      localPopup.hidden = true;
      if (popupWasOpen) localDetails(active, false);
    }
  }

  button.addEventListener("click", async () => {
    if (streetOn) { setStreet(false); return; }
    button.disabled = true;
    button.textContent = "Loading street map…";
    try {
      L = await leaflet();
      if (!streetMap) {
        streetMap = L.map(street, {scrollWheelZoom: false});
        L.control.scale({imperial: false}).addTo(streetMap);
        const fitControl = L.control({position: "topleft"});
        fitControl.onAdd = () => {
          const container = L.DomUtil.create("div", "leaflet-bar");
          const fit = control("Fit all locations", "Fit", fitStreet);
          container.append(fit);
          L.DomEvent.disableClickPropagation(container);
          return container;
        };
        fitControl.addTo(streetMap);
        const tiles = L.tileLayer(TILE_URL, {maxZoom: 19, attribution: TILE_ATTRIBUTION});
        let hadTile = false, hadError = false;
        tiles.on("loading", () => { hadTile = false; hadError = false; });
        tiles.on("tileload", () => { hadTile = true; });
        tiles.on("tileerror", () => { hadError = true; });
        tiles.on("load", () => {
          if (streetOn && hadError && !hadTile) {
            setStreet(false);
            onUnavailable("Street map tiles are unavailable. Showing the local map.");
          }
        });
        tiles.addTo(streetMap);
        streetMarkers = L.layerGroup().addTo(streetMap);
      }
      setStreet(true);
    } catch {
      setStreet(false);
      onUnavailable("The street map could not load. Showing the local map.");
    } finally {
      button.disabled = false;
    }
  });

  fetch(new URL("./boundaries.json", import.meta.url))
    .then(response => response.ok ? response.json() : [])
    .then(polygons => { boundaries = polygons; redraw(); })
    .catch(() => { /* Origin and result pins remain usable without the outline. */ });

  fetch(new URL("./map-places.json", import.meta.url))
    .then(response => response.ok ? response.json() : null)
    .then(data => { places = data?.places ?? []; redraw(); })
    .catch(() => { /* Coordinate grid and district outlines still give local context. */ });

  new ResizeObserver(() => {
    if (streetOn) streetMap.invalidateSize();
    else redraw();
  }).observe(stage);

  return {
    show(newOrigin, newResults, options = {}) {
      origin = newOrigin;
      results = newResults;
      travelMode = options.travelMode || "driving";
      active = null;
      localPopup.hidden = true;
      resetView();
      if (streetOn) drawStreet();
      else drawLocal();
    },
    highlight(index, focus = false) {
      if (!results[index]) return;
      active = index;
      const layer = streetOn ? street : markerLayer;
      for (const marker of layer.querySelectorAll("[data-rank]")) {
        marker.dataset.active = Number(marker.dataset.rank) === index;
      }
      if (streetOn) {
        for (const [i, pin] of streetPins.entries()) pin.setZIndexOffset(i === index ? 200 : 0);
        streetPins[index].openPopup();
        if (focus) streetPins[index].getElement()?.focus({preventScroll: true});
      } else {
        localDetails(index, focus);
      }
    },
  };
}
