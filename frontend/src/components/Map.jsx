import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet.heat';
import { weight, TYPE_LABEL } from '../utils/risk.js';

const CENTER = [21.2200, 81.6500];

/**
 * Map v2 — layers, bottom → top:
 *   dark CARTO tiles → precomputed risk heat → hotspot corridors →
 *   incident dots → hotspot beacons → SURGE rings → safe-route polylines →
 *   route A/B markers → police stations
 */
export default function MapView({
  incidents, hotspots, riskCells, alerts, stations,
  arming, routeMode, routePts, routePlan,
  onMapClick, focusedLatLng, userCoords, baseLayer, mapView,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layers = useRef({});

  const clear = (name) => {
    if (layers.current[name]) { mapRef.current?.removeLayer(layers.current[name]); layers.current[name] = null; }
  };

  /* ------- init once ------- */
  useEffect(() => {
    if (mapRef.current) return;
    // preferCanvas: circles/polylines draw on ONE canvas instead of hundreds
    // of SVG nodes — meaningfully lighter on phones
    const map = L.map(containerRef.current, { center: CENTER, zoom: 12, zoomControl: false, preferCanvas: true });
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // two base styles, swapped by the baseLayer PROP (React button in App —
    // a plain Leaflet control proved unreliable, so the toggle now lives in
    // React where we can see and style it like every other working button)
    const dark = L.layerGroup([
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
        { subdomains: 'abcd', maxZoom: 19, attribution: '© OSM · CARTO' }),
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
        { subdomains: 'abcd', maxZoom: 19, opacity: .5 }),
    ]).addTo(map);
    const sat = L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Imagery © Esri' }),
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
        { subdomains: 'abcd', maxZoom: 19, opacity: .8 }),
    ]);
    layers.current.baseDark = dark;
    layers.current.baseSat = sat;

    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  /* ------- base layer swap (dark <-> satellite) ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layers.current.baseDark) return;
    const { baseDark, baseSat } = layers.current;
    if (baseLayer === 'sat') {
      map.removeLayer(baseDark);
      baseSat.addTo(map);
    } else {
      map.removeLayer(baseSat);
      baseDark.addTo(map);
    }
  }, [baseLayer]);

  /* ------- click handler (report arming / route picking) ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e) => onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    map.on('click', handler);
    return () => map.off('click', handler);
  }, [onMapClick]);

  /* ------- police stations (re-render if list changes) ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    clear('stations');
    layers.current.stations = L.layerGroup().addTo(map);
    (stations || []).forEach(s => {
      L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: `<img src="/station.png" class="station-img" onerror="this.outerHTML='<div class=\'station-dot\'></div>'" alt=""/>`, iconSize: [22, 22] }) })
        .bindPopup(`<div class="pv-area">🛡 ${s.name} Police Station</div><div class="pv-meta">${s.phone ? s.phone : 'Patrol unit · Active'}</div>`)
        .addTo(layers.current.stations);
    });
  }, [stations]);

  /* ------- heat: precomputed risk grid; fallback = weighted incidents ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    clear('heat');
    // Only render cells that carry real signal. Weak cells (score < .12)
    // previously painted the whole city — the "everything glows" soup.
    // Dark map = calm; color = actual concentration. Signal over noise.
    // The sweet spot between v2.4 (soup: minOpacity .35 painted every cell)
    // and v2.6 (barren: threshold .12 drained the map). Keep a low floor so
    // the city has ATMOSPHERE, boost each cell's intensity so hotspots BLOOM,
    // and let opacity truly reach zero between them.
    const pts = (riskCells && riskCells.length > 0)
      ? riskCells.filter(c => c.score >= 0.05)
          .map(c => [c.lat, c.lng, Math.min(1, c.score * 1.25)])
      : incidents.map(i => [i.lat, i.lng, weight(i) / 10]);         // fallback pre-ingest
    const mobile = window.matchMedia('(pointer: coarse)').matches;
    layers.current.heat = L.heatLayer(pts, {
      radius: mobile ? 30 : 36, blur: mobile ? 22 : 26,
      minOpacity: 0, maxZoom: 17, max: 1,
      gradient: {
        0: 'rgba(45,212,191,0)', .22: 'rgba(45,212,191,.4)',
        .45: 'rgba(255,166,61,.62)', .65: 'rgba(255,59,92,.78)',
        .85: 'rgba(255,59,92,.92)', 1: 'rgba(255,90,120,1)',
      },
    }).addTo(map);
  }, [riskCells, incidents, mapView]);

  /* ------- incident dots + corridors + beacons ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    ['dots', 'beacons'].forEach(clear);
    const showDots = mapView === 'live';
    const showBeacons = mapView !== 'heat';

    layers.current.dots = L.layerGroup().addTo(map);
    if (showDots) incidents.forEach(i => {
      const sev = i.severity || 1;
      const isLive = i.source === 'crowd';
      const col = sev >= 8 ? '#FF3B5C' : sev >= 5 ? '#FF6178' : sev >= 3 ? '#FFA63D' : '#7E8AA0';
      const sz = sev >= 8 ? 11 : sev >= 5 ? 9 : 7;
      const when = new Date(i.occurred_at || i.dt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      L.marker([i.lat, i.lng], {
        icon: L.divIcon({
          className: '', iconSize: [sz, sz],
          html: `<div class="incident-dot ${isLive ? 'live-dot-anim' : ''}" style="width:${sz}px;height:${sz}px;background:${col};color:${col};"></div>`
        })
      })
        .bindPopup(`<span class="pv-type">▲ ${TYPE_LABEL[i.type] || i.type}</span>
          <div class="pv-area">${i.area || (isLive ? 'Community report' : 'Unknown')}</div>
          ${i.title ? `<div class="pv-meta" style="max-width:230px">${i.title}</div>` : ''}
          <div class="pv-meta">${when}<br>Source: ${i.source === 'news' ? 'News-verified' : i.is_verified ? 'Community · Verified ✓' : 'Community · Unverified'} · Sev ${sev}/10</div>
          ${i.source_url ? `<a class="pv-src" href="${i.source_url}" target="_blank" rel="noopener noreferrer">Read source article ↗</a>` : ''}
          ${isLive && !i.is_verified ? `
            <div class="pv-vote">
              <span class="pv-counts">${i.confirms || 0} confirm${(i.confirms||0)===1?'':'s'}${i.flags ? ` · ${i.flags} flagged` : ''}</span>
              <div class="pv-vote-btns">
                <button class="pv-yes" onclick="window.__srVote(${i.id},'confirm')">✓ I can confirm</button>
                <button class="pv-no" onclick="window.__srVote(${i.id},'fake')">Report fake</button>
              </div>
            </div>` : ''}
          <div class="pv-bar"><i style="width:${sev * 10}%;background:${col};box-shadow:0 0 8px ${col};"></i></div>`,
          { closeButton: false })
        .on('mouseover', function () { this.openPopup(); })
        .addTo(layers.current.dots);
    });

    layers.current.beacons = L.layerGroup().addTo(map);
    if (showBeacons) hotspots.slice(0, 5).forEach(h => {
      const col = h.score >= 60 ? '#FF3B5C' : h.score >= 30 ? '#FFA63D' : '#2DD4BF';
      L.marker([h.lat, h.lng], {
        icon: L.divIcon({
          className: '', iconSize: [0, 0],
          html: `<div class="beacon" style="color:${col};"><div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="core"></div></div>`
        }), zIndexOffset: 500
      })
        .bindPopup(`<div class="pv-type" style="background:${col}28;color:${col};">◉ Hotspot</div>
          <div class="pv-area">${h.area}</div>
          <div class="pv-meta">${h.n} incidents · score ${h.score}/100</div>
          <div class="pv-bar"><i style="width:${h.score}%;background:${col};box-shadow:0 0 8px ${col};"></i></div>`,
          { closeButton: false })
        .bindTooltip(h.area, { permanent: true, direction: 'right', offset: [14, 0], className: 'hs-label' })
        .addTo(layers.current.beacons);
    });
  }, [incidents, hotspots, mapView]);

  /* ------- SURGE rings — the live "something is happening HERE" layer ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    clear('surges');
    layers.current.surges = L.layerGroup().addTo(map);
    (alerts || []).forEach(a => {
      L.circle([a.lat, a.lng], {
        radius: a.radius_m || 500, color: '#FF3B5C', weight: 2,
        fillColor: '#FF3B5C', fillOpacity: 0.10, className: 'surge-circle',
      }).addTo(layers.current.surges);
      L.marker([a.lat, a.lng], {
        icon: L.divIcon({
          className: '', iconSize: [0, 0],
          html: `<div class="surge-marker"><div class="sring"></div><div class="sring"></div><div class="score">${a.report_count}</div></div>`
        }), zIndexOffset: 900
      })
        .bindPopup(`<div class="pv-type" style="background:#FF3B5C28;color:#FF3B5C;">⚠ SURGE</div>
          <div class="pv-area">${a.area || 'Cluster detected'}</div>
          <div class="pv-meta">${a.report_count} incidents in ~${a.window_hours || 6}h · max severity ${a.max_severity}/10<br>Auto-detected · expires ${new Date(a.expires_at).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</div>`,
          { closeButton: false })
        .addTo(layers.current.surges);
    });
  }, [alerts]);

  /* ------- safe route: real alternatives, safest highlighted ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    clear('route');
    layers.current.route = L.layerGroup().addTo(map);

    // A/B pick markers while choosing
    const putPin = (p, label, col) => L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: '', iconSize: [22, 22],
        html: `<div class="route-pin" style="border-color:${col};box-shadow:0 0 14px ${col};">${label}</div>`
      }), zIndexOffset: 1000
    }).addTo(layers.current.route);

    if (routePts?.start) putPin(routePts.start, 'A', '#fff');
    if (routePts?.end) putPin(routePts.end, 'B', '#2DD4BF');

    if (!routePlan) return;

    // alternatives first (ghosted), safest last (on top)
    [...routePlan.routes].reverse().forEach(r => {
      const col = r.safest ? '#2DD4BF' : '#7E8AA0';
      L.polyline(r.coords, { color: col, weight: r.safest ? 14 : 8, opacity: r.safest ? .12 : .06 }).addTo(layers.current.route);
      L.polyline(r.coords, {
        color: col, weight: r.safest ? 5 : 3,
        opacity: r.safest ? .95 : .45,
        dashArray: r.safest ? null : '6 8',
        className: r.safest ? 'route-path' : '',
      })
        .bindPopup(`<div class="pv-type" style="background:${col}28;color:${col};">${r.safest ? '✓ Safest route' : 'Alternative'}</div>
          <div class="pv-meta">${(r.distance_m / 1000).toFixed(2)} km · ${Math.round(r.duration_s / 60)} min<br>Risk exposure ${r.risk}/100 · passes ${r.hotspotHits} hot zones</div>`)
        .addTo(layers.current.route);
    });

    const best = routePlan.routes[0];
    map.flyToBounds(L.latLngBounds(best.coords).pad(0.25), { duration: 1.1 });
  }, [routePts, routePlan]);

  /* ------- user location pin (blue, pulsing) ------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    clear('user');
    if (!userCoords) return;
    layers.current.user = L.layerGroup().addTo(map);
    L.marker([userCoords.lat, userCoords.lng], {
      icon: L.divIcon({
        className: '', iconSize: [0, 0],
        html: `<div class="user-loc"><div class="ul-pulse"></div><div class="ul-dot"></div></div>`,
      }), zIndexOffset: 1100,
    }).bindPopup('<div class="pv-area">You are here</div><div class="pv-meta">Location stays on your device</div>')
      .addTo(layers.current.user);
  }, [userCoords]);

  /* ------- fly to focus ------- */
  useEffect(() => {
    if (focusedLatLng && mapRef.current)
      mapRef.current.flyTo([focusedLatLng.lat, focusedLatLng.lng], 15, { duration: 1.3 });
  }, [focusedLatLng]);

  return <div ref={containerRef} id="map" />;
}
