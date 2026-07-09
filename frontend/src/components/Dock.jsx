const CATS = [
  { cat:'all', label:'All', color:'#FF6178' },
  { cat:'sexual_assault', label:'Assault', color:'#FF3B5C' },
  { cat:'harassment', label:'Harassment', color:'#FFA63D' },
  { cat:'chain_snatching', label:'Snatching', color:'#FFC074' },
  { cat:'stalking', label:'Stalking', color:'#C084FC' },
  { cat:'theft', label:'Theft', color:'#4DA3FF' },
];

const RANGES = [
  { key:'7d', label:'7D' },
  { key:'30d', label:'30D' },
  { key:'all', label:'ALL' },
];

export default function Dock({ timeOfDay, setTimeOfDay, activeCat, setActiveCat, arming, setArming, timeRange, setTimeRange }) {
  return (
    <div className="dock glass">
      {/* day/night */}
      <div className="daynight">
        <button className={`dn-btn dn-day ${timeOfDay==='day'?'on':''}`} onClick={() => setTimeOfDay('day')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
          </svg>
          Day
        </button>
        <button className={`dn-btn dn-night ${timeOfDay==='night'?'on':''}`} onClick={() => setTimeOfDay('night')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>
          </svg>
          Night
        </button>
      </div>

      <div className="dock-sep" />

      {/* time view — 7D/30D/ALL window over the incident data */}
      <div className="timeview">
        {RANGES.map(({ key, label }) => (
          <button key={key} className={`tv-btn ${timeRange===key?'on':''}`}
            onClick={() => setTimeRange(key)}>{label}</button>
        ))}
      </div>

      <div className="dock-sep" />

      <div className="filters">
        {CATS.map(({ cat, label, color }) => (
          <button key={cat} className={`filter-chip ${activeCat===cat?'on':''}`}
            onClick={() => setActiveCat(cat)}>
            <span className="fdot" style={{ background: color, boxShadow:`0 0 6px ${color}` }} />
            {label}
          </button>
        ))}
      </div>

      <div className="dock-sep" />

      <button className={`report-btn ${arming?'armed':''}`} onClick={() => setArming(a => !a)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/>
        </svg>
        <span className="rb-text">{arming ? 'Cancel' : 'Report Incident'}</span>
      </button>

      {/* Quick SOS — one tap dials 112 */}
      <a className="sos-btn" href="tel:112" title="Emergency call 112">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8.1 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/>
        </svg>
        <span className="sos-text">SOS</span>
      </a>
    </div>
  );
}
