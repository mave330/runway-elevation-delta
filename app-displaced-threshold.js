const R = 6371.01;
const RUNWAYS_CSV_URL = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv";
const OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup";

let latestRows = [];
let map = null;
let markersLayer = null;

/* =========================
   UI helpers
========================= */
function setStatus(message, type) {
  const el = document.getElementById("status");
  if (!el) return;
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
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function fmt(value, decimals = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString("fr-FR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   Geometry
========================= */
function toRad(x) { return x * Math.PI / 180; }
function toDeg(x) { return x * 180 / Math.PI; }

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
  return { lat: toDeg(lat2), lon: toDeg(lon2) };
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
      if (c === "\r" && next === "\n") i++;
    } else {
      current += c;
    }
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  const headers = rows.shift();
  if (!headers) return [];

  return rows.map(values => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i] || "");
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
  const url = OPEN_ELEVATION_URL + "?locations=" + encodeURIComponent(lat + "," + lon);
  const response = await fetch(url);
  if (!response.ok) throw new Error("Erreur Open-Elevation " + response.status);
  const data = await response.json();
  if (!data.results || !data.results[0]) throw new Error("Réponse Open-Elevation vide");
  return data.results[0].elevation * 3.28084;
}

/* =========================
   Operational threshold logic
   Uses OurAirports displaced-threshold distance fields.
========================= */
function interpolateElevation(startElev, endElev, displacementFt, runwayLengthFt) {
  if (!Number.isFinite(startElev)) return 0;
  if (!Number.isFinite(endElev)) return startElev;
  if (!Number.isFinite(displacementFt) || displacementFt <= 0) return startElev;
  if (!Number.isFinite(runwayLengthFt) || runwayLengthFt <= 0) return startElev;

  const ratio = Math.max(0, Math.min(1, displacementFt / runwayLengthFt));
  return startElev + (endElev - startElev) * ratio;
}

function makeQfuPoint(params) {
  const {
    airport,
    runwayPair,
    qfu,
    physicalLat,
    physicalLon,
    oppositeLat,
    oppositeLon,
    physicalElevationFt,
    oppositeElevationFt,
    displacedThresholdFt,
    runwayLengthFt,
    distanceNm
  } = params;

  const displacementFt = Number.isFinite(displacedThresholdFt) ? displacedThresholdFt : 0;
  const displacementKm = Math.max(0, displacementFt) * 0.0003048;

  // Direction from the physical runway end into the runway, toward the opposite end.
  const inwardBearing = bearing(physicalLat, physicalLon, oppositeLat, oppositeLon);

  // Direction from the operational threshold outward into the approach path.
  const outwardBearing = bearing(oppositeLat, oppositeLon, physicalLat, physicalLon);

  const thresholdPoint = displacementKm > 0
    ? getPoint(physicalLat, physicalLon, inwardBearing, displacementKm)
    : { lat: physicalLat, lon: physicalLon };

  const thresholdElevationFt = interpolateElevation(
    physicalElevationFt,
    oppositeElevationFt,
    displacementFt,
    runwayLengthFt
  );

  const projectedPoint = getPoint(
    thresholdPoint.lat,
    thresholdPoint.lon,
    outwardBearing,
    distanceNm * 1.852
  );

  return {
    airport,
    runwayPair,
    qfu,
    displacedThresholdFt: displacementFt,
    thresholdSource: displacementFt > 0 ? "Displaced threshold computed" : "Physical runway end",
    physicalThresholdLat: physicalLat,
    physicalThresholdLon: physicalLon,
    operationalThresholdLat: thresholdPoint.lat,
    operationalThresholdLon: thresholdPoint.lon,
    thresholdElevationFt,
    projectedLat: projectedPoint.lat,
    projectedLon: projectedPoint.lon,
    bearing: outwardBearing,
    distanceNm
  };
}

/* =========================
   Map Leaflet / OpenStreetMap
========================= */
function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl || !window.L || map) return;

  map = L.map("map", { scrollWheelZoom: true }).setView([48.8566, 2.3522], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function updateMap(rows) {
  if (!window.L) {
    setStatus("Résultats calculés, mais Leaflet n'est pas chargé : carte indisponible.", "warn");
    return;
  }

  initMap();
  if (!markersLayer) return;

  markersLayer.clearLayers();
  const bounds = [];

  rows.forEach(r => {
    if (!Number.isFinite(r.projectedLat) || !Number.isFinite(r.projectedLon)) return;

    const hasDelta = Number.isFinite(r.deltaFt);
    const deltaText = hasDelta
      ? (r.deltaFt >= 0 ? "+" : "") + fmt(r.deltaFt) + " ft"
      : "—";
    const markerColor = hasDelta && r.deltaFt >= 0 ? "#22c55e" : "#fb7185";

    const marker = L.circleMarker([r.projectedLat, r.projectedLon], {
      radius: 8,
      color: markerColor,
      weight: 3,
      fillColor: markerColor,
      fillOpacity: 0.85
    });

    marker.bindPopup(
      "<strong>QFU " + escapeHtml(r.qfu) + "</strong><br>" +
      "Piste : " + escapeHtml(r.runwayPair) + "<br>" +
      "Référence : " + escapeHtml(r.thresholdSource) + "<br>" +
      "Displaced threshold : " + escapeHtml(fmt(r.displacedThresholdFt)) + " ft<br>" +
      "Seuil utilisé : " + r.operationalThresholdLat.toFixed(6) + ", " + r.operationalThresholdLon.toFixed(6) + "<br>" +
      "Seuil elev. : " + escapeHtml(fmt(r.thresholdElevationFt)) + " ft<br>" +
      "Terrain point : " + escapeHtml(fmt(r.terrainElevationFt)) + " ft<br>" +
      "Delta : <strong>" + escapeHtml(deltaText) + "</strong><br>" +
      "Point projeté : " + r.projectedLat.toFixed(6) + ", " + r.projectedLon.toFixed(6)
    );

    marker.addTo(markersLayer);
    bounds.push([r.projectedLat, r.projectedLon]);
  });

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [35, 35], maxZoom: 13 });
  }
}

/* =========================
   Table rendering
========================= */
function addResultRow(r) {
  const tbody = document.getElementById("tbody");
  const tr = document.createElement("tr");

  const tdQfu = document.createElement("td");
  const span = document.createElement("span");
  span.className = "qfu";
  span.textContent = r.qfu;
  tdQfu.appendChild(span);

  tr.appendChild(tdQfu);
  tr.appendChild(createCell(r.runwayPair));
  tr.appendChild(createCell(fmt(r.thresholdElevationFt) + " ft"));

  if (Number.isFinite(r.terrainElevationFt)) {
    tr.appendChild(createCell(fmt(r.terrainElevationFt) + " ft"));
    const deltaClass = r.deltaFt >= 0 ? "positive" : "negative";
    const deltaSign = r.deltaFt >= 0 ? "+" : "";
    tr.appendChild(createCell(deltaSign + fmt(r.deltaFt) + " ft", "delta-cell " + deltaClass));
  } else {
    tr.appendChild(createCell("Erreur API"));
    tr.appendChild(createCell("—", "delta-cell"));
  }

  tr.appendChild(createCell(r.projectedLat.toFixed(6) + ", " + r.projectedLon.toFixed(6)));
  tr.appendChild(createCell(fmt(r.bearing, 1) + "°"));

  if (r.displacedThresholdFt > 0) {
    tr.title = "Seuil décalé utilisé : " + fmt(r.displacedThresholdFt) + " ft depuis l’extrémité physique. Seuil calculé : " +
      r.operationalThresholdLat.toFixed(6) + ", " + r.operationalThresholdLon.toFixed(6);
  }

  tbody.appendChild(tr);
}

/* =========================
   Main compute
========================= */
async function run() {
  const btn = document.getElementById("computeBtn");
  const tbody = document.getElementById("tbody");
  const icao = document.getElementById("icao").value.trim().toUpperCase();
  const distanceNm = parseFloat(document.getElementById("dist").value);

  latestRows = [];
  tbody.innerHTML = "";
  document.getElementById("summary").classList.add("hidden");
  document.getElementById("actions").classList.add("hidden");
  if (markersLayer) markersLayer.clearLayers();

  if (!icao || !/^[A-Z0-9]{3,5}$/.test(icao)) {
    setStatus("Code aéroport invalide. Exemple : LFPG, LFPO, LFML, KLAX.", "err");
    return;
  }

  if (!Number.isFinite(distanceNm) || distanceNm <= 0) {
    setStatus("Distance invalide. Saisis une distance positive en NM.", "err");
    return;
  }

  btn.disabled = true;
  setStatus("Téléchargement automatique du fichier runways.csv depuis OurAirports pour " + icao + "...", "");

  try {
    const response = await fetch(RUNWAYS_CSV_URL);
    if (!response.ok) throw new Error("Impossible de télécharger runways.csv");
    const csvText = await response.text();

    setStatus("Fichier téléchargé. Analyse des pistes et seuils décalés...", "");
    const data = parseCSV(csvText);
    const airportRows = data.filter(row => row.airport_ident && row.airport_ident.trim().toUpperCase() === icao);

    if (!airportRows.length) {
      setStatus("Aucune piste trouvée pour " + icao + " dans OurAirports. Vérifie le code ICAO.", "warn");
      return;
    }

    const points = [];

    airportRows.forEach(row => {
      const le = row.le_ident;
      const he = row.he_ident;

      const leLat = n(row.le_latitude_deg);
      const leLon = n(row.le_longitude_deg);
      const heLat = n(row.he_latitude_deg);
      const heLon = n(row.he_longitude_deg);

      const leElev = n(row.le_elevation_ft) ?? 0;
      const heElev = n(row.he_elevation_ft) ?? 0;
      const runwayLengthFt = n(row.length_ft);

      const leDisp = n(row.le_displaced_threshold_ft) ?? 0;
      const heDisp = n(row.he_displaced_threshold_ft) ?? 0;

      if (!le || !he || leLat === null || leLon === null || heLat === null || heLon === null) return;

      points.push(makeQfuPoint({
        airport: icao,
        runwayPair: le + "/" + he,
        qfu: le,
        physicalLat: leLat,
        physicalLon: leLon,
        oppositeLat: heLat,
        oppositeLon: heLon,
        physicalElevationFt: leElev,
        oppositeElevationFt: heElev,
        displacedThresholdFt: leDisp,
        runwayLengthFt,
        distanceNm
      }));

      points.push(makeQfuPoint({
        airport: icao,
        runwayPair: le + "/" + he,
        qfu: he,
        physicalLat: heLat,
        physicalLon: heLon,
        oppositeLat: leLat,
        oppositeLon: leLon,
        physicalElevationFt: heElev,
        oppositeElevationFt: leElev,
        displacedThresholdFt: heDisp,
        runwayLengthFt,
        distanceNm
      }));
    });

    if (!points.length) {
      setStatus("Des pistes existent pour " + icao + ", mais les coordonnées seuils sont incomplètes dans OurAirports.", "warn");
      return;
    }

    points.sort((a, b) => String(a.qfu).localeCompare(String(b.qfu), "fr", { numeric: true }));

    const displacedCount = points.filter(p => p.displacedThresholdFt > 0).length;
    setStatus(points.length + " QFU trouvés, dont " + displacedCount + " avec seuil décalé. Récupération des altitudes terrain...", "");

    for (let i = 0; i < points.length; i++) {
      const r = points[i];
      setStatus("Calcul " + (i + 1) + "/" + points.length + " : QFU " + r.qfu +
        (r.displacedThresholdFt > 0 ? " — seuil décalé " + fmt(r.displacedThresholdFt) + " ft" : "") + "...", "");

      try {
        const terrainFt = await getElevationFt(r.projectedLat, r.projectedLon);
        r.terrainElevationFt = terrainFt;
        r.deltaFt = terrainFt - r.thresholdElevationFt;
      } catch (elevError) {
        r.terrainElevationFt = null;
        r.deltaFt = null;
      }

      latestRows.push(r);
      addResultRow(r);
      await delay(300);
    }

    updateSummary(icao);
    updateMap(latestRows);
    document.getElementById("actions").classList.remove("hidden");
    setStatus("Compute done : " + latestRows.length + " QFU affichés pour " + icao + ". Seuils décalés pris en compte quand disponibles.", "ok");

  } catch (err) {
    setStatus("Erreur : " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

/* =========================
   Summary
========================= */
function updateSummary(icao) {
  const deltas = latestRows.map(r => r.deltaFt).filter(v => Number.isFinite(v));
  document.getElementById("summary").classList.remove("hidden");
  document.getElementById("sumAirport").textContent = icao;
  document.getElementById("sumQfu").textContent = latestRows.length;
  document.getElementById("sumMin").textContent = deltas.length ? fmt(Math.min(...deltas)) + " ft" : "—";
  document.getElementById("sumMax").textContent = deltas.length ? fmt(Math.max(...deltas)) + " ft" : "—";
}

/* =========================
   CSV export
========================= */
function downloadCsv() {
  if (!latestRows.length) return;

  const headers = [
    "airport",
    "runwayPair",
    "qfu",
    "thresholdSource",
    "displacedThresholdFt",
    "physicalThresholdLat",
    "physicalThresholdLon",
    "operationalThresholdLat",
    "operationalThresholdLon",
    "thresholdElevationFt",
    "terrainElevationFt",
    "deltaFt",
    "projectedLat",
    "projectedLon",
    "bearing",
    "distanceNm"
  ];

  function escapeCsv(value) {
    if (value === null || value === undefined) return "";
    const s = String(value);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const csvRows = [headers.join(",")];
  latestRows.forEach(row => csvRows.push(headers.map(h => escapeCsv(row[h])).join(",")));

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = latestRows[0].airport + "_qfu_delta_elevation.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =========================
   Init
========================= */
function boot() {
  const computeBtn = document.getElementById("computeBtn");
  const csvBtn = document.getElementById("csvBtn");
  const icaoInput = document.getElementById("icao");

  if (!computeBtn) {
    setStatus("Erreur : bouton Compute introuvable dans index.html", "err");
    return;
  }

  computeBtn.addEventListener("click", run);
  if (csvBtn) csvBtn.addEventListener("click", downloadCsv);
  if (icaoInput) {
    icaoInput.addEventListener("keydown", event => {
      if (event.key === "Enter") run();
    });
  }

  initMap();
  setStatus("Application chargée. Clique Compute pour lancer le calcul. Seuils décalés OurAirports pris en compte.", "ok");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
