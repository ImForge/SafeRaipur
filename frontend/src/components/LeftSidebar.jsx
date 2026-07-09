import { useEffect, useRef, useState } from 'react';
import { scoreColor, TYPE_LABEL, isNight } from '../utils/risk.js';
import { fmtDistance, estimateDriveMinutes, gmapsUrl } from '../utils/geo.js';
import { HELPLINES, activeProtocols } from '../utils/safety.js';

// shared palette — used by both the sidebar legend and the Donut component
const DIST_COLORS = { Homicide:'#DC2626', Assault:'#FF3B5C', Robbery:'#F97316', Harassment:'#FFA63D', Stalking:'#FF6178', Snatching:'#FFC074', Theft:'#2DD4BF' };

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

export default function LeftSidebar({ timeOfDay, incidents, hotspots, safetyScore, routeShown, routeMode, routePts, routePlan, onToggleRoute, geoStatus, onRequestLocation, nearestStations, onRouteToStation }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const touchY = useRef(null);

  // let global CSS know the sheet is up (hides Legend/SAT chips underneath)
  useEffect(() => {
    document.body.classList.toggle('sheet-up', sheetOpen);
    return () => document.body.classList.remove('sheet-up');
  }, [sheetOpen]);

  // swipe gesture on the handle/tabs: swipe down closes, swipe up opens
  const onTouchStart = (e) => { touchY.current = e.touches[0].clientY; };
  const onTouchEnd = (e) => {
    if (touchY.current == null) return;
    const dy = e.changedTouches[0].clientY - touchY.current;
    touchY.current = null;
    if (dy > 40) setSheetOpen(false);      // swiped down → show the map
    else if (dy < -40) setSheetOpen(true); // swiped up → open the panel
  };
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

  // real live metric: how many events in the last 24 hours
  const dayAgo = Date.now() - 864e5;
  const last24h = incidents.filter(i => new Date(i.dt || i.occurred_at) >= dayAgo).length;
  const recent24 = useCounter(last24h);
  const stationCount = nearestStations && nearestStations.length ? nearestStations.length : 0;

  // distribution
  const cats = { Homicide:0, Assault:0, Robbery:0, Harassment:0, Stalking:0, Snatching:0, Theft:0 };
  incidents.forEach(i => { const l = TYPE_LABEL[i.type]; if (cats[l] != null) cats[l]++; });
  const total = Object.values(cats).reduce((a,b)=>a+b,0) || 1;

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
      <div className="sheet-handle" onClick={() => setSheetOpen(o => !o)}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="sheet-grip" />
        <div className="sheet-peek">Overview · Hotspots</div>
      </div>
      <div className="mobile-tabs" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
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
              <div className="panel-label"><span className="tick" />City Safety Overview</div>
              <div className="panel-label">{timeOfDay.toUpperCase()}</div>
            </div>
            <div className="score-card">
              <div className="score-row">
                <Gauge score={safetyScore} />
                <div className="score-meta">
                  <div className="score-status" style={{ color: col }}>{statusLabel}</div>
                  <div className="score-desc">{statusDesc}</div>
                  <div className="updated-chip"><span className="uc-dot" />Live · updates in real time</div>
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
                <div className="mlabel">Reports · 24h</div>
                <div className="mval">{recent24}</div>
                <div className="mfoot"><span style={{ color:'var(--teal)' }}>●</span> Live activity</div>
                <div className="accent-bar" />
              </div>
              <div className="metric" style={{ color:'var(--crimson-soft)' }}>
                <div className="mlabel">Nearest Station</div>
                {nearestStations && nearestStations.length ? (
                  <>
                    <div className="mval" style={{ fontSize:19 }}>{fmtDistance(nearestStations[0].distance_m)}</div>
                    <div className="mfoot" style={{ color:'var(--text-dim)' }}>{nearestStations[0].name}</div>
                  </>
                ) : (
                  <>
                    <div className="mval" style={{ fontSize:15 }}>—</div>
                    <div className="mfoot" style={{ color:'var(--amber)' }}>Enable location</div>
                  </>
                )}
                <div className="accent-bar" />
              </div>
            </div>
          </div>

          {/* Distribution */}
          <div className="block">
            <div className="block-head"><div className="panel-label"><span className="tick" />Incident Distribution</div></div>
            <div className="donut-wrap">
              <Donut cats={cats} total={total} />
              <div className="donut-legend">
                {Object.entries(cats).map(([k, v]) => {
                  const pct = Math.round(v / total * 100);
                  return (
                    <div key={k} className="dl-row">
                      <span className="dl-dot" style={{ background: DIST_COLORS[k] }} />
                      <span className="dl-name">{k}</span>
                      <span className="dl-pct">{pct}%</span>
                    </div>
                  );
                })}
              </div>
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
            <button className="route-btn" onClick={() => { onToggleRoute(); setSheetOpen(false); }}>
              <svg viewBox="0 0 24 24" width="15" fill="none" stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/>
                <path d="M8.5 19H14a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h5.5"/>
              </svg>
              {routeMode === 'pick-start' || routeMode === 'pick-end' ? 'Cancel' : routeShown ? 'Clear Route' : 'Plot Safest Route'}
            </button>
            {routeShown && !routePlan && (
              <div className="route-info">
                <div className="route-note">Tap the map: first your start point (A), then your destination (B). Routes are ranked against the live risk grid.</div>
              </div>
            )}
            {routePlan && (() => {
              const best = routePlan.routes[0];
              const km = (best.distance_m / 1000).toFixed(1);
              const min = Math.round(best.duration_s / 60);
              const riskLabel = best.risk < 20 ? 'Low' : best.risk < 50 ? 'Med' : 'High';
              const riskColor = best.risk < 20 ? 'var(--teal)' : best.risk < 50 ? 'var(--amber)' : 'var(--red)';
              return (
                <div className="route-info">
                  <div className="route-stats">
                    <div className="rstat"><div className="rv" style={{ color:'var(--teal)' }}>{km}<small style={{fontSize:9}}> km</small></div><div className="rl">Distance</div></div>
                    <div className="rstat"><div className="rv" style={{ color:'var(--amber)' }}>{min}<small style={{fontSize:9}}> min</small></div><div className="rl">Walk Time</div></div>
                    <div className="rstat"><div className="rv" style={{ color: riskColor }}>{riskLabel}</div><div className="rl">Risk {best.risk}/100</div></div>
                  </div>
                  <div className="route-note">
                    Safest of {routePlan.routes.length} route{routePlan.routes.length > 1 ? 's' : ''} · passes {best.hotspotHits} hot zone{best.hotspotHits === 1 ? '' : 's'} · via {routePlan.engine}. A data-based suggestion — stay alert.
                  </div>
                  {routePts?.start && routePts?.end && (
                    <a className="gmaps-btn"
                      href={gmapsUrl(routePts.start, routePts.end, best.coords)}
                      target="_blank" rel="noopener noreferrer">
                      <svg viewBox="0 0 24 24" width="13" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      Navigate in Google Maps
                    </a>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Nearest Police Stations (location-based) */}
          <div className="block">
            <div className="block-head">
              <div className="panel-label">
                <span className="tick" style={{ background:'var(--teal)', boxShadow:'0 0 8px var(--teal)' }} />
                Nearest Police Stations
              </div>
            </div>
            {(!nearestStations || nearestStations.length === 0) ? (
              <div className="loc-cta">
                <p>Share your location to see the closest stations and route to them. Your location stays on your device — it is never sent or stored.</p>
                <button className="loc-btn" onClick={onRequestLocation}
                  disabled={geoStatus === 'locating'}>
                  {geoStatus === 'locating' ? 'Locating…'
                    : geoStatus === 'denied' ? 'Location blocked — enable in browser'
                    : geoStatus === 'unavailable' ? 'Location unavailable'
                    : 'Enable location'}
                </button>
              </div>
            ) : (
              <div className="station-list">
                {nearestStations.slice(0, 4).map((s, i) => {
                  const mins = estimateDriveMinutes(s.distance_m);
                  return (
                    <div key={i} className="station-row">
                      <div className="st-info">
                        <div className="st-name">{s.name}</div>
                        <div className="st-meta">{fmtDistance(s.distance_m)} · ~{mins} min drive
                          <span className="st-tip" title="Estimated driving time from this station under normal traffic. This is NOT a guaranteed police response time — real response also depends on call handling, dispatch, and unit availability.">ⓘ</span>
                        </div>
                      </div>
                      <button className="st-route" onClick={() => onRouteToStation(s)}>Route</button>
                    </div>
                  );
                })}
                <div className="route-note" style={{ marginTop:8 }}>
                  Drive-time estimates are from the station under normal traffic — not a guaranteed police response time.
                </div>
              </div>
            )}
          </div>

          {/* Safety Protocols (data-conditional) */}
          <div className="block">
            <div className="block-head">
              <div className="panel-label">
                <span className="tick" style={{ background:'var(--amber)', boxShadow:'0 0 8px var(--amber)' }} />
                Safety Protocols
              </div>
            </div>
            <div className="protocol-list">
              {activeProtocols({
                snatch: incidents.filter(i => i.type === 'chain_snatching').length,
                nightRatio: ratio,
                topArea: top?.area,
                topScore: top?.score || 0,
                harassment: incidents.filter(i => i.type === 'harassment').length,
                stalking: incidents.filter(i => i.type === 'stalking').length,
                total: incidents.length,
              }, 4).map((text, i) => (
                <div key={i} className="protocol">
                  <svg viewBox="0 0 24 24" width="13" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/><path d="M9 12l2 2 4-4"/>
                  </svg>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Emergency Helplines */}
          <div className="block">
            <div className="block-head">
              <div className="panel-label">
                <span className="tick" style={{ background:'var(--crimson)', boxShadow:'0 0 8px var(--crimson)' }} />
                Emergency Helplines
              </div>
            </div>
            <div className="helpline-list">
              {HELPLINES.map((h) => (
                <a key={h.num} className="helpline" href={`tel:${h.num}`}>
                  <div className="hl-num">{h.num}</div>
                  <div className="hl-info">
                    <div className="hl-label">{h.label}</div>
                    <div className="hl-note">{h.note}</div>
                  </div>
                  <svg className="hl-call" viewBox="0 0 24 24" width="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8.1 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/>
                  </svg>
                </a>
              ))}
            </div>
          </div>
          <div className="block">
            <div className="block-head">
              <div className="panel-label"><span className="tick" />About SafeRaipur</div>
            </div>
            <div className="data-note">
              <div className="data-note-head">
                <svg viewBox="0 0 24 24" width="13" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                </svg>
                <span>How this works</span>
              </div>
              <p>
                Two data streams power this map. <b>News:</b> an automated pipeline
                scans English and Hindi news coverage of Raipur crime every 30
                minutes — tap any incident dot to open the original article.
                <b> Community:</b> anonymous reports submitted through this app,
                pushed live to every open map within a second. Community reports
                are labeled unverified and carry half weight until reviewed.
              </p>
              <p>
                <b>Privacy:</b> free public tool. No accounts, no tracking, no ads.
                Reports are anonymous. If you enable location, it is used only on
                your device for nearest-station and routing math — it is never sent
                to our servers or stored anywhere.
              </p>
              <p>
                <b>Honest limits:</b> this shows <b>reported</b> incidents only. Real
                numbers are far higher — most harassment is never reported. A quiet
                area is not a guaranteed safe area. Routes are suggestions ranked on
                historical data; stay alert regardless.
              </p>
              <div className="credit">
                Built by <b>Shivam</b> · <a href="mailto:cdrshivam@gmail.com">cdrshivam@gmail.com</a><br/>
                Feedback, corrections &amp; collaboration welcome.
              </div>
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

/** SVG donut — segments drawn as stroked circle arcs (dasharray magic). */
function Donut({ cats, total }) {
  const R = 40, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 110 110" className="donut">
      <circle cx="55" cy="55" r={R} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="13" />
      {Object.entries(cats).map(([k, v]) => {
        const frac = v / total;
        const seg = (
          <circle key={k} cx="55" cy="55" r={R} fill="none"
            stroke={DIST_COLORS[k]} strokeWidth="13"
            strokeDasharray={`${frac * C} ${C}`}
            strokeDashoffset={-offset * C}
            transform="rotate(-90 55 55)" strokeLinecap="butt" />
        );
        offset += frac;
        return seg;
      })}
      <text x="55" y="52" textAnchor="middle" className="donut-num">{total}</text>
      <text x="55" y="66" textAnchor="middle" className="donut-sub">incidents</text>
    </svg>
  );
}

function HotspotCards({ hotspots }) {
  return (
    <div className="hs-list">
      {hotspots.slice(0,7).map((h,i) => <HotspotCard key={i} h={h} />)}
    </div>
  );
}

export function HotspotCard({ h, rank }) {
  const col = h.score >= 60 ? '#FF3B5C' : h.score >= 30 ? '#FFA63D' : '#2DD4BF';
  const lvl = h.score >= 60 ? 'Critical' : h.score >= 30 ? 'Elevated' : 'Moderate';
  const recent = [...(h.items || [])].sort((a,b) => new Date(b.dt||b.occurred_at) - new Date(a.dt||a.occurred_at)).slice(0,3);
  return (
    <div className="hs-card" style={{ color: col }}>
      {rank && <span className="hs-rank" style={{ borderColor: col, color: col }}>{rank}</span>}
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