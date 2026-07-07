import { useState, useEffect, useRef } from 'react';
import { scoreColor } from '../utils/risk.js';

const PLACES = [
  'Telibandha','Pandri','Tikrapara','Gol Bazar','Civil Lines',
  'Gudhiyari','Mowa','Khamhardih','Ganj','Mandir Hasaud','Devendra Nagar',
  'New Raipur','Naya Raipur','Atal Nagar','Mantralaya',
  'Devpuri','Tatibandh','Urla','Birgaon','Pachpedi Naka',
  'Fafadih','Sarona','Avanti Vihar','Shankar Nagar','Nehru Nagar',
  'Labhandi','Bhanpuri','Kabir Nagar','Rawabhata','Amleshwar',
  'Boriyakhurd','Siltara','Kumhari','Rajatalab','Saddu',
];

const COORDS = {
  'Telibandha':      [21.2362, 81.6498],
  'Pandri':          [21.2467, 81.6442],
  'Tikrapara':       [21.2538, 81.6234],
  'Gol Bazar':       [21.2390, 81.6432],
  'Civil Lines':     [21.2587, 81.6378],
  'Gudhiyari':       [21.2364, 81.6111],
  'Mowa':            [21.2790, 81.6815],
  'Khamhardih':      [21.2533, 81.6759],
  'Ganj':            [21.2415, 81.6450],
  'Mandir Hasaud':   [21.2156, 81.7372],
  'Devendra Nagar':  [21.2473, 81.6557],
  'New Raipur':      [21.1400, 81.7300],
  'Naya Raipur':     [21.1400, 81.7300],
  'Atal Nagar':      [21.1400, 81.7300],
  'Mantralaya':      [21.1370, 81.7390],
  'Devpuri':         [21.2170, 81.5870],
  'Tatibandh':       [21.2850, 81.6490],
  'Urla':            [21.2720, 81.5760],
  'Birgaon':         [21.2900, 81.7100],
  'Pachpedi Naka':   [21.2180, 81.6180],
  'Fafadih':         [21.2248, 81.6358],
  'Sarona':          [21.2100, 81.7100],
  'Avanti Vihar':    [21.2508, 81.6328],
  'Shankar Nagar':   [21.2555, 81.6428],
  'Nehru Nagar':     [21.2685, 81.6388],
  'Labhandi':        [21.2658, 81.6228],
  'Bhanpuri':        [21.3050, 81.6500],
  'Kabir Nagar':     [21.2628, 81.6562],
  'Rawabhata':       [21.1900, 81.6150],
  'Amleshwar':       [21.1750, 81.5660],
  'Boriyakhurd':     [21.2520, 81.6215],
  'Siltara':         [21.3200, 81.6700],
  'Kumhari':         [21.3500, 81.6800],
  'Rajatalab':       [21.1980, 81.5900],
  'Saddu':           [21.1900, 81.6540],
};

export default function TopBar({ incidents, hotspots, safetyScore, onSearch }) {
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');
  const [count, setCount] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const prevCount = useRef(0);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`);
      setDate(d.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short' }).toUpperCase());
    };
    tick(); const id = setInterval(tick, 20000); return () => clearInterval(id);
  }, []);

  // animated counter
  useEffect(() => {
    const target = incidents.length;
    if (target === prevCount.current) return;
    const start = prevCount.current, dur = 900, t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1,(now-t0)/dur), e = 1-Math.pow(1-p,3);
      setCount(Math.round(start+(target-start)*e));
      if (p < 1) requestAnimationFrame(step); else prevCount.current = target;
    };
    requestAnimationFrame(step);
  }, [incidents.length]);

  const statusLabel = safetyScore >= 66 ? 'STABLE' : safetyScore >= 40 ? 'ELEVATED' : 'HIGH ALERT';
  const statusColor = scoreColor(safetyScore);

  const handleSearch = (e) => {
    const q = e.target.value; setQuery(q);
    if (!q.trim()) { setResults([]); return; }
    setResults(PLACES.filter(p => p.toLowerCase().includes(q.toLowerCase())).slice(0,5));
  };

  return (
    <header className="topbar glass">
      {/* brand */}
      <div className="brand">
        <div className="logo-mark">
          <svg viewBox="0 0 24 24" width="18" fill="none" stroke="#fff" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">SENTINEL</div>
          <div className="brand-sub">RAIPUR · SAFETY OPS</div>
        </div>
      </div>

      <div className="live-chip">
        <div className="live-dot" />
        <span>LIVE FEED</span>
      </div>

      {/* search */}
      <div className="search-wrap" style={{ position:'relative' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
        </svg>
        <input value={query} onChange={handleSearch}
          placeholder="Search localities, zones…" autoComplete="off"/>
        {results.length > 0 && (
          <div className="search-results glass">
            {results.map(p => (
              <div key={p} className="sr-item" onClick={() => {
                setQuery(p);
                setResults([]);
                const coords = COORDS[p];
                if (coords && onSearch) onSearch({ lat: coords[0], lng: coords[1] });
              }}>
                <span className="dot" />
                {p}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="spacer" />

      {/* incidents pill */}
      <div className="stat-pill">
        <div className="pi" style={{ background:'rgba(255,59,92,.14)' }}>
          <svg viewBox="0 0 24 24" width="15" fill="none" stroke="#FF6178" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/>
          </svg>
        </div>
        <div>
          <div className="pv" style={{ color:'var(--crimson-soft)' }}>{count}</div>
          <div className="pl">Active Incidents</div>
        </div>
      </div>

      {/* city status pill */}
      <div className="stat-pill pill-status">
        <div className="pi" style={{ background:'rgba(255,166,61,.14)' }}>
          <svg viewBox="0 0 24 24" width="15" fill="none" stroke="#FFC074" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>
        </div>
        <div>
          <div className="pv" style={{ color: statusColor }}>{statusLabel}</div>
          <div className="pl">City Status</div>
        </div>
      </div>

      {/* clock */}
      <div className="stat-pill weather-pill" style={{ gap:8, paddingLeft:12 }}>
        <div>
          <div className="clock-val">29°<span style={{ fontSize:10, color:'var(--text-faint)' }}> Clear</span></div>
          <div className="clock-date">Raipur · CG</div>
        </div>
        <div style={{ width:1, height:28, background:'var(--stroke)', margin:'0 4px' }} />
        <div>
          <div className="clock-val">{time}</div>
          <div className="clock-date">{date}</div>
        </div>
      </div>
    </header>
  );
}