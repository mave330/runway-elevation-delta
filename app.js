const R = 6371.01;

const RUNWAYS_CSV_URL =
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv";

const OPEN_ELEVATION_URL =
  "https://api.open-elevation.com/api/v1/lookup";

let latestRows = [];
let map = null;
let markersLayer = null;

/* =========================
   UI helpers
========================= */

function setStatus(message, type) {
  const el = document.getElementById("status");
  el.className = "status " + (type || "");
  el.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createCell(text, className) {
  const td = document.createElement("td");

  if (className) {
    td.className = className;
  }

  td.textContent = text;
  return td;
}

function fmt(value, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }

  return Number(value).toLocaleString("fr-FR", {
    minimumFractionDigits: decimals || 0,
    maximumFractionDigits: decimals || 0
  });
}

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

/* =========================
   Geometry
========================= */

function toRad(x) {
  return x * Math.PI / 180;
}

function toDeg(x) {
  return x * 180 / Math.PI;
}

function bearing(lat1, lon1, lat2, lon2) {
  const rLat1 = toRad(lat1);
  const rLon1 = toRad(lon1);
  const rLat2 = toRad(lat2);
  const rLon2 = toRad(lon2);

  const dLon = rLon2 - rLon1;

  const y = Math.sin(dLon) * Math.cos(rLat2);
  const x =
    Math.cos(rLat1) * Math.sin(rLat2) -
    Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function getPoint(lat, lon, brng, dKm) {
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const brngRad = toRad(brng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dKm / R) +
    Math.cos(lat1) * Math.sin(dKm / R) * Math.cos(brngRad)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brngRad) * Math.sin(dKm / R) * Math.cos(lat1),
      Math.cos(dKm / R) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: toDeg(lat2),
    lon: toDeg(lon2)
  };
}

/* =========================
   CSV parser robuste
========================= */

function parseCSV(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(current);
      current = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (current.length || row.length) {
        row.push(current);
        rows.push(row);
        row = [];
        current = "";
      }

      if (c === "\r" && next === "\n") {
        i++;
      }
    } else {
      current += c;
    }
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  const headers = rows.shift();

  if (!headers) {
    return [];
  }

  return rows.map(function(values) {
    const obj = {};

    headers.forEach(function(h, i) {
      obj[h] = values[i] || "";
    });

    return obj;
  });
}

function n(value) {
  const x = parseFloat(value);
  return Number.isFinite(x) ? x : null;
}

/* =========================
   Elevation API
========================= */

async function getElevationFt(lat, lon) {
  const url =
    OPEN_ELEVATION_URL +
    "?locations=" +
    encodeURIComponent(lat + "," + lon);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Erreur Open-Elevation " + response.status);
  }

  const data = await response.json();

  if (!data.results || !data.results[0]) {
    throw new Error("Réponse Open-Elevation vide");
  }

  return data.results[0].elevation * 3.28084;
}

/* =========================
   Map Leaflet / OpenStreetMap
========================= */

function initMap() {
  if (!window.L) {
    return;
  }

  if (map) {
    return;
  }

  map = L.map("map", {
    scrollWheelZoom: true
  }).setView([48.8566, 2.3522], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function updateMap(rows) {
  if (!window.L) {
    setStatus(
      "Résultats calculés, mais Leaflet n'est pas chargé : carte indisponible.",
      "warn"
    );
    return;
  }

  initMap();

  if (!markersLayer) {
    return;
  }

  markersLayer.clearLayers();

  const bounds = [];

  rows.forEach(function(r) {
    if (!Number.isFinite(r.projectedLat) || !Number.isFinite(r.projectedLon)) {
      return;
    }

    const hasDelta = Number.isFinite(r.deltaFt);

    const deltaText = hasDelta
      ? (r.deltaFt >= 0 ? "+" : "") + fmt(r.deltaFt) + " ft"
      : "—";

    const markerColor = hasDelta && r.deltaFt >= 0 ? "#22c55e" : "#fb7185";
    const fillColor = hasDelta && r.deltaFt >= 0 ? "#4ade80" : "#fb7185";

    const marker = L.circleMarker([r.projectedLat, r.projectedLon], {
      radius: 8,
      color: markerColor,
      weight: 3,
      fillColor: fillColor,
      fillOpacity: 0.85
    });

    marker.bindPopup(
      "<strong>QFU " + escapeHtml(r.qfu) + "</strong><br>" +
      "Piste : " + escapeHtml(r.runwayPair) + "<br>" +
      "Seuil : " + escapeHtml(fmt(r.thresholdElevationFt)) + " ft<br>" +
      "Terrain : " + escapeHtml(fmt(r.terrainElevationFt)) + " ft<br>" +
      "Delta : <strong>" + escapeHtml(deltaText) + "</strong><br>" +
      "Point : " +
      r.projectedLat.toFixed(6) +
      ", " +
      r.projectedLon.toFixed(6)
    );

    marker.addTo(markersLayer);
    bounds.push([r.projectedLat, r.projectedLon]);
  });

  if (bounds.length > 0) {
    map.fitBounds(bounds, {
      padding: [35, 35],
      maxZoom: 13
    });
  }
}

/* =========================
   Table rendering
========================= */

function addResultRow(r) {
  const tbody = document.getElementById("tbody");
  const tr = document.createElement("tr");

