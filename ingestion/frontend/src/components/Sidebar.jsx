export default function Sidebar({
  timeOfDay, setTimeOfDay, incidents, hotspots, onHotspotClick,
}) {
  const highRisk = hotspots.filter(h => h.score >= 30).length;

  return (
    <aside className="sidebar">
      <div className="header">
        <div className="brand"><span className="brand-dot" />Raipur Safe Map</div>
        <div className="tagline">Women's safety atlas · v0.1</div>
      </div>

      <div className="time-toggle">
        <div className="section-label">Time of day</div>
        <div className="toggle-group">
          <button
            className={`toggle-btn ${timeOfDay === 'day' ? 'active' : ''}`}
            onClick={() => setTimeOfDay('day')}
          >
            <svg className="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="4"/>
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
            </svg>
            Day
          </button>
          <button
            className={`toggle-btn ${timeOfDay === 'night' ? 'active' : ''}`}
            onClick={() => setTimeOfDay('night')}
          >
            <svg className="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
            Night
          </button>
        </div>
      </div>

      <div className="stats">
        <div className="section-label">Live overview</div>
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-value">{incidents.length}</div>
            <div className="stat-label">Incidents shown</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{highRisk}</div>
            <div className="stat-label">High-risk zones</div>
          </div>
        </div>
      </div>

      <div className="legend">
        <div className="section-label">Risk level</div>
        <div className="legend-row"><div className="legend-swatch" style={{ background: 'var(--safe)' }} />Low</div>
        <div className="legend-row"><div className="legend-swatch" style={{ background: 'var(--caution)' }} />Caution</div>
        <div className="legend-row"><div className="legend-swatch" style={{ background: 'var(--danger)' }} />High</div>
        <div className="legend-row"><div className="legend-swatch" style={{ background: 'var(--critical)' }} />Critical</div>
      </div>

      <div className="hotspots">
        <div className="section-label">
          Top hotspots <span style={{ color: 'var(--accent)' }}>— {timeOfDay === 'night' ? 'Night' : 'Day'}</span>
        </div>
        <div className="hotspot-list">
          {hotspots.map((h, idx) => {
            const color = h.score >= 60 ? 'var(--critical)'
                        : h.score >= 30 ? 'var(--danger)'
                        : h.score >= 15 ? 'var(--caution)' : 'var(--safe)';
            return (
              <div
                key={idx}
                className="hotspot-item"
                onClick={() => onHotspotClick(h)}
              >
                <div className="hotspot-info">
                  <div className="hotspot-name">{h.area}</div>
                  <div className="hotspot-meta">
                    {h.incident_count} incident{h.incident_count !== 1 ? 's' : ''}
                  </div>
                </div>
                <div
                  className="hotspot-score"
                  style={{ background: color + '33', color }}
                >
                  {h.score}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="footer">
        Areas with fewer reported incidents are not necessarily safe — many incidents go unreported. Always trust your instincts.
      </div>
    </aside>
  );
}
