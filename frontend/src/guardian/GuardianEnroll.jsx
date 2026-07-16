import { useState } from 'react';
import { guardianApi, guardianStore } from './guardianApi.js';
import './guardian.css';
import './guardianEnroll.css';

/**
 * GuardianEnroll — the CALM-DAY setup, done once at home.
 *
 * Deliberately separate from the crisis screens: this is where all the
 * "features" live (phone verify, PIN, duress PIN, contacts) so that the
 * panic screens can stay empty. A person sets this up relaxed, in advance;
 * the panic UI never asks her to configure anything.
 *
 * Steps: phone → OTP → PIN (+ optional duress PIN) → contacts → done.
 */
const STEPS = ['phone', 'otp', 'pin', 'contacts', 'done'];

export default function GuardianEnroll({ onDone, onCancel }) {
  const [step, setStep] = useState('phone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const [phone, setPhone] = useState('');
  const [name, setName]   = useState('');
  const [otp, setOtp]     = useState('');
  const [pin, setPin]     = useState('');
  const [duress, setDuress] = useState('');
  const [contacts, setContacts] = useState([{ name: '', phone: '' }]);

  const go = (s) => { setErr(null); setStep(s); };

  // ---- step handlers ----
  const doRegister = async () => {
    if (!name.trim()) return setErr('Enter your name');
    if (phone.replace(/\D/g, '').length < 10) return setErr('Enter a valid phone number');
    if (!/^\d{4,6}$/.test(pin)) return setErr('PIN must be 4–6 digits');
    setBusy(true); setErr(null);
    try {
      const res = await guardianApi.register(phone, name, pin);
      if (!res?.ok) { setErr(res?.error || 'Could not send code'); return; }
      if (res.gateway_ok === false)
        setErr('Heads up: the alert network looks offline right now. You can still finish setup.');
      go('otp');
    } catch { setErr('No connection — try again'); }
    finally { setBusy(false); }
  };

  const doVerify = async () => {
    if (!/^\d{6}$/.test(otp)) return setErr('Enter the 6-digit code');
    setBusy(true); setErr(null);
    try {
      const res = await guardianApi.verify(phone, otp);
      if (!res?.ok) { setErr(res?.error || 'Wrong or expired code'); return; }
      guardianStore.setSecret(res.device_secret);
      guardianStore.setUser({ user_id: res.user_id, name, phone });
      // optional duress PIN is set on the pin step; jump there
      go('pin');
    } catch { setErr('No connection — try again'); }
    finally { setBusy(false); }
  };

  const doSetDuress = async () => {
    // duress is OPTIONAL — empty just skips it
    if (duress && !/^\d{4,6}$/.test(duress)) return setErr('Duress PIN must be 4–6 digits');
    if (duress && duress === pin) return setErr('Duress PIN must be different from your real PIN');
    setBusy(true); setErr(null);
    try {
      if (duress) {
        const res = await guardianApi.setDuressPin(pin, duress);
        if (!res?.ok) { setErr(res?.error || 'Could not set duress PIN'); return; }
      }
      go('contacts');
    } catch { setErr('No connection — try again'); }
    finally { setBusy(false); }
  };

  const doContacts = async () => {
    const valid = contacts.filter(c => c.name.trim() && c.phone.replace(/\D/g, '').length >= 10);
    if (valid.length === 0) return setErr('Add at least one contact');
    setBusy(true); setErr(null);
    try {
      for (let i = 0; i < valid.length; i++) {
        const res = await guardianApi.addContact(valid[i].name, valid[i].phone, i + 1);
        if (!res?.ok) { setErr(res?.error || `Could not add ${valid[i].name}`); return; }
      }
      go('done');
    } catch { setErr('No connection — try again'); }
    finally { setBusy(false); }
  };

  const updateContact = (i, k, v) =>
    setContacts(cs => cs.map((c, j) => j === i ? { ...c, [k]: v } : c));
  const addRow = () => setContacts(cs => cs.length < 5 ? [...cs, { name: '', phone: '' }] : cs);

  return (
    <div className="grd-root grd-enroll-root">
      <button className="grd-exit" onClick={onCancel} aria-label="Close setup">✕</button>

      <div className="grd-enroll">
        <div className="grd-enroll-steps" aria-hidden="true">
          {STEPS.slice(0, 4).map((s, i) => (
            <span key={s} className={`grd-step-dot ${STEPS.indexOf(step) >= i ? 'on' : ''}`} />
          ))}
        </div>

        {step === 'phone' && (
          <section className="grd-enroll-body">
            <h1 className="grd-enroll-h1">Set up Guardian</h1>
            <p className="grd-enroll-p">If you’re ever in danger, one button alerts the people you trust — by call and text — and escalates on its own until someone responds.</p>
            <label className="grd-field"><span>Your name</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Priya" autoComplete="name" /></label>
            <label className="grd-field"><span>Your phone</span>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="98765 43210" inputMode="tel" autoComplete="tel" /></label>
            <label className="grd-field"><span>Create a PIN (to stop a false alarm)</span>
              <input value={pin} onChange={e => setPin(e.target.value.replace(/\D/g,''))} placeholder="4–6 digits" inputMode="numeric" maxLength={6} type="password" /></label>
            {err && <p className="grd-enroll-err">{err}</p>}
            <button className="grd-btn grd-btn-now" disabled={busy} onClick={doRegister}>
              {busy ? 'Sending code…' : 'Send verification code'}</button>
          </section>
        )}

        {step === 'otp' && (
          <section className="grd-enroll-body">
            <h1 className="grd-enroll-h1">Enter the code</h1>
            <p className="grd-enroll-p">We texted a 6-digit code to {phone}. This proves the number is yours.</p>
            <input className="grd-otp-input" value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
              placeholder="000000" inputMode="numeric" maxLength={6} />
            {err && <p className="grd-enroll-err">{err}</p>}
            <button className="grd-btn grd-btn-now" disabled={busy} onClick={doVerify}>
              {busy ? 'Checking…' : 'Verify'}</button>
            <button className="grd-enroll-link" onClick={doRegister}>Resend code</button>
          </section>
        )}

        {step === 'pin' && (
          <section className="grd-enroll-body">
            <h1 className="grd-enroll-h1">Add a safety PIN</h1>
            <p className="grd-enroll-p">Optional but recommended. A <b>duress PIN</b> is a second, different PIN. If someone forces you to stop the alert, enter this one instead — the screen will look like it stopped, but your contacts and the system keep working.</p>
            <label className="grd-field"><span>Duress PIN (optional)</span>
              <input value={duress} onChange={e => setDuress(e.target.value.replace(/\D/g,''))} placeholder="different 4–6 digits" inputMode="numeric" maxLength={6} type="password" /></label>
            {err && <p className="grd-enroll-err">{err}</p>}
            <button className="grd-btn grd-btn-now" disabled={busy} onClick={doSetDuress}>
              {busy ? 'Saving…' : (duress ? 'Save and continue' : 'Skip for now')}</button>
          </section>
        )}

        {step === 'contacts' && (
          <section className="grd-enroll-body">
            <h1 className="grd-enroll-h1">Your emergency contacts</h1>
            <p className="grd-enroll-p">They’ll be alerted in this order. The first one is called first.</p>
            {contacts.map((c, i) => (
              <div key={i} className="grd-contact-row">
                <span className="grd-contact-num">{i + 1}</span>
                <input placeholder="Name" value={c.name} onChange={e => updateContact(i,'name',e.target.value)} />
                <input placeholder="Phone" value={c.phone} inputMode="tel" onChange={e => updateContact(i,'phone',e.target.value)} />
              </div>
            ))}
            {contacts.length < 5 && <button className="grd-enroll-link" onClick={addRow}>+ Add another</button>}
            {err && <p className="grd-enroll-err">{err}</p>}
            <button className="grd-btn grd-btn-now" disabled={busy} onClick={doContacts}>
              {busy ? 'Saving…' : 'Finish setup'}</button>
          </section>
        )}

        {step === 'done' && (
          <section className="grd-enroll-body grd-enroll-done">
            <div className="grd-done-shield">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <h1 className="grd-enroll-h1">You’re protected</h1>
            <p className="grd-enroll-p">The shield stays in the corner of the map. In an emergency, open it and hold the button.</p>
            <button className="grd-btn grd-btn-now" onClick={onDone}>See the button</button>
          </section>
        )}
      </div>
    </div>
  );
}
