const INDIA_CORNERS = [{ lat: 7.3, lon: 68 }, { lat: 37.4, lon: 97.7 }];
const INDIA_CENTER = [22.7, 81.2];
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/";
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function mercatorY(latitude) {
  return Math.log(Math.tan((90 + latitude) * Math.PI / 360)) * 180 / Math.PI;
}

function geographicView(origin, facilities, width, height) {
  const locations = origin ? [origin, ...facilities] : INDIA_CORNERS;
  const xs = locations.map(point => point.lon);
  const ys = locations.map(point => mercatorY(point.lat));
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const ymin = Math.min(...ys);
  const ymax = Math.max(...ys);
  const pad = 31;
  const scale = Math.min(
    (width - 2 * pad) / Math.max(xmax - xmin, 0.09),
    (height - 2 * pad) / Math.max(ymax - ymin, 0.09),
  );
  return (lat, lon) => ({
    x: (lon - (xmin + xmax) / 2) * scale + width / 2,
    y: ((ymin + ymax) / 2 - mercatorY(lat)) * scale + height / 2,
  });
}

function canvasMap(canvas, project, width, height, boundaries, origin) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#e2eee9";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d5e6df";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = width % 56 / 2; x < width; x += 56) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = height % 56 / 2; y < height; y += 56) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#edf1d9";
  ctx.strokeStyle = "#a9beb0";
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
  element.textContent = text;
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
  let facilities = [];
  let boundaries = [];
  let active = null;
  let streetMap = null;
  let streetMarkers = null;
  let streetOn = false;
  let L = null;

  function drawLocal() {
    if (streetOn) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (width < 90 || height < 90) return;
    const project = geographicView(origin, facilities, width, height);
    canvasMap(canvas, project, width, height, boundaries, origin);
    markerLayer.replaceChildren();
    if (origin) {
      const point = pin("Your location: " + origin.label, "local-origin");
      placePin(point, project(origin.lat, origin.lon));
      markerLayer.append(point);
    }
    const placed = [];
    facilities.forEach((facility, index) => {
      const label = `${index + 1}. ${facility.name}`;
      const marker = pin(label, "map-marker", index + 1, true);
      const exact = project(facility.lat, facility.lon);
      let candidate = exact;
      // Shift coincident markers within the view so every numbered option remains reachable.
      for (let attempt = 1; placed.some(point => Math.hypot(point.x - candidate.x, point.y - candidate.y) < 33) && attempt <= 24; attempt++) {
        const angle = attempt * 2.39996;
        const offset = 12 * Math.sqrt(attempt);
        candidate = {
          x: Math.min(width - 18, Math.max(18, exact.x + Math.cos(angle) * offset)),
          y: Math.min(height - 18, Math.max(18, exact.y + Math.sin(angle) * offset)),
        };
      }
      placed.push(candidate);
      placePin(marker, candidate);
      marker.dataset.rank = index;
      marker.dataset.active = index === active;
      marker.addEventListener("click", () => onSelect(index));
      markerLayer.append(marker);
    });
  }

  function drawStreet() {
    if (!streetOn) return;
    streetMap.invalidateSize();
    streetMarkers.clearLayers();
    const points = [];
    if (origin) {
      const coordinates = [origin.lat, origin.lon];
      L.marker(coordinates, {
        title: "Your location: " + origin.label, keyboard: false,
        icon: L.divIcon({ className: "map-leaflet-pin", html: pin("", "local-origin"), iconSize: [15, 15], iconAnchor: [7, 7] }),
      }).addTo(streetMarkers);
      points.push(coordinates);
    }
    facilities.forEach((facility, index) => {
      const coordinates = [facility.lat, facility.lon];
      const label = `${index + 1}. ${facility.name}`;
      const markerNode = pin(label, "map-marker", index + 1);
      markerNode.dataset.rank = index;
      markerNode.dataset.active = index === active;
      L.marker(coordinates, {
        title: label,
        icon: L.divIcon({ className: "map-leaflet-pin", html: markerNode, iconSize: [34, 34], iconAnchor: [17, 17] }),
        zIndexOffset: index === active ? 200 : 0,
      }).on("click", () => onSelect(index)).addTo(streetMarkers);
      points.push(coordinates);
    });
    streetMap.fitBounds(points.length ? points : INDIA_CORNERS.map(({ lat, lon }) => [lat, lon]), {
      padding: [35, 35],
      maxZoom: origin ? 12 : 5,
      animate: false,
    });
  }

  function setStreet(on) {
    streetOn = on;
    street.hidden = !on;
    local.hidden = on;
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Use local map" : "Use street map";
    if (on) drawStreet();
    else drawLocal();
  }

  button.addEventListener("click", async () => {
    if (streetOn) {
      setStreet(false);
      return;
    }
    button.disabled = true;
    button.textContent = "Loading street map…";
    try {
      L = await leaflet();
      if (!streetMap) {
        streetMap = L.map(street, { scrollWheelZoom: false });
        const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION });
        let successfulTile = false;
        let fallbackTimer;
        tiles.on("tileload", () => { successfulTile = true; });
        tiles.on("loading", () => { successfulTile = false; });
        tiles.on("tileerror", () => {
          clearTimeout(fallbackTimer);
          fallbackTimer = setTimeout(() => {
            if (streetOn && !successfulTile) {
              setStreet(false);
              onUnavailable("Street map tiles are unavailable. Showing the local map.");
            }
          }, 650);
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
    .then(polygons => { boundaries = polygons; drawLocal(); })
    .catch(() => { /* Numbered pins remain available above the plain map background. */ });

  new ResizeObserver(() => {
    if (streetOn) streetMap.invalidateSize();
    else drawLocal();
  }).observe(stage);

  return {
    show(newOrigin, newFacilities) {
      origin = newOrigin;
      facilities = newFacilities;
      active = null;
      if (streetOn) drawStreet();
      else drawLocal();
    },
    highlight(index, focus = false) {
      active = index;
      const mapLayer = streetOn ? street : markerLayer;
      for (const marker of mapLayer.querySelectorAll("[data-rank]")) {
        marker.dataset.active = Number(marker.dataset.rank) === index;
      }
      if (focus) {
        const marker = mapLayer.querySelector(`[data-rank="${index}"]`);
        const target = streetOn ? marker?.closest(".leaflet-marker-icon") : marker;
        target?.focus({ preventScroll: true });
      }
    },
  };
}
