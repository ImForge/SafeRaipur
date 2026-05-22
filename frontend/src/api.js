/**
 * API client. Talks to the FastAPI backend through the Vite proxy
 * (/api → http://localhost:8000) so we don't deal with CORS in dev.
 */

const BASE = import.meta.env.VITE_API_BASE_URL
  ? import.meta.env.VITE_API_BASE_URL + '/api'
  : '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err}`);
  }
  return res.json();
}

export const api = {
  listIncidents: ({ timeOfDay, bbox } = {}) => {
    const params = new URLSearchParams();
    if (timeOfDay) params.set('time_of_day', timeOfDay);
    if (bbox) {
      params.set('min_lat', bbox[0]); params.set('min_lng', bbox[1]);
      params.set('max_lat', bbox[2]); params.set('max_lng', bbox[3]);
    }
    return request(`/incidents?${params}`);
  },
  getHotspots: ({ timeOfDay = 'night', limit = 10 } = {}) =>
    request(`/hotspots?time_of_day=${timeOfDay}&limit=${limit}`),
  getRiskGrid: ({ timeOfDay = 'night', bbox, resolution = 50 } = {}) => {
    const params = new URLSearchParams({ time_of_day: timeOfDay, resolution });
    if (bbox) {
      params.set('min_lat', bbox[0]); params.set('min_lng', bbox[1]);
      params.set('max_lat', bbox[2]); params.set('max_lng', bbox[3]);
    }
    return request(`/risk-grid?${params}`);
  },
  submitReport: (report) =>
    request('/reports', { method: 'POST', body: JSON.stringify(report) }),
};

/** Generate a stable but anonymous per-device id (hashed in real apps). */
export function getAnonymousId() {
  let id = localStorage.getItem('rsm_anon_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('rsm_anon_id', id);
  }
  return id;
}