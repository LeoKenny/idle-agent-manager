#!/bin/sh
# Records which herdr terminal runs a Claude session, so the session can be
# restored after a reboot. SessionStart adds an entry; a clean SessionEnd removes it.
# Entries left behind mean the session was not closed cleanly (reboot, crash, kill).
action="${1:-}"
dir="$HOME/.local/state/claude-restore/sessions"
mkdir -p "$dir" 2>/dev/null || exit 0
input="$(cat)"
HOOK_ACTION="$action" HOOK_INPUT="$input" HOOK_DIR="$dir" \
HOOK_TERMINAL="${HC_TERMINAL_ID:-}" python3 - <<'PY' 2>/dev/null || exit 0
import json, os, shutil, subprocess, time
action = os.environ["HOOK_ACTION"]
d = os.environ["HOOK_DIR"]
try:
    data = json.loads(os.environ.get("HOOK_INPUT") or "{}")
except ValueError:
    raise SystemExit(0)
sid = data.get("session_id") or ""
if not sid:
    raise SystemExit(0)
def clear_terminal():
    # A terminal runs one Claude at a time: drop any record for it, whatever its session id.
    term = os.environ.get("HOOK_TERMINAL", "")
    if not term:
        return
    for name in os.listdir(d):
        p = os.path.join(d, name)
        try:
            with open(p) as f:
                if json.load(f).get("terminal") == term:
                    os.remove(p)
        except (OSError, ValueError):
            pass
def space_of(term):
    # The herdr space the terminal is in, so a resume can open there again.
    exe = shutil.which("hc") or os.path.expanduser("~/.local/bin/hc")
    try:
        r = subprocess.run([exe, "get", term, "--json"], capture_output=True, text=True, timeout=3)
        return (json.loads(r.stdout).get("labels") or {}).get("herdr.space", "") if r.returncode == 0 else ""
    except Exception:
        return ""
path = os.path.join(d, sid + ".json")
if action == "start":
    if not os.environ.get("HOOK_TERMINAL"):
        raise SystemExit(0)  # not running inside a herdr terminal
    entry = {
        "session_id": sid,
        "terminal": os.environ["HOOK_TERMINAL"],
        "cwd": data.get("cwd") or os.getcwd(),
        "started": int(time.time()),
        "space": space_of(os.environ["HOOK_TERMINAL"]),
    }
    clear_terminal()
    with open(path, "w") as f:
        json.dump(entry, f)
elif action == "end":
    clear_terminal()
PY
