"""Tests for mods/idle-agent-manager/claude_ai.py, without the network.

The module is loaded from its file and its `get` (the only function that talks to
claude.ai) is replaced with canned pages, so the tests check paging, filtering and
the output the mod reads. One test checks that a missing login is an error, not a request.
"""
import contextlib, importlib.util, io, json, os, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "mods", "idle-agent-manager", "claude_ai.py")


def load():
    spec = importlib.util.spec_from_file_location("claude_ai", PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def session(i, **kw):
    s = {
        "id": f"cse_{i:04d}", "title": f"session {i}", "status": "active",
        "environment_kind": "bridge", "status_line": f"line {i}", "worker_status": "idle",
        "unread": False, "last_event_at": f"2026-11-{10 + i:02d}T10:00:00.000000Z",
    }
    s.update(kw)
    return s


class ListTests(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.calls = []

    def run_list(self, pages):
        def fake_get(path, query=None):
            self.calls.append((path, dict(query or {})))
            return pages[len(self.calls) - 1]
        self.m.get = fake_get
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.m.listing()
        return json.loads(out.getvalue())["sessions"]

    def test_follows_cursor_and_sorts_newest_first(self):
        got = self.run_list([
            {"data": [session(1), session(3)], "next_cursor": "c2"},
            {"data": [session(2)], "next_cursor": None},
        ])
        self.assertEqual([s["id"] for s in got], ["cse_0003", "cse_0002", "cse_0001"])
        self.assertEqual(self.calls[1][1].get("cursor"), "c2")
        self.assertEqual(self.calls[0][0], "/v1/code/sessions")

    def test_archived_sessions_are_left_out(self):
        got = self.run_list([{"data": [session(1), session(2, status="archived")]}])
        self.assertEqual([s["id"] for s in got], ["cse_0001"])

    def test_output_fields(self):
        s = self.run_list([{"data": [session(4, unread=True)]}])[0]
        self.assertEqual(s["title"], "session 4")
        self.assertEqual(s["env"], "bridge")
        self.assertEqual(s["line"], "line 4")
        self.assertTrue(s["unread"])
        self.assertEqual(s["url"], "https://claude.ai/code/cse_0004")
        self.assertGreater(s["updated"], 0)

    def test_stops_after_ten_pages(self):
        self.run_list([{"data": [], "next_cursor": "again"}] * 20)
        self.assertEqual(len(self.calls), 10)

    def test_bad_timestamp_is_zero(self):
        self.assertEqual(self.m.ms("not a date"), 0)


class LoginTests(unittest.TestCase):
    def test_missing_login_is_an_error_before_any_request(self):
        m = load()
        with tempfile.TemporaryDirectory() as home:
            m.HOME = home
            m.urllib.request.urlopen = lambda *a, **k: self.fail("no request without a login")
            with self.assertRaises(PermissionError):
                m.get("/v1/code/sessions")


if __name__ == "__main__":
    unittest.main()
