import { useState, useEffect, useCallback, useRef } from 'react';
import { api, getAnonymousId } from './api.js';
import { computeHotspots, scoreColor } from './utils/risk.js';
import TopBar from './components/TopBar.jsx';
import LeftSidebar from './components/LeftSidebar.jsx';
import RightSidebar from './components/RightSidebar.jsx';
import MapView from './components/Map.jsx';
import Dock from './components/Dock.jsx';
import ReportModal from './components/ReportModal.jsx';

export default function App() {
  const [timeOfDay, setTimeOfDay] = useState('night');
  const [activeCat, setActiveCat] = useState('all');
  const [incidents, setIncidents] = useState([]);
  const [hotspots, setHotspots] = useState([]);
  const [arming, setArming] = useState(false);
  const [pendingLatLng, setPendingLatLng] = useState(null);
  const [focusedLatLng, setFocusedLatLng] = useState(null);
  const [routeShown, setRouteShown] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  const refresh = useCallback(async () => {
    try {
      const [inc, hot] = await Promise.all([
        api.listIncidents({ timeOfDay }),
        api.getHotspots({ timeOfDay, limit: 8 }),
      ]);
      // normalise field names (backend sends occurred_at, our utils expect dt)
      const normalised = inc.map((i) => ({
        ...i,
        dt: i.occurred_at || i.dt,
        area: i.area || 'Unknown',
      }));
      setIncidents(normalised);
      // backend may return empty hotspots if DB not seeded yet — fallback to client-side
      if (hot.length > 0) {
        setHotspots(hot);
      } else {
        setHotspots(computeHotspots(normalised));
      }
    } catch {
      // backend not running — show empty state, no crash
      setIncidents([]);
      setHotspots([]);
    }
  }, [timeOfDay]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleMapClick = useCallback((latlng) => {
    if (!arming) return;
    setPendingLatLng(latlng);
  }, [arming]);

  const handleSubmitReport = async (form) => {
    try {
      await api.submitReport({
        type: form.type,
        lat: pendingLatLng.lat,
        lng: pendingLatLng.lng,
        time_of_day: form.time_of_day,
        anonymous_id: getAnonymousId(),
      });
      setPendingLatLng(null);
      setArming(false);
      showToast('Report submitted anonymously · Thank you');
      await refresh();
    } catch (e) {
      showToast('Could not submit — check your connection');
    }
  };

  const cityRisk = hotspots.length
    ? Math.min(100, Math.round(hotspots[0].score * 0.62 + hotspots.filter((h) => h.score >= 30).length * 6))
    : 0;
  const safetyScore = Math.max(8, 100 - cityRisk);

  return (
    <div className={`root-shell ${timeOfDay === 'night' ? 'is-night' : 'is-day'} ${arming ? 'arming' : ''}`}>
      {/* atmosphere */}
      <div className="ambient">
        <div className="bloom b1" /><div className="bloom b2" /><div className="bloom b3" />
      </div>
      <div className="vignette" /><div className="grain" /><div className="scan" />
      <CursorGlow />

      {/* map (behind everything) */}
      <MapView
        incidents={incidents}
        hotspots={hotspots}
        arming={arming}
        onMapClick={handleMapClick}
        focusedLatLng={focusedLatLng}
        routeShown={routeShown}
      />

      {/* panels */}
      <TopBar
        timeOfDay={timeOfDay}
        incidents={incidents}
        hotspots={hotspots}
        safetyScore={safetyScore}
      />
      <LeftSidebar
        timeOfDay={timeOfDay}
        incidents={incidents}
        hotspots={hotspots}
        safetyScore={safetyScore}
        routeShown={routeShown}
        onToggleRoute={() => setRouteShown((r) => !r)}
      />
      <RightSidebar
        hotspots={hotspots}
        timeOfDay={timeOfDay}
        onHotspotClick={(h) => setFocusedLatLng({ lat: h.lat, lng: h.lng })}
      />
      <Dock
        timeOfDay={timeOfDay}
        setTimeOfDay={setTimeOfDay}
        activeCat={activeCat}
        setActiveCat={setActiveCat}
        arming={arming}
        setArming={setArming}
      />

      {/* arm banner */}
      <div className={`arm-banner ${arming ? 'show' : ''}`}>
        <div className="ab-dot" />
        <span>Tap anywhere on the map to mark the incident location</span>
      </div>

      {/* toast */}
      <div className={`toast glass ${toast ? 'show' : ''}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <span>{toast}</span>
      </div>

      {/* modal */}
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
  useEffect(() => {
    const move = (e) => {
      if (ref.current) ref.current.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
    };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);
  return <div className="cursor-glow" ref={ref} />;
}
