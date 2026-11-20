#!/usr/bin/env python3
# Lists your Claude Code sessions stored on claude.ai, for the idle-agent-manager mod's Remote section.
# Read-only: GET requests to api.anthropic.com only. Signs in with Claude Code's own login
# (~/.claude/.credentials.json) and never prints, logs or saves the token.
# Uses the endpoint Claude Code itself uses (/v1/code/sessions); it isn't documented and may change.
#   probe   prints the response's shape (field names, a few titles) to build the list from
#   list    prints {"sessions": [...]} or {"error": "..."} as JSON
import json, os, sys, urllib.error, urllib.parse, urllib.request

HOME = os.path.expanduser("~")
API = "https://api.anthropic.com"


def creds():
    try:
        with open(os.path.join(HOME, ".claude/.credentials.json")) as f:
            tok = (json.load(f).get("claudeAiOauth") or {}).get("accessToken") or ""
    except (OSError, ValueError):
        tok = ""
    try:
        with open(os.path.join(HOME, ".claude.json")) as f:
            org = (json.load(f).get("oauthAccount") or {}).get("organizationUuid") or ""
    except (OSError, ValueError):
        org = ""
    return tok, org


def get(path, query=None):
    tok, org = creds()
    if not tok:
        raise PermissionError("not signed in to Claude")
    url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {tok}",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "ccr-byoc-2025-07-29",
        "x-organization-uuid": org,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise PermissionError(f"claude.ai refused ({e.code}): sign in to Claude again")
        raise RuntimeError(f"claude.ai answered {e.code}: {e.read()[:200].decode(errors='replace')}")


def short(v):
    s = json.dumps(v) if not isinstance(v, str) else v
    return s if len(s) <= 80 else s[:80] + "..."


def probe():
    d = get("/v1/code/sessions", {"limit": 5})
    print("top-level keys:", sorted(d.keys()) if isinstance(d, dict) else type(d).__name__)
    items = d.get("data") if isinstance(d, dict) else d
    items = items if isinstance(items, list) else []
    for k, v in (d.items() if isinstance(d, dict) else []):
        if k != "data":
            print(f"  {k} = {short(v)}")
    print("items:", len(items))
    for s in items[:5]:
        print("---")
        for k in sorted(s):
            print(f"  {k} = {short(s[k])}")


def ms(iso):
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, AttributeError):
        return 0


def listing():
    """Every session that isn't archived, newest activity first (at most 10 pages of 100)."""
    out, cursor = [], None
    for _ in range(10):
        d = get("/v1/code/sessions", {"limit": 100, **({"cursor": cursor} if cursor else {})})
        for s in d.get("data") or []:
            if s.get("status") == "archived" or not s.get("id"):
                continue
            out.append({
                "id": s["id"],
                "title": s.get("title") or "",
                "status": s.get("status") or "",
                "env": s.get("environment_kind") or "",
                "line": s.get("status_line") or "",
                "worker": s.get("worker_status") or "",
                "unread": bool(s.get("unread")),
                "updated": ms(s.get("last_event_at") or s.get("updated_at") or ""),
                "url": f"https://claude.ai/code/{s['id']}",
            })
        cursor = d.get("next_cursor")
        if not cursor:
            break
    out.sort(key=lambda s: s["updated"], reverse=True)
    print(json.dumps({"sessions": out}))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    try:
        if cmd == "probe":
            probe()
        elif cmd == "list":
            listing()
        else:
            raise SystemExit("usage: claude_ai.py probe | list")
    except (PermissionError, RuntimeError, OSError) as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
