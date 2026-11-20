"""Tests for mods/idle-agent-manager/offline.py.

Every test builds a fake home folder (Claude Code's files, restore records, a fake `hc`)
and runs the script the way the mod does: `python3 -I -c <source> <command>`, with HOME
pointing at the fake folder. Nothing outside the temporary folder is read or changed.
"""
import json, os, shutil, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "mods", "idle-agent-manager", "offline.py")
with open(SCRIPT) as _f:
    SRC = _f.read()

A = "aaaaaaaa-0000-4000-8000-000000000001"  # closed, typed prompt
B = "bbbbbbbb-0000-4000-8000-000000000002"  # headless (sdk-cli)
C = "cccccccc-0000-4000-8000-000000000003"  # no typed prompt
D = "dddddddd-0000-4000-8000-000000000004"  # running
E = "eeeeeeee-0000-4000-8000-000000000005"  # interrupted, shell waiting
F = "ffffffff-0000-4000-8000-000000000006"  # interrupted, terminal runs claude again


def proc_start(pid):
    with open(f"/proc/{pid}/stat") as f:
        return f.read().rsplit(")", 1)[1].split()[19]


class FakeHome:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="idle-agent-manager-test-")
        self.home = os.path.join(self.dir, "home")
        self.claude = os.path.join(self.home, ".claude")
        self.records = os.path.join(self.home, ".local/state/claude-restore/sessions")
        self.tmproot = os.path.join(self.dir, "tmp-claude")
        self.bin = os.path.join(self.dir, "bin")
        self.proj = os.path.join(self.claude, "projects", "-work")
        self.cwd = os.path.join(self.dir, "work")
        for d in (self.proj, self.records, self.tmproot, self.bin, self.cwd, os.path.join(self.claude, "sessions")):
            os.makedirs(d, exist_ok=True)
        self.terminals = {}
        self.write_hc()

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write_hc(self):
        # A fake `hc get <t> --json` answering from terminals.json; unknown terminals fail.
        path = os.path.join(self.bin, "hc")
        with open(path, "w") as f:
            f.write(f"""#!{sys.executable}
import json, sys
t = json.load(open({json.dumps(os.path.join(self.dir, "terminals.json"))}))
if len(sys.argv) > 2 and sys.argv[1] == "get" and sys.argv[2] in t:
    print(json.dumps(t[sys.argv[2]])); sys.exit(0)
sys.exit(1)
""")
        os.chmod(path, 0o755)
        self.save_terminals()

    def save_terminals(self):
        with open(os.path.join(self.dir, "terminals.json"), "w") as f:
            json.dump(self.terminals, f)

    def terminal(self, name, fg, space="sp1", state="live"):
        self.terminals[name] = {"state": state, "foreground": {"name": fg}, "labels": {"herdr.space": space}}
        self.save_terminals()

    def transcript(self, sid, lines):
        with open(os.path.join(self.proj, sid + ".jsonl"), "w") as f:
            for e in lines:
                f.write(json.dumps(e, separators=(",", ":")) + "\n")

    def user(self, text, **kw):
        return {"type": "user", "cwd": self.cwd, "entrypoint": kw.pop("entry", "cli"), "message": {"content": text}, **kw}

    def record(self, name, **e):
        with open(os.path.join(self.records, name + ".json"), "w") as f:
            json.dump(e, f)

    def run(self, *args):
        env = {"HOME": self.home, "PATH": self.bin + os.pathsep + os.environ.get("PATH", ""), "CLAUDE_OFFLINE_TMP": self.tmproot}
        r = subprocess.run([sys.executable, "-I", "-c", SRC, *args], capture_output=True, text=True, env=env, timeout=60)
        return r


class ListTests(unittest.TestCase):
    def setUp(self):
        self.h = FakeHome()
        h = self.h
        h.transcript(A, [
            h.user("fix the parser"),
            {"type": "ai-title", "aiTitle": "Parser fix"},
            {"type": "custom-title", "customTitle": "parser"},
            {"type": "bridge-session", "bridgeSessionId": "cse_BRIDGE_A"},
        ])
        h.transcript(B, [h.user("headless run", entry="sdk-cli")])
        h.transcript(C, [{"type": "user", "cwd": h.cwd, "isMeta": True, "message": {"content": "<command-name>/x</command-name>"}}])
        h.transcript(D, [h.user("still running")])
        # A subagent transcript in the side folder is never listed on its own.
        os.makedirs(os.path.join(h.proj, A, "subagents"))
        with open(os.path.join(h.proj, A, "subagents", "agent-1.jsonl"), "w") as f:
            f.write(json.dumps(h.user("sub")) + "\n")
        # D runs: a session file with this test's own pid and start time.
        if os.path.isdir("/proc"):
            pid = os.getpid()
            with open(os.path.join(h.claude, "sessions", f"{pid}.json"), "w") as f:
                json.dump({"pid": pid, "sessionId": D, "procStart": proc_start(pid), "bridgeSessionId": "session_BRIDGE_D"}, f)

    def tearDown(self):
        self.h.close()

    def listing(self):
        r = self.h.run("list")
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_closed_session_is_listed_with_titles_and_folder(self):
        s = {x["id"]: x for x in self.listing()["sessions"]}
        self.assertIn(A, s)
        self.assertEqual(s[A]["kind"], "closed")
        self.assertEqual(s[A]["custom"], "parser")
        self.assertEqual(s[A]["ai"], "Parser fix")
        self.assertEqual(s[A]["prompt"], "fix the parser")
        self.assertEqual(s[A]["cwd"], self.h.cwd)
        self.assertTrue(s[A]["cwd_ok"])

    def test_headless_and_promptless_sessions_are_skipped(self):
        ids = [x["id"] for x in self.listing()["sessions"]]
        self.assertNotIn(B, ids)
        self.assertNotIn(C, ids)

    def test_subagent_transcripts_are_not_sessions(self):
        self.assertEqual(sorted(x["id"] for x in self.listing()["sessions"] if x["kind"] == "closed"), [A])

    @unittest.skipUnless(os.path.isdir("/proc"), "needs /proc")
    def test_running_session_is_excluded_and_reported(self):
        d = self.listing()
        self.assertNotIn(D, [x["id"] for x in d["sessions"]])
        self.assertIn(D, d["running"])

    @unittest.skipUnless(os.path.isdir("/proc"), "needs /proc")
    def test_bridge_ids_come_from_transcripts_and_session_files(self):
        self.assertEqual(sorted(self.listing()["bridges"]), ["BRIDGE_A", "BRIDGE_D"])

    def test_dead_session_file_does_not_count_as_running(self):
        with open(os.path.join(self.h.claude, "sessions", "1.json"), "w") as f:
            json.dump({"pid": 2 ** 22 + 7, "sessionId": A}, f)  # no such pid
        self.assertIn(A, [x["id"] for x in self.listing()["sessions"]])

    def test_cache_is_written_and_reused(self):
        self.listing()
        cache = os.path.join(self.h.home, ".cache/claude-offline/meta.json")
        self.assertTrue(os.path.exists(cache))
        self.assertEqual(self.listing()["sessions"][0]["id"], A)


class InterruptedTests(unittest.TestCase):
    def setUp(self):
        self.h = FakeHome()
        h = self.h
        h.transcript(E, [h.user("long job")])
        h.transcript(F, [h.user("back again")])
        h.record(E, session_id=E, terminal="t1", cwd=h.cwd, started=100, space="spRecorded")
        h.record(F, session_id=F, terminal="t2", cwd=h.cwd, started=100)
        h.record("backfill-t3", session_id="backfill-t3", terminal="t3", cwd=h.cwd, started=100, backfilled=True)
        h.terminal("t1", "bash")
        h.terminal("t2", "claude")

    def tearDown(self):
        self.h.close()

    def sessions(self):
        r = self.h.run("list")
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["sessions"]

    def test_idle_shell_is_waiting_to_restore_with_its_space(self):
        s = {x["id"]: x for x in self.sessions()}
        self.assertEqual(s[E]["kind"], "interrupted")
        self.assertEqual(s[E]["reason"], "waiting to restore")
        self.assertEqual(s[E]["terminal"], "t1")
        self.assertEqual(s[E]["space"], "spRecorded")

    def test_space_falls_back_to_the_terminal_label(self):
        self.h.record(E, session_id=E, terminal="t1", cwd=self.h.cwd, started=100)
        s = {x["id"]: x for x in self.sessions()}
        self.assertEqual(s[E]["space"], "sp1")

    def test_terminal_running_claude_again_is_online(self):
        self.assertNotIn(F, [x["id"] for x in self.sessions()])

    def test_busy_terminal(self):
        self.h.terminal("t1", "vim")
        s = {x["id"]: x for x in self.sessions()}
        self.assertEqual(s[E]["reason"], "terminal busy (vim)")

    def test_record_without_session_id(self):
        back = [x for x in self.sessions() if x.get("record") == "backfill-t3"]
        self.assertEqual(len(back), 1)
        self.assertEqual(back[0]["id"], "")
        self.assertEqual(back[0]["reason"], "terminal gone")

    def test_interrupted_session_is_not_also_closed(self):
        self.assertEqual([x["kind"] for x in self.sessions() if x["id"] == E], ["interrupted"])


class DeleteTests(unittest.TestCase):
    def setUp(self):
        self.h = FakeHome()
        h, c = self.h, self.h.claude
        h.transcript(A, [h.user("to delete")])
        h.transcript(B, [h.user("keep me")])
        os.makedirs(os.path.join(h.proj, A, "subagents"))
        for d in ("file-history", "session-env"):
            os.makedirs(os.path.join(c, d, A))
            os.makedirs(os.path.join(c, d, B))
        os.makedirs(os.path.join(c, "debug"))
        open(os.path.join(c, "debug", A + ".txt"), "w").close()
        for short, sid in ((A[:8], A), (B[:8], B)):
            os.makedirs(os.path.join(c, "jobs", short))
            with open(os.path.join(c, "jobs", short, "state.json"), "w") as f:
                json.dump({"sessionId": sid}, f)
        with open(os.path.join(c, "sessions", "4000000.json"), "w") as f:
            json.dump({"pid": 4000000, "sessionId": A}, f)
        open(os.path.join(c, "sessions", "4000000.abc.key"), "w").close()
        os.makedirs(os.path.join(h.tmproot, "-work", A, "scratchpad"))
        h.record(A, session_id=A, terminal="t1", cwd=h.cwd, started=1)
        with open(os.path.join(c, "history.jsonl"), "w") as f:
            for sid, text in ((A, "one"), (B, "other"), (A, "two")):
                f.write(json.dumps({"display": text, "sessionId": sid}, separators=(",", ":")) + "\n")

    def tearDown(self):
        self.h.close()

    def test_delete_removes_everything_for_that_session_only(self):
        h, c = self.h, self.h.claude
        r = h.run("delete", A)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["history_lines"], 2)
        for gone in (
            os.path.join(h.proj, A + ".jsonl"), os.path.join(h.proj, A),
            os.path.join(c, "file-history", A), os.path.join(c, "session-env", A),
            os.path.join(c, "debug", A + ".txt"), os.path.join(c, "jobs", A[:8]),
            os.path.join(c, "sessions", "4000000.json"), os.path.join(c, "sessions", "4000000.abc.key"),
            os.path.join(h.tmproot, "-work", A), os.path.join(h.records, A + ".json"),
        ):
            self.assertFalse(os.path.exists(gone), gone)
        for kept in (
            os.path.join(h.proj, B + ".jsonl"), os.path.join(c, "file-history", B),
            os.path.join(c, "session-env", B), os.path.join(c, "jobs", B[:8]),
        ):
            self.assertTrue(os.path.exists(kept), kept)
        with open(os.path.join(c, "history.jsonl")) as f:
            self.assertEqual([json.loads(l)["display"] for l in f], ["other"])
        backups = os.listdir(os.path.join(h.home, ".cache/claude-offline/history-backups"))
        self.assertEqual(len(backups), 1)

    def test_job_folder_of_another_session_with_same_prefix_is_kept(self):
        with open(os.path.join(self.h.claude, "jobs", A[:8], "state.json"), "w") as f:
            json.dump({"sessionId": "aaaaaaaa-9999-4000-8000-000000000009"}, f)
        self.assertEqual(self.h.run("delete", A).returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.h.claude, "jobs", A[:8])))

    def test_refuses_bad_id(self):
        r = self.h.run("delete", "../../etc")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not a session id", r.stderr)

    @unittest.skipUnless(os.path.isdir("/proc"), "needs /proc")
    def test_refuses_running_session(self):
        pid = os.getpid()
        with open(os.path.join(self.h.claude, "sessions", f"{pid}.json"), "w") as f:
            json.dump({"pid": pid, "sessionId": A, "procStart": proc_start(pid)}, f)
        r = self.h.run("delete", A)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("running", r.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.h.proj, A + ".jsonl")))

    def test_history_untouched_when_session_has_no_lines(self):
        with open(os.path.join(self.h.claude, "history.jsonl")) as f:
            before = f.read()
        self.h.transcript(C, [self.h.user("no history")])
        self.assertEqual(json.loads(self.h.run("delete", C).stdout)["history_lines"], 0)
        with open(os.path.join(self.h.claude, "history.jsonl")) as f:
            self.assertEqual(f.read(), before)


class ForgetTests(unittest.TestCase):
    def setUp(self):
        self.h = FakeHome()

    def tearDown(self):
        self.h.close()

    def test_forget_removes_only_the_record(self):
        self.h.record("backfill-t3", session_id="backfill-t3", terminal="t3")
        r = self.h.run("forget", "backfill-t3")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.h.records, "backfill-t3.json")))

    def test_forget_rejects_paths(self):
        self.assertNotEqual(self.h.run("forget", "../x").returncode, 0)


if __name__ == "__main__":
    unittest.main()
