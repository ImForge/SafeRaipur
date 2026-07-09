import { useState, useEffect, useCallback, useRef } from 'react';
import { api, getAnonymousId } from './api.js';
import { supabaseConfigured } from './lib/supabase.js';
import { useRealtime } from './hooks/useRealtime.js';
import { useGeolocation } from './hooks/useGeolocation.js';
import { planSafeRoute } from './services/route.js';
import { stationsByDistance } from './utils/geo.js';
import { computeHotspots, isNight } from './utils/risk.js';
import TopBar from './components/TopBar.jsx';
import LeftSidebar from './components/LeftSidebar.jsx';
import RightSidebar from './components/RightSidebar.jsx';
import MapView from './components/Map.jsx';
import Dock from './components/Dock.jsx';
import ReportModal from './components/ReportModal.jsx';
import Legend from './components/Legend.jsx';
import Welcome from './components/Welcome.jsx';

/**
 * SafeRaipur v2 — app shell.
 *
 * Data flow:
 *   load     → incidents + reports + precomputed risk grid + alerts + stations
 *   realtime → new reports / surge alerts pushed over websocket, no polling
 *   report   → map click (armed) → modal → submit_report RPC
 *   route    → click "Plot safest route" → pick A on map → pick B →
 *              ORS/OSRM alternatives scored against the risk grid
 */
export default function App() {
  const [timeOfDay, setTimeOfDay] = useState('night');
  const [activeCat, setActiveCat] = useState('all');

  const [incidents, setIncidents] = useState([]);   // news/seed
  const [reports, setReports] = useState([]);       // community
  const [riskCells, setRiskCells] = useState([]);   // precomputed grid
  const [alerts, setAlerts] = useState([]);         // active surges
  const [stations, setStations] = useState([]);

  const [arming, setArming] = useState(false);
  const [pendingLatLng, setPendingLatLng] = useState(null);
  const [focusedLatLng, setFocusedLatLng] = useState(null);

  // route state machine: idle | pick-start | pick-end | loading | shown
  const [routeMode, setRouteMode] = useState('idle');
  const [routePts, setRoutePts] = useState({ start: null, end: null });
  const [routePlan, setRoutePlan] = useState(null);

  // user location — opt-in, stays on device (see useGeolocation notes)
  const geo = useGeolocation();

  // map base style: 'dark' (ops view) | 'sat' (satellite imagery)
  const [baseLayer, setBaseLayer] = useState('dark');
  // map content mode: live (everything) | heat (heat only) | clusters (hotspots only)
  const [mapView, setMapView] = useState('live');
  // time window over the data: 7d | 30d | all
  const [timeRange, setTimeRange] = useState('all');
  // desktop panel visibility (nav rail controls these; mobile ignores them)
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);

  const [toast, setToast] = useState(null);
  const [nudge, setNudge] = useState(false);
  const toastTimer = useRef(null);
  const riskCellsRef = useRef([]);
  riskCellsRef.current = riskCells;

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  /* ---------------- initial + timeOfDay-dependent loads ---------------- */
  const refresh = useCallback(async () => {
    if (!supabaseConfigured) return;
    try {
      const [inc, rep, cells, al, st] = await Promise.all([
        api.listIncidents(), api.listReports(),
        api.getRiskCells(timeOfDay), api.listAlerts(), api.listStations(),
      ]);
      setIncidents(inc.map(i => ({ ...i, dt: i.occurred_at, source: i.source || 'news' })));
      setReports(rep.map(r => ({ ...r, dt: r.occurred_at, source: 'crowd', type: r.type })));
      setRiskCells(cells);
      setAlerts(al);
      setStations(st);
    } catch (e) {
      console.error('load failed', e);
      showToast('Could not reach the database — check your connection');
    }
  }, [timeOfDay, showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  /* ---------------- realtime: live reports + surge alerts ---------------- */
  const onNewReport = useCallback((row) => {
    setReports(prev => [{ ...row, dt: row.occurred_at, source: 'crowd' }, ...prev]);
    showToast(`Live: new community report${row.area ? ' near ' + row.area : ''}`);
  }, [showToast]);

  const onNewAlert = useCallback((row) => {
    setAlerts(prev => [row, ...prev]);
    showToast(`⚠ Surge detected${row.area ? ' near ' + row.area : ''} — ${row.report_count} incidents`);
  }, [showToast]);

  useRealtime({ onNewReport, onNewAlert });

  // gentle feature nudge ~20s in: remind people the safe-route exists
  useEffect(() => {
    const id = setTimeout(() => setNudge(true), 20000);
    return () => clearTimeout(id);
  }, []);

  // Leaflet popups are raw HTML (outside React), so their Confirm/Fake
  // buttons call this global hook. Set once; cleans up on unmount.
  useEffect(() => {
    window.__srVote = async (id, kind) => {
      try {
        await api.voteReport(id, kind, getAnonymousId());
        showToast(kind === 'confirm'
          ? 'Thanks — confirmation logged. 3 confirms auto-verifies a report.'
          : 'Flag logged. Repeated flags hide a report pending review.');
        refresh();
      } catch (e) { showToast(e.message || 'Vote failed'); }
    };
    return () => { delete window.__srVote; };
  }, [showToast, refresh]);

  /* ---------------- map click: report arming OR route picking ------------ */
  const handleMapClick = useCallback((latlng) => {
    if (arming) { setPendingLatLng(latlng); return; }
    if (routeMode === 'pick-start') {
      setRoutePts({ start: latlng, end: null });
      setRouteMode('pick-end');
      return;
    }
    if (routeMode === 'pick-end') {
      setRoutePts(p => ({ ...p, end: latlng }));
      setRouteMode('loading');
    }
  }, [arming, routeMode]);

  // when both points exist → fetch + score routes
  useEffect(() => {
    if (routeMode !== 'loading' || !routePts.start || !routePts.end) return;
    let cancelled = false;
    (async () => {
      try {
        const plan = await planSafeRoute(routePts.start, routePts.end, riskCellsRef.current);
        if (cancelled) return;
        setRoutePlan(plan);
        setRouteMode('shown');
        const best = plan.routes[0];
        showToast(`Safest of ${plan.routes.length} routes · ${(best.distance_m / 1000).toFixed(1)} km · avoids ${Math.max(0, (plan.routes[plan.routes.length - 1].hotspotHits) - best.hotspotHits)} hotspot zones`);
      } catch (e) {
        if (cancelled) return;
        setRouteMode('idle');
        setRoutePlan(null);
        showToast('Routing failed — try again in a moment');
      }
    })();
    return () => { cancelled = true; };
  }, [routeMode, routePts, showToast]);

  const startRoutePlanning = () => {
    // ANY non-idle state → reset. (Previously only 'shown'/'loading' reset,
    // so if you were mid-picking you could never back out. State machines
    // need an exit from EVERY state.)
    if (routeMode !== 'idle') {
      setRouteMode('idle'); setRoutePlan(null); setRoutePts({ start: null, end: null });
    } else {
      setArming(false);
      setRouteMode('pick-start');
    }
  };

  // Escape key also cancels route picking / reporting — standard UX escape hatch
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setRouteMode('idle'); setRoutePlan(null); setRoutePts({ start: null, end: null });
      setArming(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Route from the user's current location to a chosen police station.
   * Requires location; if we don't have it yet, ask for it first.
   */
  const routeToStation = useCallback(async (station) => {
    if (!geo.coords) { geo.request(); showToast('Enable location to route to a station'); return; }
    const start = geo.coords;
    const end = { lat: station.lat, lng: station.lng };
    setArming(false);
    setRoutePts({ start, end });
    setRouteMode('loading');
    setFocusedLatLng(null);
    try {
      const plan = await planSafeRoute(start, end, riskCellsRef.current);
      setRoutePlan(plan);
      setRouteMode('shown');
      const best = plan.routes[0];
      showToast(`Route to ${station.name} · ${(best.distance_m / 1000).toFixed(1)} km · ~${Math.round(best.duration_s / 60)} min`);
    } catch {
      setRouteMode('idle');
      showToast('Could not route to that station — try again');
    }
  }, [geo, showToast]);

  // nearest stations, computed only when we have both location + station list
  const nearestStations = geo.coords && stations.length
    ? stationsByDistance(geo.coords, stations)
    : [];

  /* ---------------- report submit ---------------- */
  const handleSubmitReport = async (form) => {
    try {
      await api.submitReport({
        type: form.type,
        lat: pendingLatLng.lat, lng: pendingLatLng.lng,
        time_of_day: form.time_of_day,
        anonymous_id: getAnonymousId(),
      });
      setPendingLatLng(null);
      setArming(false);
      showToast('Report submitted anonymously · Thank you');
      // no manual refresh needed — our own Realtime subscription echoes it back
    } catch (e) {
      showToast(e.message || 'Could not submit — check your connection');
    }
  };

  /* ---------------- derived data for panels ---------------- */
  // 1) merge news + community events
  const allEvents = [...incidents, ...reports];

  // 2) filter by the day/night toggle. This is what makes the SIDEBAR
  //    respond to the toggle (the map heatmap already filters via its own
  //    precomputed grid). "Night" = incidents that occurred 7pm–6am.
  const timeFilteredEvents = allEvents.filter(i => {
    const night = isNight(i.dt || i.occurred_at);
    return timeOfDay === 'night' ? night : !night;
  });

  // 3) time-range window (7D / 30D / ALL from the dock)
  const rangeMs = timeRange === '7d' ? 7 * 864e5 : timeRange === '30d' ? 30 * 864e5 : null;
  const rangedEvents = rangeMs
    ? timeFilteredEvents.filter(i => Date.now() - new Date(i.dt || i.occurred_at) <= rangeMs)
    : timeFilteredEvents;

  // 4) apply the category chips on top
  const visibleIncidents = activeCat === 'all' ? rangedEvents
    : rangedEvents.filter(i => activeCat === 'sexual_assault'
        ? (i.type === 'sexual_assault' || i.type === 'assault')
        : i.type === activeCat);

  const hotspots = computeHotspots(visibleIncidents);
  const cityRisk = hotspots.length
    ? Math.min(100, Math.round(hotspots[0].score * 0.62 + hotspots.filter(h => h.score >= 30).length * 6))
    : 0;
  const safetyScore = Math.max(8, 100 - cityRisk);

  const routeBanner =
    routeMode === 'pick-start' ? 'Tap the map to set your START point' :
    routeMode === 'pick-end'   ? 'Now tap your DESTINATION' :
    routeMode === 'loading'    ? 'Computing safest route…' : null;

  return (
    <div className={`root-shell ${timeOfDay === 'night' ? 'is-night' : 'is-day'} ${arming ? 'arming' : ''} ${routeMode !== 'idle' && routeMode !== 'shown' ? 'routing' : ''}`}>
      <div className="ambient"><div className="bloom b1" /><div className="bloom b2" /><div className="bloom b3" /></div>
      <div className="vignette" /><div className="grain" /><div className="scan" />
      <CursorGlow />

      <MapView
        incidents={visibleIncidents}
        hotspots={hotspots}
        riskCells={riskCells}
        alerts={alerts}
        stations={stations}
        arming={arming}
        routeMode={routeMode}
        routePts={routePts}
        routePlan={routePlan}
        onMapClick={handleMapClick}
        focusedLatLng={focusedLatLng}
        userCoords={geo.coords}
        baseLayer={baseLayer}
        mapView={mapView}
      />

      <Legend />
      <Welcome alerts={alerts} onViewAlert={(al) => setFocusedLatLng({ lat: al.lat, lng: al.lng })} />

      {nudge && routeMode === 'idle' && !arming && (
        <div className="nudge-pop glass">
          <span>Going somewhere? Plot the <b>safest route</b> against live risk data.</span>
          <button className="nudge-go" onClick={() => { setNudge(false); startRoutePlanning(); }}>Try it</button>
          <button className="nudge-x" onClick={() => setNudge(false)}>✕</button>
        </div>
      )}

      {/* satellite toggle — React-rendered, always visible above zoom controls */}
      <button
        className={`sat-fab ${baseLayer === 'sat' ? 'on' : ''}`}
        onClick={() => setBaseLayer(b => (b === 'sat' ? 'dark' : 'sat'))}
        title="Toggle satellite view"
      >
        {baseLayer === 'sat' ? 'MAP' : 'SAT'}
      </button>

      {/* surge banner — most important thing on screen when active */}
      {alerts.length > 0 && (
        <div className="surge-banner" onClick={() => setFocusedLatLng({ lat: alerts[0].lat, lng: alerts[0].lng })}>
          <span className="sb-pulse" />
          <span className="sb-text">
            SURGE · {alerts[0].report_count} incidents in ~6h{alerts[0].area ? ` near ${alerts[0].area}` : ''}
            {alerts.length > 1 ? ` · +${alerts.length - 1} more` : ''}
          </span>
          <span className="sb-cta">View →</span>
        </div>
      )}

      {/* desktop nav rail — mockup's left icon column, mapped to real actions */}
      <nav className="rail glass">
        <button className={`rail-btn ${showLeft && showRight ? 'on' : ''}`} title="Overview"
          onClick={() => { setShowLeft(true); setShowRight(true); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
          <span>Overview</span>
        </button>
        <button className={`rail-btn ${!showLeft && !showRight ? 'on' : ''}`} title="Map only"
          onClick={() => { setShowLeft(false); setShowRight(false); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 20l-6-3V4l6 3 6-3 6 3v13l-6-3-6 3z"/><path d="M9 7v13M15 4v13"/></svg>
          <span>Live Map</span>
        </button>
        <button className={`rail-btn ${showRight && !showLeft ? 'on' : ''}`} title="Hotspots"
          onClick={() => { setShowLeft(false); setShowRight(true); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/></svg>
          <span>Hotspots</span>
        </button>
        <button className={`rail-btn ${arming ? 'on' : ''}`} title="Report"
          onClick={() => setArming(a => !a)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/></svg>
          <span>Report</span>
        </button>
        <a className="rail-btn rail-sos" href="tel:112" title="Emergency 112">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8.1 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/></svg>
          <span>SOS</span>
        </a>
      </nav>

      {/* map view tabs — Live Map | Heatmap | Clusters, with risk legend */}
      <div className="map-tabs glass">
        {[['live','Live Map'],['heat','Heatmap'],['clusters','Clusters']].map(([k, label]) => (
          <button key={k} className={`mt-btn ${mapView===k?'on':''}`} onClick={() => setMapView(k)}>{label}</button>
        ))}
        <div className="mt-legend">
          <span><i style={{ background:'#FF3B5C' }} />Critical</span>
          <span><i style={{ background:'#FFA63D' }} />High</span>
          <span><i style={{ background:'#2DD4BF' }} />Moderate</span>
        </div>
      </div>

      <TopBar
        timeOfDay={timeOfDay}
        incidents={visibleIncidents}
        hotspots={hotspots}
        safetyScore={safetyScore}
        onSearch={(latlng) => setFocusedLatLng(latlng)}
      />
      {showLeft && <LeftSidebar
        timeOfDay={timeOfDay}
        incidents={visibleIncidents}
        hotspots={hotspots}
        safetyScore={safetyScore}
        routeShown={routeMode !== 'idle'}
        routeMode={routeMode}
        routePts={routePts}
        routePlan={routePlan}
        onToggleRoute={startRoutePlanning}
        geoStatus={geo.status}
        onRequestLocation={geo.request}
        nearestStations={nearestStations}
        onRouteToStation={routeToStation}
      />}
      {showRight && <RightSidebar
        hotspots={hotspots}
        incidents={visibleIncidents}
        onHotspotClick={(h) => setFocusedLatLng({ lat: h.lat, lng: h.lng })}
      />}
      <Dock
        timeOfDay={timeOfDay} setTimeOfDay={setTimeOfDay}
        activeCat={activeCat} setActiveCat={setActiveCat}
        arming={arming} setArming={(v) => { setArming(v); if (v) { setRouteMode('idle'); setRoutePlan(null); } }}
        timeRange={timeRange} setTimeRange={setTimeRange}
      />

      <div className={`arm-banner ${arming || routeBanner ? 'show' : ''}`}>
        <div className="ab-dot" />
        <span>{routeBanner || 'Tap anywhere on the map to mark the incident location'}</span>
        <button className="ab-cancel" onClick={() => {
          setRouteMode('idle'); setRoutePlan(null);
          setRoutePts({ start: null, end: null }); setArming(false);
        }}>✕</button>
      </div>

      <div className={`toast glass ${toast ? 'show' : ''}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <span>{toast}</span>
      </div>

      {!supabaseConfigured && (
        <div className="config-warn glass">
          Supabase not configured — set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>
        </div>
      )}

      {pendingLatLng && (
        <ReportModal
          latlng={pendingLatLng}
          defaultTime={timeOfDay}
          onCancel={() => setPendingLatLng(null)}
          onSubmit={handleSubmitReport}
        />
      )}
    </div>
  );
}

function CursorGlow() {
  const ref = useRef(null);
  // Touch devices have no cursor — rendering this + a mousemove listener is
  // pure wasted work on phones. Skip it entirely.
  const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  useEffect(() => {
    if (isTouch) return;
    const move = (e) => { if (ref.current) ref.current.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, [isTouch]);
  if (isTouch) return null;
  return <div className="cursor-glow" ref={ref} />;
}
