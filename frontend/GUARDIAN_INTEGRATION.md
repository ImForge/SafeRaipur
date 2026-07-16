# Wiring Guardian Mode into the SafeRaipur frontend

The panic UI is fully self-contained in `src/guardian/`. Adding it to your
existing app is **two lines** — it does not touch any existing component,
state, or style. Everything Guardian renders lives above your app at
`z-index: 900` (the button) and `9999` (the full-screen overlay).

## The only change: `src/App.jsx`

**1. Add the import** at the top, next to your other component imports:

```jsx
import GuardianButton from './guardian/GuardianButton.jsx';
```

**2. Render it** inside the top-level returned element, anywhere among your
other floating UI (right after `<Dock ... />` is the natural spot):

```jsx
      <Dock
        timeOfDay={timeOfDay} setTimeOfDay={setTimeOfDay}
        /* ...existing props... */
      />

      <GuardianButton />        {/* ← add this line */}
```

That's it. `GuardianButton` handles everything else:
- shows a shield FAB on the map (bottom-right, above the dock),
- first tap with no account → opens the calm-day enrollment flow,
- tap once enrolled → opens the black panic overlay (READY → COUNTDOWN → LIVE),
- the overlay covers the entire SENTINEL dashboard while armed, so a person
  in danger sees only what can help her.

## No other files change

- **No new dependencies.** It uses your existing `@supabase/supabase-js`
  client (imported from `./lib/supabase.js`) and plain React.
- **No style collisions.** Every class is prefixed `grd-`, and the overlay
  sets its own tokens inside `.grd-root` so it can't leak into or inherit
  from the SENTINEL styles. The one intentional shared thread is the crimson
  accent (`#FF3B5C`), copied as a literal so it matches even in isolation.
- **No routing.** It's a conditional render controlled by local state, exactly
  like your existing `ReportModal`.

## Environment / backend prerequisites

Guardian talks to the RPCs from migrations `0002` + `0003`. Before the button
does anything real:
1. Apply `0002_guardian_mode.sql` then `0003_guardian_hardening.sql` in Supabase.
2. Set a real gateway secret in `gateway_devices` (see `docs/GUARDIAN_MODE.md`).
3. Your existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` already cover
   the client — no new env vars.

Until the gateway phone is running, enrollment still works but the OTP SMS
sits in the queue unsent — so for first UI testing, read the OTP straight from
the `guardian_users` table (or run the gateway in mock mode from
`simulate.py`'s gateway pump).

## Files added (all under `src/guardian/`)

| File | Role |
|---|---|
| `GuardianButton.jsx` | the FAB + enroll/armed router (the only thing you import) |
| `GuardianOverlay.jsx` | the three panic screens + PIN pad + live polling |
| `GuardianEnroll.jsx` | calm-day setup: phone/OTP/PIN/duress/contacts |
| `guardianApi.js` | thin wrapper over the guardian_* RPCs + local persistence |
| `guardian.css` | the panic-screen "subtraction" styling |
| `guardianTrigger.css` | the FAB styling (matches SENTINEL glass) |
| `guardianEnroll.css` | the enrollment form styling |
