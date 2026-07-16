#!/usr/bin/env python3
"""
============================================================================
SafeRaipur Guardian Mode — full-chain simulator
============================================================================
Runs the ENTIRE emergency flow on your laptop with ZERO phones:

    register -> OTP verify -> add contacts -> TRIGGER
      -> countdown -> LEVEL 1 (call+SMS) -> LEVEL 2 -> ... -> 112 blast
      -> (optionally) a contact "replies" and the ladder halts

It plays three roles at once:
  VICTIM   — calls the guardian_* RPCs with the anon key (exactly like the app)
  GATEWAY  — polls gateway_poll(), "executes" commands by printing them,
             reports success (exactly like the Android phone in mock mode)
  CONTACT  — injects an inbound SMS via gateway_inbound() to test the ACK path

Only the OTP read and the speed-up use the SERVICE key (because in a phoneless
world nobody receives the OTP text). Everything else goes through the same
locked-down anon RPCs the real clients use — so this test proves the real
security surface, not a backdoor.

Usage:
    export SUPABASE_URL=https://xxxx.supabase.co
    export SUPABASE_ANON_KEY=eyJ...
    export SUPABASE_SERVICE_KEY=eyJ...      # service_role key

    python guardian/simulate.py                 # ride the ladder to the 112 blast
    python guardian/simulate.py --ack-level 2   # contact #2 replies -> ACKNOWLEDGED
    python guardian/simulate.py --cancel        # PIN-cancel during countdown
    python guardian/simulate.py --slow          # keep real 60s/90s timings

By default the run temporarily shrinks countdown to 10 s and level timeout to
15 s via guardian_config (restored afterwards) so a full demo takes ~1 minute.
============================================================================
"""

import argparse
import json
import os
import sys
import time

import requests

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
ANON = os.environ.get("SUPABASE_ANON_KEY", "")
SERVICE = os.environ.get("SUPABASE_SERVICE_KEY", "")

GATEWAY_SECRET = os.environ.get("GATEWAY_SECRET", "sim-gateway-secret-local")

# Demo cast. Phone numbers are fake — nothing is actually sent in this script.
VICTIM = {"phone": "9000000001", "name": "Test Victim", "pin": "4321"}
CONTACTS = [
    {"name": "Contact One", "phone": "9000000011", "priority": 1},
    {"name": "Contact Two", "phone": "9000000012", "priority": 2},
]
FAST_CONFIG = {"countdown_seconds": "10", "level_timeout_seconds": "15"}


# ---------------------------------------------------------------- plumbing
def die(msg):
    print(f"\n  FATAL: {msg}\n", file=sys.stderr)
    sys.exit(1)


def rpc(fn, args, key=None):
    """Call a PostgREST RPC. Defaults to the anon key — same as the real app."""
    k = key or ANON
    r = requests.post(
        f"{URL}/rest/v1/rpc/{fn}",
        headers={"apikey": k, "Authorization": f"Bearer {k}",
                 "Content-Type": "application/json"},
        json=args, timeout=15,
    )
    if r.status_code >= 400:
        die(f"{fn} -> HTTP {r.status_code}: {r.text}")
    return r.json()


def table(method, path, key, **kw):
    """Raw table access — SERVICE KEY ONLY, for test scaffolding."""
    r = requests.request(
        method, f"{URL}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 "Prefer": "return=representation"},
        timeout=15, **kw,
    )
    if r.status_code >= 400:
        die(f"{method} {path} -> HTTP {r.status_code}: {r.text}")
    return r.json() if r.text else None


def stamp():
    return time.strftime("%H:%M:%S")


def say(role, msg):
    colors = {"VICTIM": "\033[96m", "GATEWAY": "\033[93m",
              "CONTACT": "\033[92m", "SYSTEM": "\033[90m"}
    print(f"{colors.get(role, '')}[{stamp()}] {role:<8}\033[0m {msg}")


# ---------------------------------------------------------------- gateway sim
def gateway_pump():
    """One gateway cycle: poll, 'execute' (print), report success.
    Returns the list of commands it handled."""
    out = rpc("gateway_poll", {"p_secret": GATEWAY_SECRET})
    if not out.get("ok"):
        die(f"gateway_poll rejected: {out.get('error')} "
            f"(did setup create the sim gateway device?)")
    cmds = out.get("commands") or []
    for c in cmds:
        if c["action"] == "sms":
            say("GATEWAY", f'SMS -> {c["to_phone"]} :: "{c["body"]}"')
        else:
            say("GATEWAY", f"CALL -> {c['to_phone']}  *ring ring*")
        rpc("gateway_report", {"p_secret": GATEWAY_SECRET,
                               "p_command_id": c["id"], "p_ok": True})
    return cmds


# ---------------------------------------------------------------- scenario
def main():
    ap = argparse.ArgumentParser(description="Guardian Mode end-to-end simulator")
    ap.add_argument("--ack-level", type=int, default=0,
                    help="contact at this priority replies once that level fires")
    ap.add_argument("--cancel", action="store_true",
                    help="PIN-cancel during the countdown window")
    ap.add_argument("--slow", action="store_true",
                    help="keep the real production timings (60s / 90s)")
    args = ap.parse_args()

    if not (URL and ANON and SERVICE):
        die("set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY")

    print("=" * 70)
    print("  GUARDIAN MODE SIMULATOR — nothing real is dialed or texted")
    print("=" * 70)

    # -- scaffolding (service key): sim gateway device + optional fast clock --
    say("SYSTEM", "registering simulator gateway device")
    existing = table("GET",
        f"gateway_devices?label=eq.simulator&select=id", SERVICE)
    if existing:
        table("PATCH", "gateway_devices?label=eq.simulator", SERVICE,
              json={"secret": GATEWAY_SECRET})
    else:
        table("POST", "gateway_devices", SERVICE,
              json={"label": "simulator", "secret": GATEWAY_SECRET})

    original_cfg = {}
    if not args.slow:
        say("SYSTEM", f"speeding up clock for the demo: {FAST_CONFIG}")
        for k, v in FAST_CONFIG.items():
            row = table("GET", f"guardian_config?key=eq.{k}&select=value", SERVICE)
            original_cfg[k] = row[0]["value"]
            table("PATCH", f"guardian_config?key=eq.{k}", SERVICE,
                  json={"value": v})

    try:
        run_scenario(args)
    finally:
        # always restore production timings, even if the run explodes
        for k, v in original_cfg.items():
            table("PATCH", f"guardian_config?key=eq.{k}", SERVICE,
                  json={"value": v})
        if original_cfg:
            say("SYSTEM", "production timings restored")


def run_scenario(args):
    # -------- 1. register (anon key, like the real app) --------
    say("VICTIM", f"registering {VICTIM['phone']}")
    out = rpc("guardian_register", {"p_phone": VICTIM["phone"],
                                    "p_name": VICTIM["name"],
                                    "p_pin": VICTIM["pin"]})
    say("SYSTEM", f"register -> {out}")

    # the OTP SMS is sitting in the queue — pump the gateway so it 'sends'
    gateway_pump()

    # nobody has a phone here, so peek at the OTP with the service key
    row = table("GET",
        f"guardian_users?phone=eq.{VICTIM['phone']}&select=otp_code", SERVICE)
    otp = row[0]["otp_code"]
    say("VICTIM", f"received OTP (via service-key peek): {otp}")

    out = rpc("guardian_verify", {"p_phone": VICTIM["phone"], "p_otp": otp})
    if not out.get("ok"):
        die(f"verify failed: {out}")
    secret = out["device_secret"]
    say("VICTIM", "verified — device_secret issued")

    # -------- 2. contacts --------
    for c in CONTACTS:
        rpc("guardian_add_contact", {"p_secret": secret, "p_name": c["name"],
                                     "p_phone": c["phone"],
                                     "p_priority": c["priority"]})
        say("VICTIM", f"added contact #{c['priority']}: {c['name']}")

    # -------- 3. TRIGGER --------
    say("VICTIM", "*** PANIC BUTTON PRESSED ***")
    out = rpc("guardian_trigger", {"p_secret": secret,
                                   "p_lat": 21.2514, "p_lng": 81.6296,
                                   "p_note": "simulator drill"})
    if not out.get("ok"):
        die(f"trigger failed: {out}")
    eid = out["emergency_id"]
    say("SYSTEM", f"emergency {eid} -> countdown "
                  f"(gateway_ok={out['gateway_ok']}, "
                  f"cancel by {out['cancel_deadline']})")
    if not out["gateway_ok"]:
        say("SYSTEM", "NOTE: backend flagged gateway as stale at trigger time "
                      "— in the real app this screen would say DIAL 112")

    # -------- 3b. optional PIN cancel path --------
    if args.cancel:
        time.sleep(2)
        say("VICTIM", "false alarm — entering PIN to cancel")
        out = rpc("guardian_cancel", {"p_secret": secret,
                                      "p_emergency_id": eid,
                                      "p_pin": VICTIM["pin"]})
        say("SYSTEM", f"cancel -> {out}")
        print_receipts(secret, eid)
        return

    # -------- 4. ride the ladder --------
    say("SYSTEM", "watching the escalation engine (pg_cron fires every 15s)…")
    acked = False
    last_status = "countdown"
    deadline = time.time() + (8 * 60 if args.slow else 3 * 60)

    while time.time() < deadline:
        handled = gateway_pump()

        st = rpc("guardian_status", {"p_secret": secret,
                                     "p_emergency_id": eid})
        if st["status"] != last_status:
            say("SYSTEM", f"STATUS: {last_status} -> {st['status']} "
                          f"(level {st['current_level']})")
            last_status = st["status"]

        # contact replies once the requested level has fired
        if (args.ack_level and not acked
                and st["current_level"] >= args.ack_level
                and st["status"] == "escalating"):
            c = CONTACTS[args.ack_level - 1]
            say("CONTACT", f"{c['name']} replies: 'on my way!!'")
            out = rpc("gateway_inbound", {"p_secret": GATEWAY_SECRET,
                                          "p_from": c["phone"],
                                          "p_body": "on my way!!"})
            say("SYSTEM", f"inbound matched {out['matched']} emergency(ies)")
            acked = True

        if st["status"] in ("acknowledged", "escalated_112",
                            "resolved", "cancelled"):
            # pump once more to flush the confirmation / 112-blast texts
            time.sleep(2)
            gateway_pump()
            break

        time.sleep(4)
    else:
        die("timed out waiting for the ladder — is the guardian-escalate "
            "cron job scheduled? (select * from cron.job;)")

    print_receipts(secret, eid)


def print_receipts(secret, eid):
    st = rpc("guardian_status", {"p_secret": secret, "p_emergency_id": eid})
    print("\n" + "=" * 70)
    print(f"  FINAL STATUS: {st['status'].upper()}   (level {st['current_level']})")
    print("  RECEIPT TAPE — every transition, straight from emergency_events:")
    print("=" * 70)
    for ev in st["events"]:
        detail = json.dumps(ev["detail"]) if ev["detail"] else ""
        print(f"  {ev['at'][11:19]}  {ev['event']:<16} {detail}")
    print("=" * 70)


if __name__ == "__main__":
    main()
