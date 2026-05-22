import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet.heat';
import { weight, TYPE_LABEL } from '../utils/risk.js';

const CENTER = [21.2200, 81.6500];
const STATIONS = [
  { name:'Telibandha', lat:21.2362, lng:81.6498 },
  { name:'Civil Lines', lat:21.2587, lng:81.6378 },
  { name:'Kotwali', lat:21.2371, lng:81.6358 },
  { name:'Gol Bazar', lat:21.2390, lng:81.6432 },
  { name:'Tikrapara', lat:21.2538, lng:81.6234 },
  { name:'Pandri', lat:21.2467, lng:81.6442 },
  { name:'Mowa', lat:21.2790, lng:81.6815 },
  { name:'Gudhiyari', lat:21.2364, lng:81.6111 },
  { name:'Ganj', lat:21.2415, lng:81.6450 },
  { name:'Mandir Hasaud', lat:21.2156, lng:81.7372 },
  { name:'Khamhardih', lat:21.2533, lng:81.6759 },
  { name:'Devendra Nagar', lat:21.2473, lng:81.6557 },
  { name:'New Raipur (Atal Nagar)', lat:21.1400, lng:81.7300 },
  { name:'Devpuri', lat:21.2170, lng:81.5870 },
  { name:'Tatibandh', lat:21.2850, lng:81.6490 },
  { name:'Urla', lat:21.2720, lng:81.5760 },
  { name:'Birgaon', lat:21.2900, lng:81.7100 },
  { name:'Pachpedi Naka', lat:21.2180, lng:81.6180 },
  { name:'Bhanpuri', lat:21.3050, lng:81.6500 },
  { name:'Sarona', lat:21.2100, lng:81.7100 },
];

export default function MapView({ incidents, hotspots, arming, onMapClick, focusedLatLng, routeShown }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const heatRef = useRef(null);
  const dotsRef = useRef(null);
  const beaconRef = useRef(null);
  const corridorRef = useRef(null);
  const routeRef = useRef(null);

  // init map once
  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(containerRef.current, { center: CENTER, zoom: 12, zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
      { subdomains:'abcd', maxZoom:19, attribution:'© OSM · CARTO' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      { subdomains:'abcd', maxZoom:19, opacity:.5 }).addTo(map);

    // police stations
    STATIONS.forEach(s => {
      L.marker([s.lat, s.lng], { icon: L.divIcon({
        className:'', html:'<div class="station-dot"></div>', iconSize:[11,11]
      })}).bindPopup(`<div class="pv-area">🛡 ${s.name} Police Station</div>
        <div class="pv-meta">Patrol unit · Active</div>`).addTo(map);
    });

    map.on('click', e => onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng }));
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // re-register click handler whenever onMapClick changes (arming state)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e) => onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    map.on('click', handler);
    return () => map.off('click', handler);
  }, [onMapClick]);

  // re-render layers when data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    [heatRef, dotsRef, beaconRef, corridorRef].forEach(r => { if (r.current) { map.removeLayer(r.current); r.current = null; } });

    const pts = incidents.map(i => [i.lat, i.lng, weight(i)]);
    heatRef.current = L.heatLayer(pts, {
      radius:38, blur:30, minOpacity:.35, maxZoom:17,
      gradient:{0:'rgba(45,212,191,0)',.25:'rgba(45,212,191,.55)',.45:'rgba(255,166,61,.7)',
        .65:'rgba(255,59,92,.82)',.85:'rgba(255,59,92,.95)',1:'rgba(255,90,120,1)'},
    }).addTo(map);

    // corridors between hotspots
    corridorRef.current = L.layerGroup().addTo(map);
    hotspots.slice(0, 4).forEach((a, k) => {
      const b = hotspots[k+1];
      if (!b) return;
      const risk = (a.score + b.score) / 2;
      const col = risk > 55 ? '#FF3B5C' : risk > 30 ? '#FFA63D' : '#2DD4BF';
      L.polyline([[a.lat,a.lng],[b.lat,b.lng]], { color:col, weight:2.5, opacity:.65, className:'corridor' })
        .addTo(corridorRef.current);
    });

    // incident dots
    dotsRef.current = L.layerGroup().addTo(map);
    incidents.forEach(i => {
      const sev = i.severity || i.sev;
      const col = sev>=8?'#FF3B5C':sev>=5?'#FF6178':sev>=3?'#FFA63D':'#7E8AA0';
      const sz = sev>=8?11:sev>=5?9:7;
      const when = new Date(i.occurred_at||i.dt).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'});
      L.marker([i.lat,i.lng], { icon: L.divIcon({
        className:'', iconSize:[sz,sz],
        html:`<div class="incident-dot" style="width:${sz}px;height:${sz}px;background:${col};color:${col};"></div>`
      })})
        .bindPopup(`<span class="pv-type">▲ ${TYPE_LABEL[i.type]||i.type}</span>
          <div class="pv-area">${i.area||'Unknown'}</div>
          <div class="pv-meta">${when}<br>Source: ${i.source==='news'?'Verified':'Community'} · Sev ${sev}/10</div>
          <div class="pv-bar"><i style="width:${sev*10}%;background:${col};box-shadow:0 0 8px ${col};"></i></div>`,
          { closeButton:false })
        .on('mouseover', function(){ this.openPopup(); })
        .addTo(dotsRef.current);
    });

    // beacons on top 5 hotspots
    beaconRef.current = L.layerGroup().addTo(map);
    hotspots.slice(0,5).forEach(h => {
      const col = h.score>=60?'#FF3B5C':h.score>=30?'#FFA63D':'#2DD4BF';
      L.marker([h.lat,h.lng], { icon: L.divIcon({
        className:'', iconSize:[0,0],
        html:`<div class="beacon" style="color:${col};">
          <div class="ring"></div><div class="ring"></div><div class="ring"></div>
          <div class="core"></div></div>`
      }), zIndexOffset:500 })
        .bindPopup(`<div class="pv-type" style="background:${col}28;color:${col};">◉ Hotspot</div>
          <div class="pv-area">${h.area}</div>
          <div class="pv-meta">${h.n||h.incident_count} incidents · score ${h.score}/100</div>
          <div class="pv-bar"><i style="width:${h.score}%;background:${col};box-shadow:0 0 8px ${col};"></i></div>`,
          { closeButton:false })
        .addTo(beaconRef.current);
    });
  }, [incidents, hotspots]);

  // safe route
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (routeRef.current) { map.removeLayer(routeRef.current); routeRef.current = null; }
    if (!routeShown) return;
    const path = [[21.2467,81.6442],[21.2510,81.6400],[21.2548,81.6388],[21.2587,81.6378]];
    routeRef.current = L.layerGroup().addTo(map);
    L.polyline(path, { color:'#2DD4BF', weight:5, opacity:.9, className:'route-path' }).addTo(routeRef.current);
    L.polyline(path, { color:'#2DD4BF', weight:14, opacity:.12 }).addTo(routeRef.current);
    [path[0], path[path.length-1]].forEach((p, idx) => {
      L.marker(p, { icon: L.divIcon({ className:'', iconSize:[16,16],
        html:`<div style="width:16px;height:16px;border-radius:50%;
          background:${idx?'#2DD4BF':'#fff'};border:3px solid #2DD4BF;
          box-shadow:0 0 14px #2DD4BF;"></div>`
      })}).addTo(routeRef.current);
    });
    map.flyToBounds(L.latLngBounds(path).pad(0.4), { duration:1.2 });
  }, [routeShown]);

  // fly to focused hotspot
  useEffect(() => {
    if (focusedLatLng && mapRef.current)
      mapRef.current.flyTo([focusedLatLng.lat, focusedLatLng.lng], 16, { duration:1.3 });
  }, [focusedLatLng]);

  return <div ref={containerRef} id="map" />;
}