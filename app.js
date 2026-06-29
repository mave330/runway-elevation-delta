const R = 6371.01;

const RUNWAYS_CSV_URL =
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv";

const OPEN_ELEVATION_URL =
  "https://api.open-elevation.com/api/v1/lookup";

let latestRows = [];

function setStatus(message, type) {
  const el = document.getElementById("status");
  el.className = "status " + (type || "");
  el.textContent = message;
}

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

function createCell(text, className) {
  const td = document.createElement("td");

  if (className) {
    td.className = className;
  }

  td.textContent = text;
  return td;
}

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

    tr.appendChild(
      createCell(deltaSign + fmt(r.deltaFt) + " ft", deltaClass)
    );
  } else {
    tr.appendChild(createCell("Erreur API"));
    tr.appendChild(createCell("—"));
  }

  tr.appendChild(
    createCell(r.projectedLat.toFixed(6) + ", " + r.projectedLon.toFixed(6))
  );

  tr.appendChild(createCell(fmt(r.bearing, 1) + "°"));

  tbody.appendChild(tr);
}

async function run() {
  const btn = document.getElementById("computeBtn");
  const tbody = document.getElementById("tbody");

  const icao = document.getElementById("icao").value.trim().toUpperCase();
  const distanceNm = parseFloat(document.getElementById("dist").value);
  const dKm = distanceNm * 1.852;

  latestRows = [];
  tbody.innerHTML = "";

  document.getElementById("summary").classList.add("hidden");
  document.getElementById("actions").classList.add("hidden");

  if (!icao || !/^[A-Z0-9]{3,5}$/.test(icao)) {
    setStatus("Code aéroport invalide. Exemple : LFPG, LFPO, LFML, KLAX.", "err");
    return;
  }

  if (!Number.isFinite(distanceNm) || distanceNm <= 0) {
    setStatus("Distance invalide. Saisis une distance positive en NM.", "err");
    return;
  }

  btn.disabled = true;

  setStatus(
    "Téléchargement automatique du fichier runways.csv depuis OurAirports pour " +
    icao +
    "...",
    ""
  );

  try {
    const response = await fetch(RUNWAYS_CSV_URL);

    if (!response.ok) {
      throw new Error("Impossible de télécharger runways.csv");
    }

    const csvText = await response.text();

    setStatus("Fichier téléchargé. Analyse des pistes...", "");

    const data = parseCSV(csvText);

    const airportRows = data.filter(function(row) {
      return (
        row.airport_ident &&
        row.airport_ident.trim().toUpperCase() === icao
      );
    });

    if (!airportRows.length) {
      setStatus(
        "Aucune piste trouvée pour " +
        icao +
        " dans OurAirports. Vérifie le code ICAO.",
        "warn"
      );
      return;
    }

    const points = [];

    airportRows.forEach(function(row) {
      const le = row.le_ident;
      const he = row.he_ident;

      const leLat = n(row.le_latitude_deg);
      const leLon = n(row.le_longitude_deg);
      const heLat = n(row.he_latitude_deg);
      const heLon = n(row.he_longitude_deg);

      const leElevRaw = n(row.le_elevation_ft);
      const heElevRaw = n(row.he_elevation_ft);

      const leElev = leElevRaw === null ? 0 : leElevRaw;
      const heElev = heElevRaw === null ? 0 : heElevRaw;

      if (
        !le ||
        !he ||
        leLat === null ||
        leLon === null ||
        heLat === null ||
        heLon === null
      ) {
        return;
      }

      const brngLe = bearing(heLat, heLon, leLat, leLon);
      const pLe = getPoint(leLat, leLon, brngLe, dKm);

      points.push({
        airport: icao,
        runwayPair: le + "/" + he,
        qfu: le,
        thresholdElevationFt: leElev,
        projectedLat: pLe.lat,
        projectedLon: pLe.lon,
        bearing: brngLe,
        distanceNm: distanceNm
      });

      const brngHe = bearing(leLat, leLon, heLat, heLon);
      const pHe = getPoint(heLat, heLon, brngHe, dKm);

      points.push({
        airport: icao,
        runwayPair: le + "/" + he,
        qfu: he,
        thresholdElevationFt: heElev,
        projectedLat: pHe.lat,
        projectedLon: pHe.lon,
        bearing: brngHe,
        distanceNm: distanceNm
      });
    });

    if (!points.length) {
      setStatus(
        "Des pistes existent pour " +
        icao +
        ", mais les coordonnées seuils sont incomplètes dans OurAirports.",
        "warn"
      );
      return;
    }

    points.sort(function(a, b) {
      return String(a.qfu).localeCompare(String(b.qfu), "fr", {
        numeric: true
      });
    });

    setStatus(
      points.length +
      " QFU trouvés. Récupération des altitudes terrain...",
      ""
    );

    for (let i = 0; i < points.length; i++) {
      const r = points[i];

      setStatus(
        "Calcul " +
        (i + 1) +
        "/" +
        points.length +
        " : QFU " +
        r.qfu +
        "...",
        ""
      );

      try {
        const terrainFt = await getElevationFt(
          r.projectedLat,
          r.projectedLon
        );

        const deltaFt = terrainFt - r.thresholdElevationFt;

        r.terrainElevationFt = terrainFt;
        r.deltaFt = deltaFt;
      } catch (elevError) {
        r.terrainElevationFt = null;
        r.deltaFt = null;
      }

      latestRows.push(r);
      addResultRow(r);

      await delay(300);
    }

    updateSummary(icao);

    document.getElementById("actions").classList.remove("hidden");

    setStatus(
      "Compute done : " +
      latestRows.length +
      " QFU affichés pour " +
      icao +
      ".",
      "ok"
    );
  } catch (err) {
    setStatus("Erreur : " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function updateSummary(icao) {
  const deltas = latestRows
    .map(function(r) {
      return r.deltaFt;
    })
    .filter(function(v) {
      return Number.isFinite(v);
    });

  document.getElementById("summary").classList.remove("hidden");
  document.getElementById("sumAirport").textContent = icao;
  document.getElementById("sumQfu").textContent = latestRows.length;

  if (deltas.length) {
    document.getElementById("sumMin").textContent =
      fmt(Math.min.apply(null, deltas)) + " ft";

    document.getElementById("sumMax").textContent =
      fmt(Math.max.apply(null, deltas)) + " ft";
  } else {
    document.getElementById("sumMin").textContent = "—";
    document.getElementById("sumMax").textContent = "—";
  }
}

function downloadCsv() {
  if (!latestRows.length) {
    return;
  }

  const headers = [
    "airport",
    "runwayPair",
    "qfu",
    "thresholdElevationFt",
    "terrainElevationFt",
    "deltaFt",
    "projectedLat",
    "projectedLon",
    "bearing",
    "distanceNm"
  ];

  function escapeCsv(value) {
    if (value === null || value === undefined) {
      return "";
    }

    const s = String(value);

    if (/[",\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }

    return s;
  }

  const csvRows = [headers.join(",")];

  latestRows.forEach(function(row) {
    csvRows.push(
      headers.map(function(h) {
        return escapeCsv(row[h]);
      }).join(",")
    );
  });

  const csv = csvRows.join("\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = latestRows[0].airport + "_qfu_delta_elevation.csv";

  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

document.addEventListener("DOMContentLoaded", function() {
  const computeBtn = document.getElementById("computeBtn");
  const csvBtn = document.getElementById("csvBtn");
  const icaoInput = document.getElementById("icao");

  if (computeBtn) {
    computeBtn.addEventListener("click", run);
  }

  if (csvBtn) {
    csvBtn.addEventListener("click", downloadCsv);
  }

  if (icaoInput) {
    icaoInput.addEventListener("keydown", function(event) {
      if (event.key === "Enter") {
        run();
      }
    });
  }

  setStatus("Application chargée. Clique Compute pour lancer le calcul.", "ok");
});
