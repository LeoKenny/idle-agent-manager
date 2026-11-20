#!/usr/bin/env python3
# Claude sessions on this machine that aren't running, for the idle-agent-manager mod.
# The mod runs it on every machine with exec(..., { on }), passing this file as -c.
#   list            prints {"sessions": [...]} as JSON. Reads only (plus a cache file).
#   delete <id>     removes everything Claude Code keeps for that session on this machine
#                   (see delete() below) and its restore record.
import glob, json, os, re, shutil, subprocess, sys, time

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
PROJECTS = os.path.join(CLAUDE, "projects")
RECORDS = os.path.join(HOME, ".local/state/claude-restore/sessions")
CACHE = os.path.join(HOME, ".cache/claude-offline/meta.json")
# Where Claude Code keeps per-session scratch output (overridable for tests).
TMPROOT = os.environ.get("CLAUDE_OFFLINE_TMP") or f"/tmp/claude-{os.getuid()}"
SHELLS = {"zsh", "bash", "fish", "sh", "dash"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HEAD_LINES = 400  # the first prompt and folder are near the top


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def hc_get(term):
    exe = shutil.which("hc") or os.path.join(HOME, ".local/bin/hc")
    try:
        r = subprocess.run([exe, "get", term, "--json"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None


def alive(pid, proc_start):
    try:
        with open(f"/proc/{int(pid)}/stat") as f:
            stat = f.read()
    except (OSError, ValueError, TypeError):
        if not os.path.isdir("/proc"):  # no procfs: just ask whether the pid exists
            try:
                os.kill(int(pid), 0)
                return True
            except (OSError, ValueError, TypeError):
                return False
        return False
    # Field 22 (start time) guards against a reused pid.
    start = stat.rsplit(")", 1)[1].split()[19]
    return not proc_start or str(proc_start) == start


def running_ids():
    ids = set()
    for p in glob.glob(os.path.join(CLAUDE, "sessions", "*.json")):
        s = load(p)
        if isinstance(s, dict) and s.get("sessionId") and alive(s.get("pid"), s.get("procStart")):
            ids.add(s["sessionId"])
    return ids


def bridge(v):
    # claude.ai ids come as cse_<x> or session_<x>: compare the <x>.
    return str(v).split("_", 1)[-1] if v else ""


def prompt_text(msg):
    c = (msg or {}).get("content")
    if isinstance(c, list):
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    if not isinstance(c, str):
        return ""
    c = c.strip()
    if not c or c.startswith("<") or c.startswith("This session is being continued"):
        return ""
    return " ".join(c.split())[:200]


def scan(path):
    """What the list needs from one transcript, in one pass with cheap substring checks."""
    m = {"cwd": "", "entry": "", "prompt": "", "custom": "", "ai": "", "last": "", "user": False, "bridges": []}
    try:
        with open(path, "rb") as f:
            for n, raw in enumerate(f):
                head = n < HEAD_LINES
                if not head and b'-title"' not in raw and b'"last-prompt"' not in raw and b'"bridge-session"' not in raw:
                    continue
                try:
                    e = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(e, dict):
                    continue
                t = e.get("type")
                if t == "custom-title" and e.get("customTitle"):
                    m["custom"] = e["customTitle"]
                elif t == "ai-title" and e.get("aiTitle"):
                    m["ai"] = e["aiTitle"]
                elif t == "bridge-session" and e.get("bridgeSessionId"):
                    b = bridge(e["bridgeSessionId"])
                    if b and b not in m["bridges"]:
                        m["bridges"].append(b)
                elif t == "last-prompt" and e.get("lastPrompt"):
                    m["last"] = " ".join(str(e["lastPrompt"]).split())[:200]
                    m["user"] = True
                if not head:
                    continue
                if not m["cwd"] and e.get("cwd"):
                    m["cwd"] = e["cwd"]
                if not m["entry"] and e.get("entrypoint"):
                    m["entry"] = e["entrypoint"]
                if t == "user" and not e.get("isMeta") and not e.get("isSidechain") and not m["prompt"]:
                    m["prompt"] = prompt_text(e.get("message"))
                    if m["prompt"]:
                        m["user"] = True
    except OSError:
        return None
    return m


def transcripts():
    """{session id: path} for top-level transcripts (not subagents' files)."""
    out = {}
    for p in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")):
        sid = os.path.basename(p)[:-6]
        if UUID.match(sid):
            out[sid] = p
    return out


def listing():
    cache = load(CACHE)
    if not isinstance(cache, dict):
        cache = {}
    fresh = {}

    def meta(path):
        try:
            st = os.stat(path)
        except OSError:
            return None
        key = f"v2:{int(st.st_mtime)}:{st.st_size}"
        c = cache.get(path)
        if not (isinstance(c, dict) and c.get("key") == key):
            c = {"key": key, "m": scan(path)}
        fresh[path] = c
        if not c["m"]:
            return None
        bridges.update(c["m"].get("bridges") or [])
        return dict(c["m"], updated=int(st.st_mtime * 1000))

    running = running_ids()
    files = transcripts()
    # claude.ai (Remote Control) ids this machine has a session for: the Remote section skips them.
    bridges = set()
    for p in glob.glob(os.path.join(CLAUDE, "sessions", "*.json")) + glob.glob(os.path.join(CLAUDE, "jobs", "*", "state.json")):
        s = load(p)
        if isinstance(s, dict) and s.get("bridgeSessionId"):
            bridges.add(bridge(s["bridgeSessionId"]))
    out, taken = [], set()

    # Interrupted: restore records whose session isn't running.
    for rp in sorted(glob.glob(os.path.join(RECORDS, "*.json"))):
        r = load(rp)
        if not isinstance(r, dict):
            continue
        sid, term = r.get("session_id") or "", r.get("terminal") or ""
        if not term or sid in running:
            continue
        info = hc_get(term)
        fg = (info or {}).get("foreground") or {}
        if fg.get("name") == "claude":
            running.add(sid)  # Claude is up in that terminal again: online, not closed
            continue
        if info is None:
            reason = "terminal gone"
        elif fg.get("name") in SHELLS and info.get("state") == "live":
            reason = "waiting to restore"
        else:
            reason = f"terminal busy ({fg.get('name') or 'unknown'})"
        m = meta(files[sid]) if sid in files else None
        cwd = r.get("cwd") or (m or {}).get("cwd") or ""
        out.append({
            "id": sid if UUID.match(sid) else "",
            "record": os.path.basename(rp)[:-5],
            "kind": "interrupted",
            "custom": (m or {}).get("custom", ""),
            "ai": (m or {}).get("ai", ""),
            "prompt": (m or {}).get("prompt") or (m or {}).get("last", ""),
            "cwd": cwd,
            "cwd_ok": bool(cwd) and os.path.isdir(cwd),
            "updated": (m or {}).get("updated") or int(r.get("started", 0)) * 1000,
            "terminal": term,
            "space": r.get("space") or ((info or {}).get("labels") or {}).get("herdr.space", ""),
            "reason": reason,
        })
        taken.add(sid)

    # Closed: every other transcript that isn't running, has a prompt someone typed,
    # and wasn't a headless (`claude -p`, SDK) run.
    for sid, p in files.items():
        if sid in running or sid in taken:
            continue
        m = meta(p)
        if not m or not m["user"] or m["entry"].startswith("sdk"):
            continue
        out.append({
            "id": sid,
            "kind": "closed",
            "custom": m["custom"],
            "ai": m["ai"],
            "prompt": m["prompt"] or m["last"],
            "cwd": m["cwd"],
            "cwd_ok": bool(m["cwd"]) and os.path.isdir(m["cwd"]),
            "updated": m["updated"],
        })

    out.sort(key=lambda s: s["updated"], reverse=True)
    if fresh != cache:
        try:
            os.makedirs(os.path.dirname(CACHE), exist_ok=True)
            tmp = CACHE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(fresh, f)
            os.replace(tmp, CACHE)
        except OSError:
            pass
    # Running ids too: another machine may hold a copy of a transcript running here.
    print(json.dumps({"home": HOME, "running": sorted(running), "bridges": sorted(bridges), "sessions": out}))


def delete(sid):
    if not UUID.match(sid):
        raise SystemExit("not a session id")
    if sid in running_ids():
        raise SystemExit("session is running")
    removed = []

    def rm(path):
        if os.path.islink(path) or os.path.isfile(path):
            os.remove(path)
        elif os.path.isdir(path):
            shutil.rmtree(path)
        else:
            return
        removed.append(path.replace(HOME, "~", 1))

    def owns(state_file):
        s = load(state_file)
        return isinstance(s, dict) and sid in (s.get("sessionId"), s.get("resumeSessionId"))

    # The transcript and its side folder (subagents, tool output).
    for p in glob.glob(os.path.join(PROJECTS, "*", sid + ".jsonl")) + glob.glob(os.path.join(PROJECTS, "*", sid)):
        rm(p)
    # Backups of edited files (rewind), the environment snapshot, the debug log.
    rm(os.path.join(CLAUDE, "file-history", sid))
    rm(os.path.join(CLAUDE, "session-env", sid))
    rm(os.path.join(CLAUDE, "debug", sid + ".txt"))
    # Background job folder: named by the id's first 8 characters; only if it's this session's.
    job = os.path.join(CLAUDE, "jobs", sid[:8])
    if os.path.isdir(job) and (owns(os.path.join(job, "state.json")) or not os.path.exists(os.path.join(job, "state.json"))):
        rm(job)
    # Leftover "running" files from a cut-off run.
    for p in glob.glob(os.path.join(CLAUDE, "sessions", "*.json")):
        if owns(p):
            rm(p)
            for key in glob.glob(p[:-5] + ".*.key"):
                rm(key)
    # Scratchpad and task output under /tmp/claude-<uid>/<project>/<id>.
    for p in glob.glob(os.path.join(TMPROOT, "*", sid)):
        rm(p)
    # The restore record.
    rm(os.path.join(RECORDS, sid + ".json"))
    # Prompt history: one shared file, rewritten without this session's lines.
    lines = drop_history(sid)
    print(json.dumps({"removed": removed, "history_lines": lines}))


def drop_history(sid):
    """Rewrites ~/.claude/history.jsonl without sid's lines, after a dated backup.
    Running sessions append to it: if it grows while rewriting, try again."""
    path = os.path.join(CLAUDE, "history.jsonl")
    needle = f'"sessionId":"{sid}"'.encode()
    for _ in range(5):
        try:
            st = os.stat(path)
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return 0
        if needle not in data and sid.encode() not in data:
            return 0
        keep, dropped = [], 0
        for line in data.splitlines(keepends=True):
            try:
                if json.loads(line).get("sessionId") == sid:
                    dropped += 1
                    continue
            except (ValueError, AttributeError):
                pass
            keep.append(line)
        if not dropped:
            return 0
        bdir = os.path.join(HOME, ".cache/claude-offline/history-backups")
        os.makedirs(bdir, exist_ok=True)
        now = time.time()
        for old in glob.glob(os.path.join(bdir, "*.jsonl")):
            if now - os.path.getmtime(old) > 14 * 86400:
                os.remove(old)
        with open(os.path.join(bdir, time.strftime("%Y%m%d-%H%M%S-") + sid[:8] + ".jsonl"), "wb") as f:
            f.write(data)
        tmp = path + ".offline-tmp"
        with open(tmp, "wb") as f:
            f.write(b"".join(keep))
        os.chmod(tmp, st.st_mode & 0o777)
        if os.stat(path).st_size == st.st_size:
            os.replace(tmp, path)
            return dropped
        os.remove(tmp)
    return 0


def forget(record):
    # A restore record without a session id (backfilled): drop the record only.
    if not re.match(r"^[\w.-]+$", record):
        raise SystemExit("bad record name")
    p = os.path.join(RECORDS, record + ".json")
    if os.path.exists(p):
        os.remove(p)
    print(json.dumps({"forgot": record}))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        listing()
    elif cmd == "delete" and len(sys.argv) > 2:
        delete(sys.argv[2])
    elif cmd == "forget" and len(sys.argv) > 2:
        forget(sys.argv[2])
    else:
        raise SystemExit("usage: offline.py list | delete <session-id> | forget <record>")
