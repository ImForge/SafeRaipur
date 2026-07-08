/**
 * useGeolocation — the user's location, done safely.
 *
 * DESIGN PROMISES (important for a safety app):
 *   • Location is OPT-IN. We never grab it on page load; the user taps a
 *     button, and the BROWSER shows its own permission dialog (we can't fake
 *     or bypass that — it's the browser's, by design).
 *   • Location NEVER leaves the device. It lives in React state, is used for
 *     client-side math (nearest station, routing), and is never sent to
 *     Supabase, never stored, never logged. A safety tool that secretly
 *     transmitted a user's location would be a betrayal.
 *   • It DEGRADES GRACEFULLY. If the user blocks it or the device can't get
 *     a fix, the app stays fully usable — it just hides "near me" features.
 *
 * States exposed:
 *   coords   → { lat, lng } once granted, else null
 *   status   → 'idle' | 'locating' | 'granted' | 'denied' | 'unavailable'
 *   request  → call this from a button click to ask for location
 */
import { useState, useCallback } from 'react';

export function useGeolocation() {
  const [coords, setCoords] = useState(null);
  const [status, setStatus] = useState('idle');
  const [accuracy, setAccuracy] = useState(null);

  const request = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setStatus('unavailable');
      return;
    }
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setAccuracy(pos.coords.accuracy); // metres of uncertainty
        setStatus('granted');
      },
      (err) => {
        // 1 = permission denied, 2 = position unavailable, 3 = timeout
        setStatus(err.code === 1 ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  return { coords, status, accuracy, request };
}
