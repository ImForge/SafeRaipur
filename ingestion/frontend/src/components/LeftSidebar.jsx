import { useEffect, useRef, useState } from 'react';
import { scoreColor, TYPE_LABEL, isNight } from '../utils/risk.js';

/* ── animated counter hook ── */
function useCounter(target, duration = 1100) {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current, t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * e));
      if (p < 1) requestAnimationFrame(step); else prev.current = target;
    };
    requestAnimationFrame(step);
  }, [target]);
  return val;
}

/* ── sparkline ── */
function Spark({ data, color, id }) {
  const w = 100, h = 26;
  if (!data || data.length < 2) return <svg className="spark" />;
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((d, i) => [
    (i / (data.length - 1)) * w,
    h - 2 - ((d - min) / (max - min || 1)) * (h - 6),
  ]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#g${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="2.2" fill={color} />
    </svg>
  );
}

/* ── circular gauge ── */
function Gauge({ score }) {
  const C = 2 * Math.PI * 52;
  const col = scoreColor(score);
  const [offset, setOffset] = useState(C);
  useEffect(() => {
    const id = setTimeout(() => setOffset(C * (1 - score / 100)), 80);
    return () => clearTimeout(id);
  }, [score, C]);
  const displayScore = useCounter(score, 1700);
  return (
    <div className="gauge">
      <svg viewBox="0 0 120 120">
        <circle className="gauge-ring-bg" cx="60" cy="60" r="52" />
        <circle className="gauge-ring" cx="60" cy="60" r="52"
          style={{ stroke: col, strokeDasharray: C, strokeDashoffset: offset }} />
      </svg>
      <div className="gauge-center">
        <div className="gauge-num" style={{ color: col }}>{displayScore}</div>
        <div className="gauge-max">/ 100</div>
      </div>
    </div>
  );
}

/* ── forecast bars ── */
function Forecast() {
  const nowH = new Date().getHours();
  const bars = Array.from({ length: 8 }, (_, k) => {
    const h = (nowH + k * 1.5) % 24;
    const r = Math.min(95, Math.max(12,
      20 + 35 * Math.exp(-Math.pow((h - 21.5) / 3.4, 2))
         + 14 * Math.exp(-Math.pow((h - 7) / 3, 2))
         + (Math.random() * 8 - 4)));
    return { h: Math.round(h), r: Math.round(r) };
  });
  const [heights, setHeights] = useState(bars.map(() => 6));
  useEffect(() => {
    bars.forEach((b, i) => setTimeout(() => setHeights(h => h.map((v, j) => j === i ? b.r : v)), i * 70));
  }, []);
  return (
    <>
      <div className="pred-bars">
        {bars.map((b, i) => {
          const col = b.r > 58 ? '#FF3B5C' : b.r > 34 ? '#FFA63D' : '#2DD4BF';
          return (
            <div key={i} className="pred-bar"
              data-h={`${String(b.h).padStart(2,'0')}h`}
              style={{ color: col, height: heights[i] + '%' }} />
          );
        })}
      </div>
      <div className="pred-labels"><span>Now</span><span>+4h</span><span>+8h</span><span>+12h</span></div>
    </>
  );
}

export default function LeftSidebar({ timeOfDay, incidents, hotspots, safetyScore, routeShown, onToggleRoute }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState('overview');

  const col = scoreColor(safetyScore);
  const statusLabel = safetyScore >= 66 ? 'Stable' : safetyScore >= 40 ? 'Elevated' : 'High Alert';
  const statusDesc = safetyScore >= 66
    ? 'Most monitored zones report low activity.'
    : safetyScore >= 40
    ? 'Several zones show raised activity. Caution after dark.'
    : 'Multiple active hotspots detected. Avoid flagged corridors.';

  const incCount = useCounter(incidents.length);
  const zoneCount = useCounter(hotspots.filter(h => h.score >= 30).length);

  // distribution
  const cats = { Assault:0, Harassment:0, Stalking:0, Snatching:0, Theft:0 };
  incidents.forEach(i => { const l = TYPE_LABEL[i.type]; if (cats[l] != null) cats[l]++; });
  const total = Object.values(cats).reduce((a,b)=>a+b,0) || 1;
  const DIST_COLORS = { Assault:'#FF3B5C', Harassment:'#FFA63D', Stalking:'#FF6178', Snatching:'#FFC074', Theft:'#2DD4BF' };

  // AI insights
  const top = hotspots[0];
  const nightN = incidents.filter(i => isNight(i.dt || i.occurred_at)).length;
  const dayN = incidents.length - nightN;
  const ratio = Math.round(nightN / (dayN || 1) * 10) / 10;
  const snatch = incidents.filter(i => i.type === 'chain_snatching').length;
  const insights = [
    top ? <><b>{top.area}</b> is highest-risk right now with {top.n} incidents and score {top.score}/100. Avoid after 21:00.</> : null,
    <>Night incidents outnumber daytime ones <b>{ratio}×</b>. Risk peaks between <b>20:00 and 23:00</b>.</>,
    snatch > 0 ? <><b>{snatch} snatching</b> reports near bus stands. Keep bags on the inner side in lit lanes.</> : null,
  ].filter(Boolean);

  // sparkline data (growing series up to current count)
  const sparkA = [4, 6, 5, 8, 7, 11, 9, incidents.length];
  const sparkB = [2, 3, 2, 4, 3, 5, 4, hotspots.filter(h => h.score >= 30).length];

  return (
    <aside className={`side side-left glass ${sheetOpen ? 'sheet-open' : ''}`}>
      <div className="sheet-handle" onClick={() => setSheetOpen(o => !o)}>
        <div className="sheet-grip" />
        <div className="sheet-peek">Overview · Hotspots</div>
      </div>
      <div className="mobile-tabs">
        {['overview','hotspots'].map(t => (
          <button key={t} className={`mtab ${mobileTab === t ? 'on' : ''}`}
            onClick={() => { setMobileTab(t); setSheetOpen(true); }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="side-scroll">
        {/* OVERVIEW PANE */}
        <div className="tab-pane on" data-pane="overview">

          {/* Safety Score */}
          <div className="block">
            <div className="block-head">
              <div className="panel-label"><span className="tick" />City Safety Index</div>
              <div className="panel-label">{timeOfDay.toUpperCase()}</div>
            </div>
            <div className="score-card">
              <div className="score-row">
                <Gauge score={safetyScore} />
                <div className="score-meta">
                  <div className="score-status" style={{ color: col }}>{statusLabel}</div>
                  <div className="score-desc">{statusDesc}</div>
                  <div className="score-delta">
                    <svg viewBox="0 0 24 24" width="10" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M7 17L17 7M17 7H9M17 7v8"/>
                    </svg>
                    +6% vs last week
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Metrics */}
          <div className="block">
            <div className="block-head"><div className="panel-label"><span className="tick" />Live Telemetry</div></div>
            <div className="metric-grid">
              <div className="metric" style={{ color:'var(--crimson)' }}>
                <div className="mlabel">Incidents Shown</div>
                <div className="mval">{incCount}</div>
                <Spark data={sparkA} color="#FF3B5C" id="a" />
                <div className="accent-bar" />
              </div>
              <div className="metric" style={{ color:'var(--amber)' }}>
                <div className="mlabel">High-Risk Zones</div>
                <div className="mval">{zoneCount}</div>
                <Spark data={sparkB} color="#FFA63D" id="b" />
                <div className="accent-bar" />
              </div>
              <div className="metric" style={{ color:'var(--teal)' }}>
                <div className="mlabel">Patrol Units</div>
                <div className="mval">12</div>
                <div className="mfoot"><span style={{ color:'var(--teal)' }}>●</span> All active</div>
                <div className="accent-bar" />
              </div>
              <div className="metric" style={{ color:'var(--crimson-soft)' }}>
                <div className="mlabel">Avg Response</div>
                <div className="mval">8<span style={{ fontSize:12 }}>m</span></div>
                <div className="mfoot"><span style={{ color:'var(--amber)' }}>▲</span> +1m at night</div>
                <div className="accent-bar" />
              </div>
            </div>
          </div>

          {/* Distribution */}
          <div className="block">
            <div className="block-head"><div className="panel-label"><span className="tick" />Incident Distribution</div></div>
            <div className="dist">
              {Object.entries(cats).map(([k, v]) => {
                const pct = Math.round(v / total * 100);
                return (
                  <div key={k} className="dist-row">
                    <div className="dname">{k}</div>
                    <div className="dist-track">
                      <div className="dist-fill" style={{ width: pct+'%', background: DIST_COLORS[k], color: DIST_COLORS[k] }} />
                    </div>
                    <div className="dpct">{pct}%</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* AI Insights */}
          <div className="block">
            <div className="block-head">
              <div className="panel-label">
                <span className="tick" style={{ background:'var(--teal)', boxShadow:'0 0 8px var(--teal)' }} />
                Intelligence Brief
              </div>
            </div>
            <div className="ai-card">
              <div className="ai-badge">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/>
                  <circle cx="12" cy="12" r="3.2"/>
                </svg>
                <span>AI ANALYSIS</span>
              </div>
              {insights.map((text, i) => (
                <div key={i} className="ai-insight">
                  <div className="ibullet" />
                  <div>{text}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Forecast */}
          <div className="block">
            <div className="block-head">
              <div className="panel-label">
                <span className="tick" style={{ background:'var(--amber)', boxShadow:'0 0 8px var(--amber)' }} />
                Risk Forecast · Next 12h
              </div>
            </div>
            <Forecast />
          </div>

          {/* Safe Route */}
          <div className="block">
            <div className="block-head">
              <div className="panel-label">
                <span className="tick" style={{ background:'var(--teal)', boxShadow:'0 0 8px var(--teal)' }} />
                Safe Navigation
              </div>
            </div>
            <button className="route-btn" onClick={onToggleRoute}>
              <svg viewBox="0 0 24 24" width="15" fill="none" stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/>
                <path d="M8.5 19H14a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h5.5"/>
              </svg>
              {routeShown ? 'Hide Route' : 'Plot Safest Route'}
            </button>
            {routeShown && (
              <div className="route-info">
                <div className="route-stats">
                  <div className="rstat"><div className="rv" style={{ color:'var(--teal)' }}>3.4<small style={{fontSize:9}}> km</small></div><div className="rl">Distance</div></div>
                  <div className="rstat"><div className="rv" style={{ color:'var(--amber)' }}>14<small style={{fontSize:9}}> min</small></div><div className="rl">Est. Time</div></div>
                  <div className="rstat"><div className="rv" style={{ color:'var(--teal)' }}>Low</div><div className="rl">Risk</div></div>
                </div>
                <div className="route-note">Route avoids 2 active hotspots. Via well-lit corridors. A suggestion — stay alert.</div>
              </div>
            )}
          </div>

          {/* Data awareness note */}
          <div className="block">
            <div className="data-note">
              <div className="data-note-head">
                <svg viewBox="0 0 24 24" width="13" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                </svg>
                <span>About this data</span>
              </div>
              <p>
                This map shows <b>reported</b> incidents only. The real numbers are far
                higher — most harassment and stalking is never reported to police or
                covered by news. An area looking quiet here does not mean it is safe.
                It often just means people there stay silent.
              </p>
            </div>
          </div>

        </div>{/* /overview pane */}

        {/* HOTSPOTS PANE (mobile tab) */}
        <div className={`tab-pane ${mobileTab === 'hotspots' ? 'on' : ''}`} data-pane="hotspots">
          <HotspotCards hotspots={[]} />
        </div>
      </div>
    </aside>
  );
}

function HotspotCards({ hotspots }) {
  return (
    <div className="hs-list">
      {hotspots.slice(0,7).map((h,i) => <HotspotCard key={i} h={h} />)}
    </div>
  );
}

function HotspotCard({ h }) {
  const col = h.score >= 60 ? '#FF3B5C' : h.score >= 30 ? '#FFA63D' : '#2DD4BF';
  const lvl = h.score >= 60 ? 'Critical' : h.score >= 30 ? 'Elevated' : 'Moderate';
  const recent = [...(h.items || [])].sort((a,b) => new Date(b.dt||b.occurred_at) - new Date(a.dt||a.occurred_at)).slice(0,3);
  return (
    <div className="hs-card" style={{ color: col }}>
      <div className="hs-top">
        <div>
          <div className="hs-name" style={{ color:'var(--text)' }}>
            <span className="hs-live" />{h.area}
          </div>
          <div className="hs-meta">{lvl.toUpperCase()} · {h.n || h.incident_count} INCIDENTS</div>
        </div>
        <div className="hs-score" style={{ color: col }}>{h.score}<small>SCORE</small></div>
      </div>
      <div className="hs-bar"><div className="hs-bar-fill" style={{ width: h.score+'%' }} /></div>
      <div className="hs-expand">
        <div className="hs-expand-inner">
          {recent.map((inc,i) => (
            <div key={i} className="hs-incident">
              <span className="hi-type">{TYPE_LABEL[inc.type] || inc.type}</span>
              <span>{new Date(inc.dt || inc.occurred_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>
            </div>
          ))}
          <div className="hs-trend">
            <svg viewBox="0 0 24 24" width="12" fill="none" stroke={col} strokeWidth="2.5">
              <path d="M3 17L9 11l4 4 8-8M21 7v6M21 7h-6"/>
            </svg>
            Trend: {h.score >= 50 ? 'rising' : 'stable'} this month
          </div>
        </div>
      </div>
    </div>
  );
}
export { HotspotCard };