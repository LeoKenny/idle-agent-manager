#!/bin/sh
# Runs once when herdr starts. For each recorded Claude session whose herdr terminal
# came back as an idle shell (after a reboot or crash), types `claude --resume <id>`
# (or `claude --continue` for records without a session id) in that terminal's folder and clears the record. Terminals already running Claude
# are left alone. Set DRY=1 to only report what would happen.
exec python3 - <<'PY'
import glob, json, os, re, shlex, subprocess
d = os.path.expanduser("~/.local/state/claude-restore/sessions")
dry = os.environ.get("DRY") == "1"
SHELLS = {"zsh", "bash", "fish", "sh", "dash"}

def hc(*args):
    return subprocess.run(["hc", *args], capture_output=True, text=True, timeout=20)

entries = []
for p in glob.glob(os.path.join(d, "*.json")):
    try:
        with open(p) as f:
            e = json.load(f)
        e["_path"] = p
        entries.append(e)
    except (OSError, ValueError):
        pass
if not entries:
    print("no Claude sessions to restore")
    raise SystemExit(0)

by_term = {}
for e in entries:
    by_term.setdefault(e.get("terminal", ""), []).append(e)

out = []
for term, group in sorted(by_term.items()):
    if not term:
        continue
    r = hc("get", term, "--json")
    if r.returncode != 0:
        out.append(f"{term}: not found, record kept")
        continue
    try:
        info = json.loads(r.stdout)
    except ValueError:
        out.append(f"{term}: unreadable, record kept")
        continue
    fg = info.get("foreground") or {}
    if fg.get("name") == "claude":
        out.append(f"{term}: Claude already running, record kept")
        continue
    if fg.get("name") not in SHELLS or info.get("state") != "live":
        out.append(f"{term}: busy ({fg.get('name')}), record kept")
        continue
    newest = max(group, key=lambda e: e.get("started", 0))
    cwd = newest.get("cwd") or info.get("cwd") or os.path.expanduser("~")
    if not os.path.isdir(cwd):
        out.append(f"{term}: folder {cwd} missing, record kept")
        continue
    sid = newest.get("session_id") or ""
    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", sid):
        cmd = f"cd {shlex.quote(cwd)} && claude --resume {sid}"
    else:
        cmd = f"cd {shlex.quote(cwd)} && claude --continue"
    if not dry:
        s = hc("send", term, cmd)
        if s.returncode != 0:
            out.append(f"{term}: send failed ({s.stderr.strip()}), record kept")
            continue
    for e in group:
        if not dry:
            os.remove(e["_path"])
    out.append(f"{term}: {'would restore' if dry else 'restored'} in {cwd}")

print("\n".join(out))
PY
