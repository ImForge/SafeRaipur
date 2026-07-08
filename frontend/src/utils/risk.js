export const isNight = (dt) => {
  // Raipur runs on IST (UTC+5:30). Compute the hour in IST explicitly so
  // day/night means the CITY's day/night — identical for every viewer and
  // identical to the Python grid classification. Using getHours() (viewer's
  // local clock) caused the sidebar and heatmap to disagree.
  const istHour = (new Date(dt).getUTCHours() + 5.5) % 24;
  return istHour < 6 || istHour >= 19;
};

export const decay = (dt) => {
  const days = (Date.now() - new Date(dt)) / 864e5;
  return Math.exp(-0.00385 * days);
};

export const weight = (inc) => inc.severity * decay(inc.datetime || inc.dt || inc.occurred_at);

export const TYPE_LABEL = {
  sexual_assault: 'Assault', assault: 'Assault', harassment: 'Harassment',
  stalking: 'Stalking', chain_snatching: 'Snatching', theft: 'Theft',
  suspicious: 'Suspicious',
};

export const TYPE_SEV = {
  harassment: 2, stalking: 4, chain_snatching: 3, theft: 2,
  assault: 6, sexual_assault: 10, suspicious: 1,
};

export const scoreColor = (score) =>
  score >= 66 ? '#2DD4BF' : score >= 40 ? '#FFA63D' : '#FF3B5C';

export function computeHotspots(incidents) {
  const by = {};
  incidents.forEach((i) => {
    const key = (i.area || 'Unknown').split(' · ')[0].split(' (')[0];
    if (!by[key]) by[key] = { area: key, n: 0, w: 0, lat: 0, lng: 0, items: [] };
    const w = weight(i);
    by[key].n++;
    by[key].w += w;
    by[key].lat += i.lat;
    by[key].lng += i.lng;
    by[key].items.push(i);
  });
  return Object.values(by)
    .map((h) => ({ ...h, lat: h.lat / h.n, lng: h.lng / h.n, score: Math.min(100, Math.round(h.w * 4)) }))
    .sort((a, b) => b.score - a.score);
}
