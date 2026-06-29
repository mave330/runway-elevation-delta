import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Search, Plane, MapPin, AlertTriangle, Loader2, Download, Github, Ruler } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const EARTH_RADIUS_KM = 6371.01;
const RUNWAYS_CSV_URL = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv";
const OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup";

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const λ1 = toRad(lon1);
  const φ2 = toRad(lat2);
  const λ2 = toRad(lon2);
  const dλ = λ2 - λ1;

  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function destinationPoint(lat, lon, brngDeg, distanceKm) {
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const θ = toRad(brngDeg);
  const δ = distanceKm / EARTH_RADIUS_KM;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );

  return { lat: toDeg(φ2), lon: toDeg(λ2) };
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (current.length || row.length) {
        row.push(current);
        rows.push(row);
        row = [];
        current = "";
      }
      if (char === "\r" && next === "\n") i++;
    } else {
      current += char;
    }
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows.map((values) =>
    headers.reduce((obj, header, index) => {
      obj[header] = values[index] ?? "";
      return obj;
    }, {})
  );
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("fr-FR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

async function fetchOpenElevationBatch(points) {
  const locations = points.map((p) => `${p.lat},${p.lon}`).join("|");
  const url = `${OPEN_ELEVATION_URL}?locations=${encodeURIComponent(locations)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Open-Elevation a répondu ${response.status}`);
  }

  const data = await response.json();
  if (!data.results || !Array.isArray(data.results)) {
    throw new Error("Réponse Open-Elevation inattendue");
  }

  return data.results.map((r) => r.elevation * 3.28084);
}

function buildResultsForAirport(rows, airportCode, distanceNm) {
  const distanceKm = distanceNm * 1.852;
  const airportRows = rows.filter((row) => row.airport_ident?.toUpperCase() === airportCode);

  const results = [];

  for (const row of airportRows) {
    const leId = row.le_ident;
    const heId = row.he_ident;
    const leLat = parseNumber(row.le_latitude_deg);
    const leLon = parseNumber(row.le_longitude_deg);
    const heLat = parseNumber(row.he_latitude_deg);
    const heLon = parseNumber(row.he_longitude_deg);
    const leElev = parseNumber(row.le_elevation_ft) ?? 0;
    const heElev = parseNumber(row.he_elevation_ft) ?? 0;

    if (!leId || !heId || leLat === null || leLon === null || heLat === null || heLon === null) {
      continue;
    }

    const leOutboundBearing = bearing(heLat, heLon, leLat, leLon);
    const heOutboundBearing = bearing(leLat, leLon, heLat, heLon);

    const lePoint = destinationPoint(leLat, leLon, leOutboundBearing, distanceKm);
    const hePoint = destinationPoint(heLat, heLon, heOutboundBearing, distanceKm);

    results.push({
      airport: airportCode,
      runwayPair: `${leId}/${heId}`,
      qfu: leId,
      thresholdLat: leLat,
      thresholdLon: leLon,
      thresholdElevationFt: leElev,
      projectedLat: lePoint.lat,
      projectedLon: lePoint.lon,
      outboundBearing: leOutboundBearing,
      terrainElevationFt: null,
      deltaFt: null,
    });

    results.push({
      airport: airportCode,
      runwayPair: `${leId}/${heId}`,
      qfu: heId,
      thresholdLat: heLat,
      thresholdLon: heLon,
      thresholdElevationFt: heElev,
      projectedLat: hePoint.lat,
      projectedLon: hePoint.lon,
      outboundBearing: heOutboundBearing,
      terrainElevationFt: null,
      deltaFt: null,
    });
  }

  return results.sort((a, b) => String(a.qfu).localeCompare(String(b.qfu), "fr", { numeric: true }));
}

function toCsv(rows) {
  const headers = [
    "airport",
    "runwayPair",
    "qfu",
    "thresholdLat",
    "thresholdLon",
    "thresholdElevationFt",
    "projectedLat",
    "projectedLon",
    "distanceNm",
    "outboundBearing",
    "terrainElevationFt",
    "deltaFt",
  ];

  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };

  return [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\n");
}

export default function RunwayElevationDeltaApp() {
  const [airport, setAirport] = useState("LFPG");
  const [distanceNm, setDistanceNm] = useState(3.14);
  const [rows, setRows] = useState([]);
  const [searchedAirport, setSearchedAirport] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [sourceInfo, setSourceInfo] = useState("");

  const stats = useMemo(() => {
    if (!rows.length) return null;
    const deltas = rows.map((r) => r.deltaFt).filter((v) => Number.isFinite(v));
    if (!deltas.length) return null;
    return {
      min: Math.min(...deltas),
      max: Math.max(...deltas),
      average: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    };
  }, [rows]);

  async function analyzeAirport() {
    const code = airport.trim().toUpperCase();
    setError("");
    setRows([]);
    setSearchedAirport(code);

    if (!/^[A-Z0-9]{3,5}$/.test(code)) {
      setError("Saisis un code aéroport valide, par exemple LFPG, LFPO, LFML ou KLAX.");
      return;
    }

    if (!Number.isFinite(Number(distanceNm)) || Number(distanceNm) <= 0) {
      setError("La distance doit être un nombre positif en NM.");
      return;
    }

    setStatus("loading");

    try {
      const runwayResponse = await fetch(RUNWAYS_CSV_URL, { headers: { Accept: "text/csv" } });
      if (!runwayResponse.ok) throw new Error(`OurAirports a répondu ${runwayResponse.status}`);
      const csvText = await runwayResponse.text();
      const runwayRows = parseCsv(csvText);

      const preliminary = buildResultsForAirport(runwayRows, code, Number(distanceNm));

      if (!preliminary.length) {
        setRows([]);
        setError(`Aucune piste exploitable trouvée pour ${code} dans OurAirports.`);
        setStatus("idle");
        return;
      }

      const elevationsFt = await fetchOpenElevationBatch(preliminary.map((r) => ({ lat: r.projectedLat, lon: r.projectedLon })));

      const enriched = preliminary.map((row, index) => {
        const terrainElevationFt = elevationsFt[index];
        return {
          ...row,
          distanceNm: Number(distanceNm),
          terrainElevationFt,
          deltaFt: terrainElevationFt - row.thresholdElevationFt,
        };
      });

      setRows(enriched);
      setSourceInfo(`Runways : OurAirports • Terrain : Open-Elevation • Distance : ${Number(distanceNm).toLocaleString("fr-FR")} NM`);
      setStatus("success");
    } catch (e) {
      setError(e.message || "Erreur inconnue pendant le calcul.");
      setStatus("idle");
    }
  }

  function downloadCsv() {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${searchedAirport || "airport"}_qfu_delta_elevation.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const hasMoreThanFour = rows.length > 4;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mb-8 rounded-[2rem] border border-cyan-400/20 bg-gradient-to-br from-slate-900 via-slate-900 to-cyan-950/60 p-6 shadow-2xl shadow-cyan-950/30"
        >
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1 text-sm text-cyan-100">
                <Plane className="h-4 w-4" />
                Runway elevation delta checker
              </div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
                Delta terrain à 3,14 NM par QFU
              </h1>
              <p className="mt-3 max-w-3xl text-base leading-7 text-slate-300">
                Saisis un code aéroport ICAO. L’application récupère les seuils de piste, projette un point dans l’axe extérieur de chaque QFU, puis compare l’altitude terrain à l’altitude du seuil.
              </p>
            </div>

            <div className="grid w-full gap-3 rounded-3xl border border-white/10 bg-white/5 p-4 backdrop-blur lg:max-w-xl lg:grid-cols-[1fr_0.7fr_auto]">
              <label className="block">
                <span className="mb-1 block text-sm text-slate-300">Code aéroport</span>
                <input
                  value={airport}
                  onChange={(e) => setAirport(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") analyzeAirport();
                  }}
                  placeholder="LFPG"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-lg font-semibold uppercase outline-none ring-cyan-400 transition focus:ring-2"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm text-slate-300">Distance NM</span>
                <input
                  value={distanceNm}
                  onChange={(e) => setDistanceNm(e.target.value)}
                  type="number"
                  step="0.01"
                  min="0.1"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-lg font-semibold outline-none ring-cyan-400 transition focus:ring-2"
                />
              </label>

              <Button
                onClick={analyzeAirport}
                className="mt-6 rounded-2xl bg-cyan-300 px-5 py-6 text-slate-950 hover:bg-cyan-200"
                disabled={status === "loading"}
              >
                {status === "loading" ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Search className="mr-2 h-5 w-5" />}
                Calculer
              </Button>
            </div>
          </div>
        </motion.div>

        {error && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-6 rounded-3xl border border-amber-400/30 bg-amber-400/10 p-4 text-amber-100">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-semibold">Impossible de produire le résultat</p>
                <p className="mt-1 text-sm text-amber-100/90">{error}</p>
              </div>
            </div>
          </motion.div>
        )}

        {rows.length > 0 && (
          <>
            <div className="mb-5 grid gap-4 md:grid-cols-4">
              <Card className="rounded-3xl border-slate-800 bg-slate-900/80 text-slate-100 shadow-xl">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-400">Aéroport</p>
                    <MapPin className="h-5 w-5 text-cyan-300" />
                  </div>
                  <p className="mt-2 text-3xl font-semibold">{searchedAirport}</p>
                  <p className="mt-1 text-sm text-slate-400">{rows.length} QFU détecté(s)</p>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-slate-800 bg-slate-900/80 text-slate-100 shadow-xl">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-400">Delta min</p>
                    <Ruler className="h-5 w-5 text-cyan-300" />
                  </div>
                  <p className="mt-2 text-3xl font-semibold">{formatNumber(stats?.min)} ft</p>
                  <p className="mt-1 text-sm text-slate-400">Terrain - seuil</p>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-slate-800 bg-slate-900/80 text-slate-100 shadow-xl">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-400">Delta moyen</p>
                    <Ruler className="h-5 w-5 text-cyan-300" />
                  </div>
                  <p className="mt-2 text-3xl font-semibold">{formatNumber(stats?.average)} ft</p>
                  <p className="mt-1 text-sm text-slate-400">Sur tous les QFU</p>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-slate-800 bg-slate-900/80 text-slate-100 shadow-xl">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-400">Delta max</p>
                    <Ruler className="h-5 w-5 text-cyan-300" />
                  </div>
                  <p className="mt-2 text-3xl font-semibold">{formatNumber(stats?.max)} ft</p>
                  <p className="mt-1 text-sm text-slate-400">Terrain - seuil</p>
                </CardContent>
              </Card>
            </div>

            <div className="mb-4 flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p>{sourceInfo}</p>
                {hasMoreThanFour && (
                  <p className="mt-1 text-amber-200">
                    Note : cet aéroport a plus de 4 QFU dans la source. Tous les QFU exploitables sont affichés, pas seulement les 4 premiers.
                  </p>
                )}
              </div>
              <Button onClick={downloadCsv} variant="secondary" className="rounded-2xl bg-white text-slate-950 hover:bg-slate-200">
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
            </div>

            <div className="overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-900/80 shadow-2xl">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
                  <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-5 py-4">QFU</th>
                      <th className="px-5 py-4">Piste</th>
                      <th className="px-5 py-4">Seuil ft</th>
                      <th className="px-5 py-4">Terrain point ft</th>
                      <th className="px-5 py-4">Delta ft</th>
                      <th className="px-5 py-4">Point projeté</th>
                      <th className="px-5 py-4">Bearing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {rows.map((row, index) => {
                      const positive = row.deltaFt >= 0;
                      return (
                        <tr key={`${row.qfu}-${index}`} className="transition hover:bg-cyan-300/5">
                          <td className="px-5 py-4">
                            <span className="rounded-2xl bg-cyan-300/10 px-3 py-1 text-lg font-semibold text-cyan-200">{row.qfu}</span>
                          </td>
                          <td className="px-5 py-4 text-slate-300">{row.runwayPair}</td>
                          <td className="px-5 py-4">{formatNumber(row.thresholdElevationFt)} ft</td>
                          <td className="px-5 py-4">{formatNumber(row.terrainElevationFt)} ft</td>
                          <td className="px-5 py-4">
                            <span className={`rounded-2xl px-3 py-1 font-semibold ${positive ? "bg-emerald-400/10 text-emerald-200" : "bg-rose-400/10 text-rose-200"}`}>
                              {positive ? "+" : ""}{formatNumber(row.deltaFt)} ft
                            </span>
                          </td>
                          <td className="px-5 py-4 font-mono text-xs text-slate-300">
                            {row.projectedLat.toFixed(6)}, {row.projectedLon.toFixed(6)}
                          </td>
                          <td className="px-5 py-4">{formatNumber(row.outboundBearing)}°</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        <div className="mt-8 rounded-3xl border border-slate-800 bg-slate-900/70 p-5 text-sm leading-6 text-slate-300">
          <div className="mb-2 flex items-center gap-2 text-slate-100">
            <Github className="h-5 w-5" />
            <p className="font-semibold">Prêt pour GitHub Pages</p>
          </div>
          <p>
            Cette app est statique côté navigateur : aucune clé API n’est nécessaire. Pour un usage opérationnel, vérifier la précision des coordonnées seuils et des altitudes avec une source officielle/AIP ou une base interne validée.
          </p>
        </div>
      </div>
    </div>
  );
}
