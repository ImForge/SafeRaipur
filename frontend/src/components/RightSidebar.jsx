import { HotspotCard } from './LeftSidebar.jsx';
import { TYPE_LABEL } from '../utils/risk.js';

function timeAgo(dt) {
  const mins = Math.floor((Date.now() - new Date(dt)) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export default function RightSidebar({ hotspots, incidents = [], onHotspotClick }) {
  const highRisk = hotspots.filter(h => h.score >= 30).length;
  const recent = [...incidents]
    .sort((a, b) => new Date(b.dt || b.occurred_at) - new Date(a.dt || a.occurred_at))
    .slice(0, 5);

  return (
    <aside className="side side-right glass">
      <div className="side-scroll">
        <div className="block">
          <div className="block-head">
            <div className="panel-label"><span className="tick" />Priority Hotspots</div>
            <div className="panel-label">{highRisk} ZONES</div>
          </div>
          <div className="hs-list">
            {hotspots.slice(0, 6).map((h, i) => (
              <div key={i} onClick={() => onHotspotClick(h)} style={{ cursor:'pointer' }}>
                <HotspotCard h={h} rank={i + 1} />
              </div>
            ))}
          </div>
        </div>

        <div className="block">
          <div className="block-head">
            <div className="panel-label">
              <span className="tick" style={{ background:'var(--crimson)', boxShadow:'0 0 8px var(--crimson)' }} />
              Recent Incidents
            </div>
          </div>
          <div className="ri-list">
            {recent.map((i, k) => {
              const sev = i.severity || 1;
              const col = sev >= 6 ? '#FF3B5C' : sev >= 3 ? '#FFA63D' : '#2DD4BF';
              const chip = sev >= 6 ? 'High' : sev >= 3 ? 'Elevated' : 'Low';
              return (
                <div key={k} className="ri-row" onClick={() => onHotspotClick({ lat: i.lat, lng: i.lng })}>
                  <span className="ri-dot" style={{ background: col, boxShadow:`0 0 6px ${col}` }} />
                  <div className="ri-info">
                    <div className="ri-type">{TYPE_LABEL[i.type] || i.type}</div>
                    <div className="ri-meta">{i.area || 'Community report'} · {timeAgo(i.dt || i.occurred_at)}</div>
                  </div>
                  <span className="ri-chip" style={{ color: col, borderColor: col+'55', background: col+'14' }}>{chip}</span>
                </div>
              );
            })}
            {recent.length === 0 && <div className="ri-empty">No incidents in this view</div>}
          </div>
        </div>
      </div>
    </aside>
  );
}
