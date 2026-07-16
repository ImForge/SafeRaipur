import { useState, useEffect } from 'react';
import { guardianStore } from './guardianApi.js';
import GuardianOverlay from './GuardianOverlay.jsx';
import GuardianEnroll from './GuardianEnroll.jsx';
import './guardianTrigger.css';

/**
 * GuardianButton — the ONLY Guardian surface visible on the normal map.
 *
 * A single always-reachable shield in the corner. Tapping it:
 *   • if enrolled  → opens the panic overlay (READY screen)
 *   • if not       → opens the one-time enrollment flow
 *
 * While the overlay is open it renders over the entire app (z 9999), so the
 * SENTINEL dashboard is fully hidden — she never sees the features, only
 * what could save her. The button lives in App.jsx alongside <Dock/>.
 */
export default function GuardianButton() {
  const [mode, setMode] = useState(null); // null | 'enroll' | 'armed'
  const [enrolled, setEnrolled] = useState(guardianStore.isEnrolled());

  // keep enrolled flag fresh if enrollment completes
  useEffect(() => {
    if (mode === null) setEnrolled(guardianStore.isEnrolled());
  }, [mode]);

  const open = () => setMode(guardianStore.isEnrolled() ? 'armed' : 'enroll');

  return (
    <>
      <button className="grd-fab" onClick={open}
        aria-label={enrolled ? 'Open Guardian emergency mode' : 'Set up Guardian Mode'}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <span className="grd-fab-label">{enrolled ? 'Guardian' : 'Guardian · set up'}</span>
      </button>

      {mode === 'armed' && <GuardianOverlay onExit={() => setMode(null)} />}
      {mode === 'enroll' && (
        <GuardianEnroll
          onDone={() => { setEnrolled(true); setMode('armed'); }}
          onCancel={() => setMode(null)}
        />
      )}
    </>
  );
}
