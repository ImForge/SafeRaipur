import { useState } from 'react';

/**
 * Welcome — shows on EVERY visit (product decision: orientation + live
 * surge awareness gate). If surges are active, the popup carries a red
 * strip so people see "something is happening" before the map even loads.
 */
export default function Welcome({ alerts = [], onViewAlert }) {
  const [show, setShow] = useState(true);
  if (!show) return null;
  const dismiss = () => setShow(false);
  const surge = alerts[0];
  return (
    <div className="welcome-overlay" onClick={dismiss}>
      <div className="welcome-card glass" onClick={(e) => e.stopPropagation()}>
        <div className="wc-logo">🛡</div>
        <h2>SafeRaipur</h2>
        <p className="wc-sub">Live city safety grid</p>

        {surge && (
          <button className="wc-surge" onClick={() => { dismiss(); onViewAlert?.(surge); }}>
            <span className="sb-pulse" />
            <span className="wc-surge-text">
              MASS REPORTS{surge.area ? ` near ${surge.area}` : ''} — {surge.report_count} incidents in ~6h.
              Tap to view &amp; help confirm.
            </span>
          </button>
        )}

        <div className="wc-points">
          <div className="wc-point">
            <span className="wc-ico" style={{ color:'#FF6178' }}>◉</span>
            <span><b>See</b> — the heatmap shows where incidents concentrate, from news + community reports. Tap any dot for details and the source.</span>
          </div>
          <div className="wc-point">
            <span className="wc-ico" style={{ color:'#FFA63D' }}>▲</span>
            <span><b>Report</b> — witnessed something? Tap "Report Incident", then the location. 100% anonymous, appears live for everyone.</span>
          </div>
          <div className="wc-point">
            <span className="wc-ico" style={{ color:'#2DD4BF' }}>➜</span>
            <span><b>Route</b> — "Plot Safest Route" compares paths against the risk map and picks the safest way.</span>
          </div>
        </div>
        <button className="wc-btn" onClick={dismiss}>Explore the map</button>
        <p className="wc-fine">Free · anonymous · your location never leaves your device</p>
      </div>
    </div>
  );
}
