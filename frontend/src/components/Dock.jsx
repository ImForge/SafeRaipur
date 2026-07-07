const CATS = [
  { cat:'all', label:'All' },
  { cat:'sexual_assault', label:'Assault' },
  { cat:'harassment', label:'Harassment' },
  { cat:'chain_snatching', label:'Snatching' },
  { cat:'stalking', label:'Stalking' },
  { cat:'theft', label:'Theft' },
];

export default function Dock({ timeOfDay, setTimeOfDay, activeCat, setActiveCat, arming, setArming }) {
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

      <div className="filters">
        {CATS.map(({ cat, label }) => (
          <button key={cat} className={`filter-chip ${activeCat===cat?'on':''}`}
            onClick={() => setActiveCat(cat)}>
            <span className="fdot" />
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
    </div>
  );
}
