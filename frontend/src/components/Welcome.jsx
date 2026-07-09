import { useState } from 'react';

/**
 * First-visit welcome — three sentences, one button, never again.
 * (localStorage flag; bump the key to re-show after major redesigns.)
 */
export default function Welcome() {
  const [show, setShow] = useState(() => !localStorage.getItem('sr_onboarded_v1'));
  if (!show) return null;
  const dismiss = () => { localStorage.setItem('sr_onboarded_v1', '1'); setShow(false); };
  return (
    <div className="welcome-overlay" onClick={dismiss}>
      <div className="welcome-card glass" onClick={(e) => e.stopPropagation()}>
        <div className="wc-logo">🛡</div>
        <h2>SafeRaipur</h2>
        <p className="wc-sub">Live city safety grid</p>
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
