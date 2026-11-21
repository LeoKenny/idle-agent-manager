// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// Cloned from Herdr's `agents` mod, plus an Offline group: Claude sessions that aren't
// running, on this machine and every connected one (listed by offline.py).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, readTextFile, appHome, machines, checking, notify } from "herdr";

const OFF_FOLDS = ["off", "off-int", "off-closed", "off-remote"];
const SCRIPT = "mods/idle-agent-manager/offline.py";
// claude.ai sessions; read-only, signs in with Claude Code's login (see claude_ai.py).
const CLOUD = "mods/idle-agent-manager/claude_ai.py";
const CLOUD_EVERY = 4; // timer ticks of 30 s: claude.ai every 2 minutes
const bridgeOf = (id) => String(id ?? "").split("_").slice(1).join("_");
const offKey = (s) => `${s.machine ?? ""}|${s.id || s.record}`;
const base = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop() || p || "";
const offTitle = (s) => s.custom || s.ai || s.prompt || s.shared || base(s.cwd) || "Claude session";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    // Offline: sessions per machine ("" is this one), hidden rows, remembered folds.
    this.offline = {};
    this.running = {};
    this.bridges = {};
    this.cloud = { sessions: [], error: null };
    this.ticks = 0;
    try { this.hidden = new Set(JSON.parse(localStorage.getItem("offHidden") ?? "[]")); } catch { this.hidden = new Set(); }
    let folds;
    try { folds = JSON.parse(localStorage.getItem("offFold") ?? "null"); } catch { folds = null; }
    folds = folds && typeof folds === "object" ? folds : { "off-closed": true };
    for (const id of OFF_FOLDS) if (folds[id]) this.folded.add(id);
    this.armed = null;
    cx.timer.every(30000, (cx) => {
      this.refreshOffline(cx);
      if (++this.ticks % CLOUD_EVERY === 0) this.refreshCloud(cx);
      cx.notify();
    });
    if (!checking()) {
      this.refreshOffline(cx);
      this.refreshCloud(cx);
    }
  }

  // Sessions on claude.ai; on failure the last list stays and the error shows in Remote.
  refreshCloud(cx) {
    if (this.cloudBusy || checking()) return;
    this.cloudBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/${CLOUD}`, "list"], { timeout: 60000 });
        const d = JSON.parse(r.stdout || "{}");
        if (d.error) this.cloud.error = d.error;
        else this.cloud = { sessions: (d.sessions ?? []).map((s) => ({ ...s, kind: "remote", off: true, machine: null })), error: null };
      } catch (e) {
        this.cloud.error = String(e);
      } finally {
        this.cloudBusy = false;
      }
      cx.notify();
    });
  }

  // claude.ai sessions that no machine here has a transcript or running session for.
  remoteItems() {
    const known = new Set(Object.values(this.bridges).flat());
    return this.cloud.sessions.filter((s) => !known.has(bridgeOf(s.id)) && !this.hidden.has(offKey(s)));
  }

  openUrl(url) {
    exec("xdg-open", [url]).then((r) => { if (r.code !== 0) throw new Error(r.stderr); })
      .catch(() => exec("explorer.exe", [url]).catch((e) => notify({ title: "Open in browser", body: String(e), level: "error" })));
  }

  remoteRow(t, s, now) {
    const key = offKey(s);
    const hovered = this.hovered === `off-${key}`;
    return h_flex()
      .id(`off-${key}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip([s.title, s.line, s.env === "bridge" ? "Remote Control session on claude.ai" : "Cloud session on claude.ai", "Click: open on claude.ai"].filter(Boolean).join("\n"))
      .on_hover((on, cx) => {
        if (on) this.hovered = `off-${key}`;
        else if (this.hovered === `off-${key}`) this.hovered = null;
        cx.notify();
      })
      .on_click(() => this.openUrl(s.url))
      .child(h_flex().w(16).flex_none().items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("\u2601")))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).max_w(170).truncate().text_color(t.muted).child(s.title || "Claude session"))
        .when(Boolean(s.line), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${s.line}`))))
      .when(hovered, (el) => el.child(div()
        .id(`off-hide-${key}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .tooltip("Hide from this list")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.hide(s);
          this.hovered = null;
          cx.notify();
        })
        .child(svg("mods/workspace-chrome/x.svg").size(13))))
      .when(!hovered, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(s.updated ? duration(now - s.updated) : "")));
  }

  // Runs offline.py on this machine and each connected one; a machine that fails keeps its last list.
  refreshOffline(cx) {
    if (this.refreshing || checking()) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        this.src ??= await readTextFile(`${appHome()}/${SCRIPT}`);
        if (!this.src) return;
        const names = [null, ...machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name)];
        // Restore cut-off sessions once per machine per app run, the first time it answers.
        // Kept on globalThis so saving the mod (which re-runs init) doesn't restore again.
        const restored = (globalThis.__idleAgentRestored ??= new Set());
        await Promise.all(names.map(async (on) => {
          try {
            if (!restored.has(on ?? "")) {
              const r = await exec("python3", ["-I", "-c", this.src, "restore"], { on, timeout: 60000 });
              if (r.code === 0) restored.add(on ?? "");
            }
            const r = await exec("python3", ["-I", "-c", this.src, "list"], { on, timeout: 60000 });
            if (r.code !== 0) return;
            const d = JSON.parse(r.stdout);
            this.offline[on ?? ""] = (d.sessions ?? []).map((s) => ({ ...s, machine: on, off: true }));
            this.running[on ?? ""] = d.running ?? [];
            this.bridges[on ?? ""] = d.bridges ?? [];
          } catch {}
        }));
        const known = new Set(["", ...names.filter(Boolean)]);
        for (const k of Object.keys(this.offline)) if (!known.has(k)) { delete this.offline[k]; delete this.running[k]; delete this.bridges[k]; }
      } finally {
        this.refreshing = false;
      }
      cx.notify();
    });
  }

  // One list across machines: running anywhere drops it; a transcript copied to
  // several machines shows once, from where its folder exists (then the newest).
  offlineItems() {
    const running = new Set(Object.values(this.running).flat());
    const best = new Map();
    for (const s of Object.values(this.offline).flat()) {
      if (s.id && running.has(s.id)) continue;
      const k = s.id || offKey(s);
      const cur = best.get(k);
      if (!cur) { best.set(k, { ...s, copies: [s.machine] }); continue; }
      cur.copies.push(s.machine);
      if ((s.cwd_ok && !cur.cwd_ok) || (s.cwd_ok === cur.cwd_ok && s.updated > cur.updated)) best.set(k, { ...s, copies: cur.copies });
    }
    const items = [...best.values()].filter((s) => !this.hidden.has(offKey(s))).sort((a, b) => b.updated - a.updated);
    // A /rename title several rows share tells them apart from nothing: use the summary there.
    const uses = new Map();
    for (const s of items) if (s.custom) uses.set(s.custom, (uses.get(s.custom) ?? 0) + 1);
    return items.map((s) => (s.custom && uses.get(s.custom) > 1 ? { ...s, custom: "", shared: s.custom } : s));
  }

  // A new tab running `claude --resume <id>` in the session's folder: in its old space
  // when that's still there, else the current space if on the session's machine, else
  // another space there, else a new space there.
  resume(s) {
    const argv = s.id ? ["claude", "--resume", s.id] : ["claude", "--continue"];
    const folder = s.cwd_ok ? s.cwd : undefined;
    const mine = (sp) => (sp.machine ?? null) === (s.machine ?? null);
    const all = spaces();
    const old = s.space ? (s.machine ? `${s.machine}/${s.space}` : s.space) : null;
    const here = all.find((sp) => sp.id === focused()?.space);
    const space = all.find((sp) => sp.id === old && mine(sp)) ?? (here && mine(here) ? here : all.find(mine));
    if (space) run("tab.new", { space: space.id, folder, argv });
    else run("space.new", { machine: s.machine ?? "", folder, argv });
    // Records without a session id are restored by hand only once.
    if (!s.id && s.record) this.offlineCall(s, ["forget", s.record]);
  }

  hide(s) {
    this.hidden.add(offKey(s));
    localStorage.setItem("offHidden", JSON.stringify([...this.hidden]));
  }

  // Deletes the transcript on every machine that has a copy (a record without an id: forgets the record).
  remove(s) {
    if (!s.id) return this.offlineCall(s, ["forget", s.record]);
    for (const on of s.copies ?? [s.machine]) this.offlineCall({ ...s, machine: on }, ["delete", s.id]);
  }

  offlineCall(s, args) {
    if (!this.src) return;
    exec("python3", ["-I", "-c", this.src, ...args], { on: s.machine, timeout: 30000 })
      .then((r) => { if (r.code !== 0) notify({ title: "Offline session", body: (r.stderr || r.stdout).trim().split("\n").pop(), level: "error" }); })
      .catch((e) => notify({ title: "Offline session", body: String(e), level: "error" }));
    const k = s.id || offKey(s);
    for (const m of Object.keys(this.offline)) this.offline[m] = this.offline[m].filter((x) => (x.id || offKey(x)) !== k);
  }

  offlineRow(t, s, now) {
    const key = offKey(s);
    const hovered = this.hovered === `off-${key}`;
    const armed = this.armed?.key === key;
    const hint = [offTitle(s), s.cwd, s.machine ? `on ${s.machine}` : null, s.reason, s.cwd_ok ? null : "folder missing: opens in home"].filter(Boolean).join("\n");
    const btn = (id, child, tip, act) => div()
      .id(`${id}-${key}`)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        act(cx);
        cx.notify();
      })
      .child(child);
    const hideBtn = btn("off-hide", svg("mods/workspace-chrome/x.svg").size(13), "Hide from this list", () => {
      this.hide(s);
      this.hovered = null;
    });
    const delBtn = btn("off-del",
      div().px(2).text_size(10.5).font_semibold().text_color(armed ? t.blocked : t.dim).child(armed ? "Confirm delete" : s.id ? "Delete" : "Forget"),
      s.id ? "Delete the transcript for good (click twice)" : "Forget this restore record (click twice)",
      (cx) => {
        if (armed && Date.now() - this.armed.at < 3000) {
          this.armed = null;
          this.hovered = null;
          this.remove(s);
          return;
        }
        this.armed = { key, at: Date.now() };
        cx.timer.after(3000, (cx) => {
          if (this.armed?.key === key) this.armed = null;
          cx.notify();
        });
      });
    return h_flex()
      .id(`off-${key}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(hint)
      .on_hover((on, cx) => {
        if (on) this.hovered = `off-${key}`;
        else if (this.hovered === `off-${key}`) { this.hovered = null; if (armed) this.armed = null; }
        cx.notify();
      })
      .on_click((_e, cx) => {
        this.resume(s);
        cx.timer.after(5000, (cx) => this.refreshOffline(cx));
      })
      .child(h_flex().w(16).flex_none().items_center().justify_center()
        .child(s.kind === "interrupted"
          ? div().text_size(12).text_color(t.blocked).child("⚠")
          : svg("mods/workspace-chrome/archive.svg").size(13).text_color(t.dim)))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).max_w(170).truncate().text_color(t.muted).child(offTitle(s)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${base(s.cwd) || "~"}${s.terminal ? ` · ${s.terminal}` : ""}`)))
      .when(Boolean(s.machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(s.machine)))
      .when(hovered || armed, (el) => el.child(hideBtn).child(delBtn))
      .when(!hovered && !armed, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - s.updated))));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .when(Boolean(g.sub), (el) => el.pl(18))
        .pt(g.sub ? 4 : 8)
        .h(g.sub ? 24 : 30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          if (OFF_FOLDS.includes(g.id)) localStorage.setItem("offFold", JSON.stringify(Object.fromEntries(OFF_FOLDS.map((id) => [id, this.folded.has(id)]))));
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open || OFF_FOLDS.includes(g.id), (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    // Offline sessions. Grouped by space, an interrupted one whose space is still
    // there goes under that space; the rest go to the Offline group at the bottom.
    const offline = collapsed ? [] : this.offlineItems();
    const spaceIds = new Map(spaces().map((sp) => [sp.id, sp]));
    const homeless = [];
    for (const s of offline) {
      const sid = s.kind === "interrupted" && s.space ? (s.machine ? `${s.machine}/${s.space}` : s.space) : null;
      if (byPriority || !sid || !spaceIds.has(sid)) { homeless.push(s); continue; }
      const g = groups.find((g) => g.id === `sp-${sid}`);
      if (g) g.members.push(s);
      else groups.push({ id: `sp-${sid}`, label: spaceIds.get(sid).name || "", status: null, members: [s] });
    }
    const ints = homeless.filter((s) => s.kind === "interrupted");
    const closed = homeless.filter((s) => s.kind !== "interrupted");
    const remote = collapsed ? [] : this.remoteItems();
    const remoteError = !collapsed && !remote.length && this.cloud.error;
    const offAll = [...homeless, ...remote];
    const offRows = offAll.length || remoteError
      ? [header({ id: "off", label: "Offline", status: null, members: offAll }),
        ...(this.folded.has("off") ? [] : [[ints, "off-int", "Interrupted"], [closed, "off-closed", "Closed"], [remote, "off-remote", "Remote"]]
          .filter(([m, id]) => m.length || (id === "off-remote" && remoteError))
          .flatMap(([m, id, label]) => [header({ id, label, status: null, members: m, sub: true }), ...(this.folded.has(id) ? [] : id === "off-remote"
            ? (m.length ? m.map((s) => this.remoteRow(t, s, now)) : [div().px(12).py(4).text_size(11.5).text_color(t.dim).child(`claude.ai: ${remoteError}`)])
            : m.map((s) => this.offlineRow(t, s, now)))]))]
      : [];
    const member = (a, i) => (a.off ? [this.offlineRow(t, a, now)] : withKids(a, i));
    const rows = collapsed
      ? list.flatMap(withKids)
      : [...groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(member))]), ...offRows];

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "idle-agent-manager", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && offRows.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
