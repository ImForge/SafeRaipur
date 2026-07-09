import { useState } from 'react';

/**
 * Welcome — shows on startup unless the person turned it off.
 * Reopen anytime by tapping the shield logo in the top bar.
 */
export default function Welcome({ open, onClose, alerts = [], onViewAlert }) {
  const [hide, setHide] = useState(() => localStorage.getItem('sr_hide_welcome') === '1');
  if (!open) return null;
  const surge = alerts[0];
  const toggleHide = (e) => {
    const v = e.target.checked;
    setHide(v);
    localStorage.setItem('sr_hide_welcome', v ? '1' : '0');
  };
  return (
    <div className="welcome-overlay" onClick={onClose}>
      <div className="welcome-card glass" onClick={(e) => e.stopPropagation()}>
        <div className="wc-logo">🛡</div>
        <h2>SafeRaipur</h2>
        <p className="wc-sub">Live city safety grid</p>

        {surge && (
          <button className="wc-surge" onClick={() => { onClose(); onViewAlert?.(surge); }}>
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
        <button className="wc-btn" onClick={onClose}>Explore the map</button>
        <label className="wc-toggle">
          <input type="checkbox" checked={hide} onChange={toggleHide} />
          <span>Don't show this on startup <em>(tap the shield logo to reopen anytime)</em></span>
        </label>
        <p className="wc-fine">Free · anonymous · your location never leaves your device</p>
      </div>
    </div>
  );
}
