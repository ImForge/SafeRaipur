import { HotspotCard } from './LeftSidebar.jsx';

export default function RightSidebar({ hotspots, onHotspotClick }) {
  const highRisk = hotspots.filter(h => h.score >= 30).length;
  return (
    <aside className="side side-right glass">
      <div className="side-scroll">
        <div className="block">
          <div className="block-head">
            <div className="panel-label"><span className="tick" />Priority Hotspots</div>
            <div className="panel-label">{highRisk} ZONES</div>
          </div>
          <div className="hs-list">
            {hotspots.slice(0, 7).map((h, i) => (
              <div key={i} onClick={() => onHotspotClick(h)} style={{ cursor:'pointer' }}>
                <HotspotCard h={h} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
