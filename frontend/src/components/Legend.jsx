import { useState } from 'react';

/**
 * Map legend — collapsed chip by default, expands on tap.
 * A public map without a legend is a puzzle; this is the decoder ring.
 */
export default function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`legend ${open ? 'open' : ''}`}>
      <button className="legend-chip" onClick={() => setOpen(o => !o)}>
        {open ? '✕ Close' : 'ⓘ Legend'}
      </button>
      {open && (
        <div className="legend-body glass">
          <div className="lg-row">
            <span className="lg-heat" />
            <span>Risk heat — brighter = more reported incidents</span>
          </div>
          <div className="lg-row">
            <span className="lg-dot" style={{ background:'#FF3B5C' }} />
            <span>Incident (tap for details &amp; news source)</span>
          </div>
          <div className="lg-row">
            <span className="lg-beacon" />
            <span>Hotspot — cluster of recent incidents</span>
          </div>
          <div className="lg-row">
            <span className="lg-station" />
            <span>Police station</span>
          </div>
          <div className="lg-row">
            <span className="lg-surge" />
            <span>Surge — unusual activity right now</span>
          </div>
          <div className="lg-row">
            <span className="lg-you" />
            <span>You (location stays on your device)</span>
          </div>
        </div>
      )}
    </div>
  );
}
