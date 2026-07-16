/**
 * Guardian Mode — client data layer.
 *
 * Wraps the guardian_* / gateway_* RPCs from migrations 0002 + 0003.
 * Everything an armed user does goes through here. Two pieces of state
 * survive a page reload (a chased person's phone may lock, drop, reopen):
 *
 *   sr_guardian_secret  — the device_secret from guardian_verify(). This is
 *                         the user's identity. Stored in localStorage because
 *                         it must outlive the tab; protected server-side by
 *                         the PIN on every silencing action (see 0003 A1/A2).
 *   sr_guardian_active  — the id of an in-flight emergency, so reopening the
 *                         app after a lock drops her straight back onto the
 *                         LIVE screen instead of a fresh READY button.
 */
import { supabase } from '../lib/supabase.js';

const SECRET_KEY = 'sr_guardian_secret';
const ACTIVE_KEY = 'sr_guardian_active';
const USER_KEY   = 'sr_guardian_user';

// ---- local persistence --------------------------------------------------
export const guardianStore = {
  secret:  () => localStorage.getItem(SECRET_KEY),
  setSecret: (s) => localStorage.setItem(SECRET_KEY, s),
  user:    () => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } },
  setUser: (u) => localStorage.setItem(USER_KEY, JSON.stringify(u)),
  activeEmergency:    () => localStorage.getItem(ACTIVE_KEY),
  setActiveEmergency: (id) => id ? localStorage.setItem(ACTIVE_KEY, id)
                                 : localStorage.removeItem(ACTIVE_KEY),
  isEnrolled: () => Boolean(localStorage.getItem(SECRET_KEY)),
};

// ---- thin RPC helper -----------------------------------------------------
async function rpc(fn, args) {
  if (!supabase) throw new Error('offline'); // surfaced as a fail-loud state
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

export const guardianApi = {
  // enrollment (calm-day onboarding) ---------------------------------------
  register: (phone, name, pin) =>
    rpc('guardian_register', { p_phone: phone, p_name: name, p_pin: pin }),

  verify: (phone, otp) =>
    rpc('guardian_verify', { p_phone: phone, p_otp: otp }),

  addContact: (name, phone, priority) =>
    rpc('guardian_add_contact', {
      p_secret: guardianStore.secret(),
      p_name: name, p_phone: phone, p_priority: priority,
    }),

  setDuressPin: (realPin, duressPin) =>
    rpc('guardian_set_duress_pin', {
      p_secret: guardianStore.secret(),
      p_real_pin: realPin, p_duress_pin: duressPin,
    }),

  // the panic button --------------------------------------------------------
  trigger: (lat, lng, note) =>
    rpc('guardian_trigger', {
      p_secret: guardianStore.secret(),
      p_lat: lat ?? null, p_lng: lng ?? null, p_note: note ?? null,
    }),

  // PIN pad submits here — real PIN cancels, duress PIN fakes it (0003 A2)
  cancel: (emergencyId, pin) =>
    rpc('guardian_cancel', {
      p_secret: guardianStore.secret(),
      p_emergency_id: emergencyId, p_pin: pin,
    }),

  status: (emergencyId) =>
    rpc('guardian_status', {
      p_secret: guardianStore.secret(),
      p_emergency_id: emergencyId,
    }),

  // is the backend clock alive? (0003 A5) — used to warn before/independent
  // of a trigger. Never blocks the button; only annotates it.
  engineHealth: () => rpc('guardian_engine_health', {}),
};
