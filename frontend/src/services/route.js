/**
 * Safe route — the placeholder becomes real.
 *
 * How it works (all client-side, zero backend):
 *   1. Ask a routing engine for up to 3 ALTERNATIVE routes A → B
 *        primary: OpenRouteService (free key, 2,000 req/day, walking profile)
 *        fallback: public OSRM demo (no key needed, driving profile)
 *   2. Sample each route's polyline roughly every ~120 m
 *   3. Look up each sample point's danger in the SAME risk grid the
 *      heatmap uses (already in memory — no extra network)
 *   4. Sum → per-route risk score. Lowest score = safest route.
 *   5. Map renders safest in teal, alternatives ghosted, with per-route
 *      stats (distance, minutes, relative risk).
 *
 * The result is a *suggestion* ranked by historical data — the UI says so.
 */

const ORS_KEY = import.meta.env.VITE_ORS_API_KEY;

/* ---------- routing engines ---------- */

async function fetchORS(start, end) {
  const res = await fetch(
    'https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
      method: 'POST',
      headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coordinates: [[start.lng, start.lat], [end.lng, end.lat]],
        alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.6 },
      }),
    });
  if (!res.ok) throw new Error(`ORS ${res.status}`);
  const geo = await res.json();
  return geo.features.map(f => ({
    coords: f.geometry.coordinates.map(([lng, lat]) => [lat, lng]), // → leaflet order
    distance_m: f.properties.summary.distance,
    duration_s: f.properties.summary.duration,
  }));
}

async function fetchOSRM(start, end) {
  const url = `https://router.project-osrm.org/route/v1/foot/` +
    `${start.lng},${start.lat};${end.lng},${end.lat}` +
    `?alternatives=3&overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM: no route');
  return data.routes.map(r => ({
    coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance_m: r.distance,
    duration_s: r.duration,
  }));
}

/* ---------- risk scoring against the grid ---------- */

/** Haversine-ish quick distance in degrees is fine at city scale. */
function samplePolyline(coords, everyNth) {
  const out = [];
  for (let i = 0; i < coords.length; i += everyNth) out.push(coords[i]);
  if (out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
  return out;
}

/**
 * cells: [{lat,lng,score 0..1}] — the precomputed grid.
 * We bucket cells into a coarse spatial hash once, then each sample point
 * only checks its own bucket + neighbors. Fast even on phones.
 */
function buildCellIndex(cells) {
  const BUCKET = 0.01; // ~1.1 km buckets
  const idx = new Map();
  for (const c of cells) {
    const key = `${Math.floor(c.lat / BUCKET)}:${Math.floor(c.lng / BUCKET)}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(c);
  }
  return { idx, BUCKET };
}

function riskAt(lat, lng, { idx, BUCKET }) {
  const bi = Math.floor(lat / BUCKET), bj = Math.floor(lng / BUCKET);
  let best = 0;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = idx.get(`${bi + di}:${bj + dj}`);
      if (!bucket) continue;
      for (const c of bucket) {
        // within ~250 m of a grid cell → take the max score nearby
        if (Math.abs(c.lat - lat) < 0.0023 && Math.abs(c.lng - lng) < 0.0023) {
          if (c.score > best) best = c.score;
        }
      }
    }
  }
  return best;
}

/* ---------- public API ---------- */

/**
 * Returns { routes: [...], engine } — routes sorted safest-first, each with:
 *   coords, distance_m, duration_s, risk (0..100), hotspotHits, safest(bool)
 */
export async function planSafeRoute(start, end, riskCells) {
  let routes, engine;
  if (ORS_KEY) {
    try { routes = await fetchORS(start, end); engine = 'ORS · walking'; }
    catch { routes = await fetchOSRM(start, end); engine = 'OSRM · fallback'; }
  } else {
    routes = await fetchOSRM(start, end); engine = 'OSRM';
  }

  const index = buildCellIndex(riskCells || []);
  const scored = routes.map(r => {
    // sample about every 4th vertex (~100–150 m on street geometry)
    const samples = samplePolyline(r.coords, 4);
    let total = 0, hits = 0;
    for (const [lat, lng] of samples) {
      const s = riskAt(lat, lng, index);
      total += s;
      if (s > 0.55) hits++;
    }
    return {
      ...r,
      risk: samples.length ? Math.round((total / samples.length) * 100) : 0,
      hotspotHits: hits,
    };
  });

  scored.sort((a, b) => a.risk - b.risk);
  scored.forEach((r, i) => { r.safest = i === 0; });
  return { routes: scored, engine };
}
