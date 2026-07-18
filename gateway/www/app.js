/* ============================================================================
 * Guardian Gateway — the loop.
 *
 * Every POLL_MS the gateway does exactly four things, in order:
 *   1. POLL    gateway_poll(secret)        → heartbeat + claim pending work
 *   2. EXECUTE each command via the native plugin (or log it in mock mode)
 *   3. REPORT  gateway_report(...)         → done/failed, per command
 *   4. FORWARD drainInbox() → gateway_inbound(...)  → contact replies = ACKs
 *
 * FAIL-LOUD: the lamp goes RED the moment a poll fails. Failures are counted,
 * never swallowed. A wake lock keeps the screen (and loop) alive; if the OS
 * refuses, that refusal is printed on the tape.
 *
 * Zero runtime dependencies — raw fetch() against PostgREST. The only thing
 * that can break is the network, and when it breaks, you'll see it.
 * ==========================================================================*/

const POLL_MS = 5000; // MUST stay well under gateway_stale_seconds (60 s)

// ---------------------------------------------------------------- native
// Capacitor injects window.Capacitor in the real app. In a desktop browser
// (dev) there is no plugin — we detect that and force mock mode.
const native = () => window.Capacitor?.Plugins?.GuardianTelephony ?? null;

// ---------------------------------------------------------------- state
const S = {
  running: false,
  timer: null,
  wakeLock: null,
  polls: 0, sms: 0, calls: 0, inbound: 0, fails: 0,
  consecutiveFails: 0,
};

// ---------------------------------------------------------------- dom
const $ = (id) => document.getElementById(id);
const els = {
  lamp: $("lamp"), lampWord: $("lampWord"), lampSub: $("lampSub"),
  cPolls: $("cPolls"), cSms: $("cSms"), cCalls: $("cCalls"),
  cAcks: $("cAcks"), cFails: $("cFails"),
  start: $("btnStart"), stop: $("btnStop"),
  mock: $("mockToggle"), mockBadge: $("mockBadge"),
  url: $("cfgUrl"), anon: $("cfgAnon"), secret: $("cfgSecret"),
  log: $("log"), config: $("configPanel"),
};

// ---------------------------------------------------------------- config
// Stored in localStorage — this is the gateway's OWN dedicated device, and
// the secret only authorizes sending safety messages, not reading anything.
function loadCfg() {
  els.url.value = localStorage.getItem("gw_url") || "";
  els.anon.value = localStorage.getItem("gw_anon") || "";
  els.secret.value = localStorage.getItem("gw_secret") || "";
  const mock = localStorage.getItem("gw_mock");
  els.mock.checked = mock === null ? true : mock === "1";
}
function saveCfg() {
  localStorage.setItem("gw_url", els.url.value.trim().replace(/\/+$/, ""));
  localStorage.setItem("gw_anon", els.anon.value.trim());
  localStorage.setItem("gw_secret", els.secret.value.trim());
  localStorage.setItem("gw_mock", els.mock.checked ? "1" : "0");
}

// ---------------------------------------------------------------- ui
function lamp(state, word, sub) {
  els.lamp.className = "lamp state-" + state;
  els.lampWord.textContent = word;
  els.lampSub.textContent = sub;
}
function counters() {
  els.cPolls.textContent = S.polls;
  els.cSms.textContent = S.sms;
  els.cCalls.textContent = S.calls;
  els.cAcks.textContent = S.inbound;
  els.cFails.textContent = S.fails;
}
function tape(line) {
  const t = new Date().toLocaleTimeString("en-IN", { hour12: false });
  els.log.textContent = `[${t}] ${line}\n` + els.log.textContent;
  // keep the tape bounded so a week of uptime can't eat the heap
  if (els.log.textContent.length > 40000)
    els.log.textContent = els.log.textContent.slice(0, 30000);
}

// ---------------------------------------------------------------- rpc
async function rpc(fn, args) {
  const url = localStorage.getItem("gw_url");
  const anon = localStorage.getItem("gw_anon");
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: anon,
      authorization: `Bearer ${anon}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}
const gwSecret = () => localStorage.getItem("gw_secret");

// ---------------------------------------------------------------- execute
async function execute(cmd) {
  const mock = els.mock.checked;
  const label = `#${cmd.id} ${cmd.action.toUpperCase()} → ${cmd.to_phone}`;

  if (mock) {
    tape(`MOCK ${label}${cmd.body ? ` :: "${cmd.body}"` : ""}`);
    return { ok: true, error: null };
  }

  const tel = native();
  if (!tel) return { ok: false, error: "native plugin unavailable (browser?)" };

  try {
    if (cmd.action === "sms") {
      await tel.sendSms({ to: cmd.to_phone, body: cmd.body || "" });
      S.sms++;
    } else {
      // cmd.body on a call row is the SPOKEN SCRIPT — the gateway dials, then
      // reads it aloud into the call via TTS. A silent call gets hung up on.
      await tel.placeCall({ to: cmd.to_phone, speak: cmd.body || "" });
      S.calls++;
    }
    tape(`SENT ${label}`);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------- tick
async function tick() {
  if (!S.running) return;
  try {
    // 1) poll + heartbeat
    const poll = await rpc("gateway_poll", { p_secret: gwSecret() });
    if (!poll.ok) throw new Error(poll.error);
    S.polls++;
    S.consecutiveFails = 0;

    const cmds = poll.commands || [];
    if (cmds.length) {
      lamp("working", "WORKING", `${cmds.length} command(s) in flight`);
      // 2) + 3) execute then report, one by one, in queue order
      for (const cmd of cmds) {
        const result = await execute(cmd);
        if (!result.ok) { S.fails++; tape(`FAIL #${cmd.id}: ${result.error}`); }
        await rpc("gateway_report", {
          p_secret: gwSecret(),
          p_command_id: cmd.id,
          p_ok: result.ok,
          p_error: result.error,
        });
      }
    }

    // 4) forward inbound SMS (real device only — mock acks come from simulate.py)
    const tel = native();
    if (tel && !els.mock.checked) {
      const inbox = await tel.drainInbox();
      for (const m of inbox.messages || []) {
        const r = await rpc("gateway_inbound", {
          p_secret: gwSecret(), p_from: m.from, p_body: m.body,
        });
        S.inbound++;
        tape(`INBOUND ${m.from} :: "${(m.body || "").slice(0, 60)}" → matched ${r.matched ?? 0} emergencies`);
      }
    }

    lamp("alive", "LIVE", `last poll ok · queue empty in ${POLL_MS / 1000}s cycles`);
  } catch (e) {
    // FAIL LOUD. Red lamp, counted, printed. Never swallowed.
    S.fails++; S.consecutiveFails++;
    lamp("dead", "OFFLINE", `${S.consecutiveFails} consecutive failures — backend marks gateway stale after 60s`);
    tape(`POLL FAILED: ${String(e?.message || e)}`);
  }
  counters();
  S.timer = setTimeout(tick, POLL_MS);
}

// ---------------------------------------------------------------- lifecycle
async function start() {
  saveCfg();
  if (!localStorage.getItem("gw_url") || !localStorage.getItem("gw_anon") || !gwSecret()) {
    tape("REFUSED: fill in URL, anon key, and gateway secret first.");
    return;
  }

  // Ask for telephony permissions up front on real hardware
  const tel = native();
  if (tel && !els.mock.checked) {
    try { await tel.ensurePermissions(); tape("telephony permissions granted"); }
    catch (e) { tape(`PERMISSIONS DENIED: ${e.message} — staying stopped`); return; }
  }
  if (!tel && !els.mock.checked) {
    els.mock.checked = true; saveCfg();
    tape("no native plugin (running in a browser) — forcing MOCK mode");
  }

  // Screen Wake Lock keeps the WebView loop alive on a plugged-in phone.
  try {
    S.wakeLock = await navigator.wakeLock?.request("screen");
    tape(S.wakeLock ? "wake lock acquired — screen stays on" 
                    : "wake lock API unavailable — set Display timeout to Never in Android settings");
  } catch (e) {
    tape(`wake lock refused (${e.message}) — set Display timeout to Never in Android settings`);
  }
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && S.running && !S.wakeLock) {
      try { S.wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
    }
  });

  S.running = true;
  els.start.classList.add("hidden");
  els.stop.classList.remove("hidden");
  els.config.classList.add("hidden");
  els.mockBadge.classList.toggle("hidden", !els.mock.checked);
  tape(`gateway started — polling every ${POLL_MS / 1000}s${els.mock.checked ? " [MOCK]" : " [LIVE SIM]"}`);
  tick();
}

function stop() {
  S.running = false;
  clearTimeout(S.timer);
  S.wakeLock?.release?.(); S.wakeLock = null;
  els.stop.classList.add("hidden");
  els.start.classList.remove("hidden");
  els.config.classList.remove("hidden");
  lamp("boot", "STOPPED", "gateway idle — backend will mark it stale in 60s");
  tape("gateway stopped by operator");
}

els.start.addEventListener("click", start);
els.stop.addEventListener("click", stop);
els.mock.addEventListener("change", () => {
  saveCfg();
  els.mockBadge.classList.toggle("hidden", !els.mock.checked);
});

loadCfg();
lamp("boot", "STOPPED", "configure, then press START");
tape("console ready");
