/**
 * Geo helpers — the honest math behind "nearest station" and "response estimate".
 */

/**
 * Haversine distance between two lat/lng points, in metres.
 *
 * WHY THIS EXISTS: latitude/longitude are angles on a sphere, so you can't
 * just subtract them to get distance. Haversine is the standard formula for
 * "great-circle" distance — the real ground distance between two coordinates
 * accounting for the Earth's curvature. Accurate to a few metres at city scale.
 */
export function haversineMeters(a, b) {
  const R = 6371000; // Earth radius in metres
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Format metres → human string: "820 m" or "2.4 km". */
export function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Rank police stations by straight-line distance from a point.
 * Returns a new array sorted nearest-first, each with a `distance_m` field.
 * (Straight-line is instant and needs no API. The actual road route/time is
 *  fetched only when the user picks a station — see App's routing flow.)
 */
export function stationsByDistance(from, stations) {
  return stations
    .map((s) => ({ ...s, distance_m: haversineMeters(from, { lat: s.lat, lng: s.lng }) }))
    .sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * HONEST response-time estimate.
 *
 * We can truthfully estimate the DRIVING TIME from the nearest station to a
 * point, using a rough urban speed. This is NOT a guaranteed police response
 * time — real response also includes call handling, dispatch, unit
 * availability, and live traffic, none of which we can know. The UI must
 * label this as "drive time from nearest station", not "response time".
 *
 * avgSpeedKmh 22 ≈ typical Raipur mixed city traffic. When we have a real
 * routed duration from ORS/OSRM we prefer that; this is the offline fallback.
 */
export function estimateDriveMinutes(distanceMeters, avgSpeedKmh = 22) {
  const hours = distanceMeters / 1000 / avgSpeedKmh;
  return Math.max(1, Math.round(hours * 60));
}

/**
 * "Open in Google Maps" deep link for a route.
 *
 * HONESTY NOTE: Google routes with its own engine — it won't follow our
 * exact safe path. To nudge it, we sample up to 4 intermediate points from
 * OUR safest route and pass them as waypoints, so Google's navigation
 * approximately traces the safe corridor. Real turn-by-turn (voice, GPS
 * follow, rerouting) is Google's superpower; picking WHICH corridor is ours.
 * This button combines both.
 */
export function gmapsUrl(start, end, routeCoords) {
  const wp = [];
  if (routeCoords && routeCoords.length > 12) {
    const step = Math.floor(routeCoords.length / 5);
    for (let i = step; i < routeCoords.length - step && wp.length < 4; i += step) {
      wp.push(`${routeCoords[i][0].toFixed(5)},${routeCoords[i][1].toFixed(5)}`);
    }
  }
  return (
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${start.lat},${start.lng}` +
    `&destination=${end.lat},${end.lng}` +
    `&travelmode=walking` +
    (wp.length ? `&waypoints=${encodeURIComponent(wp.join('|'))}` : '')
  );
}
