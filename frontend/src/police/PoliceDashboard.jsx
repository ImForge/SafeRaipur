import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase.js';
import './police.css';

/**
 * PoliceDashboard — the control-room panel.
 *
 * Mounted at /police (see POLICE_DASHBOARD_SETUP.md). A station pastes its
 * secret once; from then on this machine IS that station's dashboard.
 *
 * Design thesis: a control room is not a consumer app. It's a room with a
 * screen on the wall, someone glancing at it between phone calls. So:
 *   • ONE card at a time per offer — the anti-flood design made visible.
 *     No infinite scroll of the whole city's misery.
 *   • The countdown is the point: if nobody touches it, it auto-passes to the
 *     next nearest station. Ignoring is a valid, safe action.
 *   • DURESS cases scream. A silent alarm under coercion is not the same
 *     thing as a panic button press, and must never look the same.
 *   • Surge flags sit above everything: 4 alarms in 1.5km in an hour is a
 *     pattern, not four coincidences.
 */
export default function PoliceDashboard() {
  const [secret, setSecret] = useState(localStorage.getItem('sr_station_secret') || '');
  const [input, setInput] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [now, setNow] = useState(Date.now());
  const timerRef = useRef(null);

  // ticking clock for the countdown rings
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const pull = useCallback(async () => {
    if (!secret || !supabase) return;
    try {
      const { data: d, error } = await supabase.rpc('station_dashboard', { p_secret: secret });
      if (error) throw error;
      if (!d?.ok) { setErr(d?.error || 'Unknown station'); return; }
      setData(d); setErr(null);
    } catch (e) {
      setErr('Connection lost — retrying');
    }
  }, [secret]);

  useEffect(() => {
    if (!secret) return;
    pull();
    timerRef.current = setInterval(pull, 4000);
    return () => clearInterval(timerRef.current);
  }, [secret, pull]);

  const respond = async (offerId, action, note) => {
    setBusy(offerId);
    try {
      await supabase.rpc('station_respond', {
        p_secret: secret, p_offer_id: offerId, p_action: action, p_note: note || null,
      });
      await pull();
    } catch { setErr('Could not send response'); }
    finally { setBusy(null); }
  };

  const signIn = () => {
    const s = input.trim();
    if (!s) return;
    localStorage.setItem('sr_station_secret', s);
    setSecret(s);
  };
  const signOut = () => {
    localStorage.removeItem('sr_station_secret');
    setSecret(''); setData(null);
  };

  // ---------- sign-in ----------
  if (!secret) {
    return (
      <div className="pol-root pol-login">
        <div className="pol-login-box">
          <div className="pol-badge">◈</div>
          <h1>Guardian Dispatch</h1>
          <p>Enter your station key to activate this dashboard.</p>
          <input
            value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="station key" autoComplete="off" spellCheck="false"
            onKeyDown={(e) => e.key === 'Enter' && signIn()}
          />
          <button onClick={signIn}>Activate</button>
          <p className="pol-login-hint">
            Issued by SafeRaipur when your station was registered. Stored on this
            device only.
          </p>
        </div>
      </div>
    );
  }

  const offers = data?.offers || [];
  const surges = data?.surges || [];
  const engineOk = data?.engine?.healthy !== false;

  return (
    <div className="pol-root">
      <header className="pol-head">
        <div className="pol-id">
          <span className="pol-badge sm">◈</span>
          <div>
            <div className="pol-station">{data?.station?.name || '—'}</div>
            <div className="pol-sub">Guardian Dispatch</div>
          </div>
        </div>
        <div className="pol-stats">
          <Stat n={data?.stats?.live_emergencies} l="live city-wide" />
          <Stat n={data?.stats?.assigned_to_me} l="assigned to us" />
          <Stat n={data?.stats?.unassigned} l="unassigned" warn />
        </div>
        <button className="pol-out" onClick={signOut}>sign out</button>
      </header>

      {!engineOk && (
        <div className="pol-alarm">
          ⚠ DISPATCH ENGINE NOT RESPONDING — alerts may be delayed. Escalate manually.
        </div>
      )}
      {err && <div className="pol-err">{err}</div>}

      {surges.length > 0 && (
        <section className="pol-surges">
          <h2>⚠ Pattern detected</h2>
          {surges.map((s, i) => (
            <div key={i} className="pol-surge">
              <b>{s.emergency_count} alarms</b> within {(s.radius_m / 1000).toFixed(1)} km
              in the last {s.window_minutes} min
              <a
                href={`https://maps.google.com/?q=${s.lat},${s.lng}`}
                target="_blank" rel="noreferrer"
              >view area →</a>
            </div>
          ))}
        </section>
      )}

      <main className="pol-main">
        {offers.length === 0 && (
          <div className="pol-idle">
            <div className="pol-idle-ring" />
            <p>No cases routed to this station.</p>
            <span>Standing by · updates every few seconds</span>
          </div>
        )}

        {offers.map((o) => (
          <OfferCard
            key={o.offer_id} o={o} now={now} busy={busy === o.offer_id}
            onAccept={() => respond(o.offer_id, 'accept')}
            onDecline={(reason) => respond(o.offer_id, 'decline', reason)}
          />
        ))}
      </main>
    </div>
  );
}

function Stat({ n, l, warn }) {
  return (
    <div className={`pol-stat ${warn && n > 0 ? 'warn' : ''}`}>
      <span>{n ?? '—'}</span><label>{l}</label>
    </div>
  );
}

const DECLINE_REASONS = ['All units engaged', 'Out of jurisdiction', 'Already responding elsewhere'];

function OfferCard({ o, now, busy, onAccept, onDecline }) {
  const [showReasons, setShowReasons] = useState(false);
  const e = o.emergency;
  const secsLeft = o.expires_at
    ? Math.max(0, Math.round((new Date(o.expires_at).getTime() - now) / 1000))
    : null;
  const mm = secsLeft != null ? String(Math.floor(secsLeft / 60)).padStart(2, '0') : '--';
  const ss = secsLeft != null ? String(secsLeft % 60).padStart(2, '0') : '--';

  return (
    <article className={`pol-card ${e.duress ? 'is-duress' : ''} ${o.assigned ? 'is-assigned' : ''}`}>
      {e.duress && (
        <div className="pol-duress-flag">
          ⚠ SILENT ALARM — victim was forced to fake a cancellation. Treat as highest risk.
        </div>
      )}

      <div className="pol-card-top">
        <div>
          <div className="pol-victim">{e.victim}</div>
          <div className="pol-meta">
            {o.distance_km != null ? `${o.distance_km} km away` : 'location unknown'}
            {' · '}{timeAgo(e.created_at, now)}
          </div>
        </div>
        {!o.assigned && (
          <div className="pol-timer">
            <span>{mm}:{ss}</span>
            <label>auto-passes on</label>
          </div>
        )}
        {o.assigned && <div className="pol-assigned-tag">ASSIGNED TO US</div>}
      </div>

      <div className="pol-facts">
        <Fact k="Phone" v={<a href={`tel:${e.phone}`}>{e.phone}</a>} />
        <Fact k="Location" v={
          e.lat
            ? <a href={`https://maps.google.com/?q=${e.lat},${e.lng}`} target="_blank" rel="noreferrer">
                open map →
              </a>
            : <span className="pol-bad">not shared</span>
        } />
        <Fact k="Contacts reached" v={
          e.contact_reached
            ? <span className="pol-ok">✓ delivered</span>
            : <span className="pol-bad">✗ NOBODY REACHED</span>
        } />
        <Fact k="Responder" v={
          e.acked_by
            ? <>{e.acked_by.name}{' '}
                <em className={e.acked_by.verified ? 'pol-ok' : 'pol-warn'}>
                  ({e.acked_by.channel}{e.acked_by.verified ? ' ✓ verified' : ' unverified'})
                </em></>
            : <span className="pol-warn">none yet</span>
        } />
        {e.note && <Fact k="Note" v={e.note} />}
      </div>

      {!o.assigned && (
        <div className="pol-actions">
          <button className="pol-accept" disabled={busy} onClick={onAccept}>
            {busy ? '…' : 'ACCEPT — we are responding'}
          </button>
          <button className="pol-decline" disabled={busy}
            onClick={() => setShowReasons((v) => !v)}>
            Decline
          </button>
        </div>
      )}

      {showReasons && !o.assigned && (
        <div className="pol-reasons">
          {DECLINE_REASONS.map((r) => (
            <button key={r} onClick={() => onDecline(r)}>{r}</button>
          ))}
          <p>Declining passes this case to the next nearest station immediately.</p>
        </div>
      )}
    </article>
  );
}

function Fact({ k, v }) {
  return <div className="pol-fact"><label>{k}</label><div>{v}</div></div>;
}

function timeAgo(iso, now) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
