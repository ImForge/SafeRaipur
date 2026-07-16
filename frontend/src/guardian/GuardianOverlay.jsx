import { useState, useEffect, useRef, useCallback } from 'react';
import { guardianApi, guardianStore } from './guardianApi.js';
import { supabase } from '../lib/supabase.js';
import './guardian.css';

/**
 * GuardianOverlay — the screen a person in danger sees.
 *
 * Design thesis: SUBTRACTION. SafeRaipur's normal UI is a dense dark-ops
 * dashboard. The instant Guardian is armed, ALL of it disappears — map,
 * panels, blooms, mono labels, everything — and is replaced by solid black
 * and exactly one job per screen. The most feature-rich part of the app
 * becomes the emptiest, because a person running one-handed at night cannot
 * parse a dashboard. That contrast is the whole design.
 *
 * Three states, nothing else:
 *   READY     — one giant hold-to-send button. Nothing to read, nothing to
 *               tap by accident.
 *   COUNTDOWN — a shrinking ring; "I'M SAFE" (PIN) or "SEND NOW".
 *   LIVE      — plain human sentences of what's happening + a permanent
 *               CALL 112 button. Never any system jargon.
 *
 * The overlay owns nothing about escalation logic — the database does. It
 * triggers, it polls status, it renders. Fail-loud: if the gateway was dead
 * at trigger time, the first LIVE line is red and says DIAL 112 YOURSELF.
 */
export default function GuardianOverlay({ onExit }) {
  // screen: 'ready' | 'countdown' | 'live'
  const [screen, setScreen] = useState('ready');
  const [emergencyId, setEmergencyId] = useState(null);
  const [status, setStatus] = useState(null);      // full guardian_status payload
  const [countdownLeft, setCountdownLeft] = useState(null);
  const [gatewayOk, setGatewayOk] = useState(true);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinError, setPinError] = useState(null);
  const [banner, setBanner] = useState(null);       // transient error line
  const locationRef = useRef({ lat: null, lng: null });
  const pollRef = useRef(null);
  const deadlineRef = useRef(null);

  // ---- resume an in-flight emergency after a lock/reload ----
  useEffect(() => {
    const active = guardianStore.activeEmergency();
    if (active) { setEmergencyId(active); setScreen('live'); }
  }, []);

  // ---- best-effort location (never blocks the trigger) ----
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => { locationRef.current = { lat: p.coords.latitude, lng: p.coords.longitude }; },
      () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // ================= TRIGGER =================
  const fireTrigger = useCallback(async () => {
    setBanner(null);
    try {
      const { lat, lng } = locationRef.current;
      const res = await guardianApi.trigger(lat, lng, null);
      if (!res?.ok) { setBanner(res?.error || 'Could not start. Call 112 now.'); return; }

      setEmergencyId(res.emergency_id);
      guardianStore.setActiveEmergency(res.emergency_id);
      setGatewayOk(res.gateway_ok !== false);

      if (res.status === 'countdown') {
        deadlineRef.current = new Date(res.cancel_deadline).getTime();
        setScreen('countdown');
      } else {
        // already active / fast-forwarded (second press)
        setScreen('live');
      }
    } catch {
      // Fail loud: the network is the only thing that can break here.
      setBanner('No connection. Call 112 now — do not wait for the app.');
    }
  }, []);

  // ================= COUNTDOWN TICK =================
  useEffect(() => {
    if (screen !== 'countdown') return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setCountdownLeft(left);
      if (left <= 0) setScreen('live'); // engine will have escalated; show LIVE
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [screen]);

  // ================= LIVE POLL + REALTIME =================
  // Realtime pushes state changes instantly; a slow poll is the safety net
  // in case the socket drops (which, on a phone losing signal, it will).
  useEffect(() => {
    if (screen !== 'live' && screen !== 'countdown') return;
    if (!emergencyId) return;

    let stop = false;
    const pull = async () => {
      try {
        const s = await guardianApi.status(emergencyId);
        if (stop || !s?.ok) return;
        setStatus(s);
        setGatewayOk(s.gateway_ok !== false);
        if (['resolved', 'cancelled'].includes(s.status)) {
          guardianStore.setActiveEmergency(null);
        }
      } catch { /* keep last known state on screen; never blank out */ }
    };
    pull();
    pollRef.current = setInterval(pull, 4000);

    // realtime: the emergencies row is in the supabase_realtime publication
    let channel = null;
    if (supabase) {
      channel = supabase
        .channel(`emergency_${emergencyId}`)
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'emergencies',
            filter: `id=eq.${emergencyId}` },
          () => pull())
        .subscribe();
    }
    return () => {
      stop = true;
      clearInterval(pollRef.current);
      if (channel && supabase) supabase.removeChannel(channel);
    };
  }, [screen, emergencyId]);

  // ================= PIN SUBMIT (cancel / duress) =================
  const submitPin = useCallback(async (pin) => {
    setPinError(null);
    try {
      const res = await guardianApi.cancel(emergencyId, pin);
      if (res?.ok) {
        // NOTE: a duress PIN also returns ok:true with 'cancelled' — that is
        // BY DESIGN (0003 A2). The UI must treat both identically and show
        // the safe screen; the backend keeps escalating silently.
        guardianStore.setActiveEmergency(null);
        setPinOpen(false);
        setScreen('ready');
        setStatus(null);
        setEmergencyId(null);
      } else {
        setPinError(res?.error || 'Wrong PIN');
      }
    } catch {
      setPinError('No connection — try again, or call 112');
    }
  }, [emergencyId]);

  const call112 = () => { window.location.href = 'tel:112'; };

  // ============================================================ RENDER
  return (
    <div className="grd-root" role="region" aria-label="Guardian emergency mode">
      <button className="grd-exit" onClick={onExit} aria-label="Close Guardian Mode">✕</button>

      {screen === 'ready' && (
        <ReadyScreen onHoldComplete={fireTrigger} banner={banner} onCall112={call112} />
      )}

      {screen === 'countdown' && (
        <CountdownScreen
          left={countdownLeft}
          total={60}
          onSafe={() => { setPinError(null); setPinOpen(true); }}
          onSendNow={fireTrigger}
        />
      )}

      {screen === 'live' && (
        <LiveScreen
          status={status}
          gatewayOk={gatewayOk}
          onSafe={() => { setPinError(null); setPinOpen(true); }}
          onCall112={call112}
        />
      )}

      {pinOpen && (
        <PinPad
          onSubmit={submitPin}
          onClose={() => setPinOpen(false)}
          error={pinError}
        />
      )}
    </div>
  );
}

/* ────────────────────────── READY ────────────────────────── */
function ReadyScreen({ onHoldComplete, banner, onCall112 }) {
  const HOLD_MS = 2000; // a hold is a decision; a tap is an accident
  const [progress, setProgress] = useState(0);
  const raf = useRef(null);
  const startRef = useRef(null);

  const begin = () => {
    startRef.current = Date.now();
    if (navigator.vibrate) navigator.vibrate(20);
    const step = () => {
      const p = Math.min(1, (Date.now() - startRef.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) { if (navigator.vibrate) navigator.vibrate([40, 60, 120]); onHoldComplete(); return; }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const end = () => { cancelAnimationFrame(raf.current); setProgress(0); startRef.current = null; };

  return (
    <div className="grd-screen grd-ready">
      <p className="grd-tagline">Hold the button to alert your people</p>

      <button
        className="grd-sos"
        style={{ '--p': progress }}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        aria-label="Hold for two seconds to send an emergency alert"
      >
        <svg className="grd-sos-ring" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="grd-sos-track" cx="100" cy="100" r="92" />
          <circle className="grd-sos-fill" cx="100" cy="100" r="92"
            style={{ strokeDashoffset: 578 - 578 * progress }} />
        </svg>
        <span className="grd-sos-label">
          {progress > 0 ? 'KEEP HOLDING' : 'SOS'}
        </span>
      </button>

      <p className="grd-hint">Hold for 2 seconds</p>

      {banner && <p className="grd-banner-err">{banner}</p>}

      <button className="grd-112-link" onClick={onCall112}>
        or call 112 now
      </button>
    </div>
  );
}

/* ──────────────────────── COUNTDOWN ──────────────────────── */
function CountdownScreen({ left, total, onSafe, onSendNow }) {
  const frac = total ? Math.max(0, Math.min(1, left / total)) : 0;
  const CIRC = 578;
  return (
    <div className="grd-screen grd-countdown">
      <p className="grd-cd-lead">Alerting your contacts in</p>

      <div className="grd-cd-ring">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <circle className="grd-cd-track" cx="100" cy="100" r="92" />
          <circle className="grd-cd-fill" cx="100" cy="100" r="92"
            style={{ strokeDashoffset: CIRC - CIRC * frac }} />
        </svg>
        <span className="grd-cd-num" aria-live="polite">{left ?? total}</span>
      </div>

      <p className="grd-cd-sub">Tap “I’m safe” if this was a mistake</p>

      <div className="grd-cd-actions">
        <button className="grd-btn grd-btn-safe" onClick={onSafe}>I’m safe</button>
        <button className="grd-btn grd-btn-now" onClick={onSendNow}>Send now</button>
      </div>
    </div>
  );
}

/* ────────────────────────── LIVE ─────────────────────────── */
// Turns raw emergency_events into plain human sentences. NO system jargon
// ever reaches the screen — "LEVEL_2" becomes "Calling your 2nd contact".
function humanize(ev, status) {
  const d = ev.detail || {};
  if (/^LEVEL_\d$/.test(ev.event)) {
    const first = ev.event === 'LEVEL_1';
    return { icon: '📞', text: `Calling ${d.called || (first ? 'your first contact' : 'your next contact')}…`, tone: 'go' };
  }
  switch (ev.event) {
    case 'TRIGGERED':      return { icon: '📡', text: 'Alert started', tone: 'go' };
    case 'ACKNOWLEDGED':   return { icon: '✓', text: `${d.by || 'Someone'} is coming to help`, tone: 'ack' };
    case 'ESCALATED_112':  return { icon: '🚨', text: 'No one answered — your contacts were told to call 112', tone: 'warn' };
    case 'RESOLVED':       return { icon: '✓', text: 'Marked safe', tone: 'ack' };
    // internal receipts + attacker-defense events never reach her screen
    case 'CMD_DONE': case 'CMD_FAILED': case 'PIN_FAIL':
    case 'PIN_BRUTE_LOCKOUT': case 'DURESS_SUSPECTED': case 'DURESS_PIN_USED':
    case 'PIN_LOCKED_ATTEMPT': case 'RETRIGGERED':
    default:               return null;
  }
}

function LiveScreen({ status, gatewayOk, onSafe, onCall112 }) {
  const events = status?.events || [];
  const lines = events.map((e) => humanize(e, status)).filter(Boolean);
  const acked = status?.status === 'acknowledged';
  const to112 = status?.status === 'escalated_112';

  return (
    <div className={`grd-screen grd-live ${acked ? 'is-acked' : ''} ${to112 ? 'is-112' : ''}`}>
      {/* fail-loud degraded banner (0002/0003): gateway dead at trigger */}
      {!gatewayOk && (
        <div className="grd-degraded">
          System can’t reach the alert network. <b>Call 112 yourself now.</b>
        </div>
      )}

      <div className="grd-live-head">
        {acked ? (
          <>
            <div className="grd-live-title grd-title-ack">Help is coming</div>
            <div className="grd-live-sub">Someone confirmed they’re on the way. Stay where you can be found.</div>
          </>
        ) : to112 ? (
          <>
            <div className="grd-live-title grd-title-112">Call 112 now</div>
            <div className="grd-live-sub">No contact responded. Emergency services are your fastest help.</div>
          </>
        ) : (
          <>
            <div className="grd-live-title">Alerting your people…</div>
            <div className="grd-live-sub">Keep moving toward a safe, public place.</div>
          </>
        )}
      </div>

      <ul className="grd-feed" aria-live="polite">
        {lines.length === 0 && <li className="grd-feed-empty">Starting…</li>}
        {lines.map((l, i) => (
          <li key={i} className={`grd-feed-line tone-${l.tone}`}>
            <span className="grd-feed-icon">{l.icon}</span>{l.text}
          </li>
        ))}
      </ul>

      <div className="grd-live-actions">
        <button className="grd-btn grd-btn-112" onClick={onCall112}>Call 112</button>
        <button className="grd-btn grd-btn-safe-sm" onClick={onSafe}>I’m safe</button>
      </div>
    </div>
  );
}

/* ────────────────────────── PIN PAD ──────────────────────── */
// Big keys, thumb-reachable, no number preview beyond dots. Submits on the
// 4th–6th digit via the check button. The backend distinguishes real vs
// duress vs wrong — this pad is deliberately dumb about which is which.
function PinPad({ onSubmit, onClose, error }) {
  const [pin, setPin] = useState('');
  const press = (n) => { if (pin.length < 6) setPin(pin + n); };
  const back = () => setPin(pin.slice(0, -1));
  const go = () => { if (pin.length >= 4) onSubmit(pin); };

  return (
    <div className="grd-pin-scrim" role="dialog" aria-label="Enter your PIN to mark safe">
      <div className="grd-pin">
        <button className="grd-pin-close" onClick={onClose} aria-label="Back">✕</button>
        <p className="grd-pin-lead">Enter your PIN to stop the alert</p>

        <div className="grd-pin-dots">
          {[0,1,2,3,4,5].map(i => (
            <span key={i} className={`grd-dot ${i < pin.length ? 'on' : ''} ${i >= 4 ? 'opt' : ''}`} />
          ))}
        </div>

        {error && <p className="grd-pin-err">{error}</p>}

        <div className="grd-pin-grid">
          {[1,2,3,4,5,6,7,8,9].map(n => (
            <button key={n} className="grd-key" onClick={() => press(String(n))}>{n}</button>
          ))}
          <button className="grd-key grd-key-ghost" onClick={back} aria-label="Delete">⌫</button>
          <button className="grd-key" onClick={() => press('0')}>0</button>
          <button className="grd-key grd-key-go" onClick={go} disabled={pin.length < 4} aria-label="Confirm">✓</button>
        </div>
      </div>
    </div>
  );
}
