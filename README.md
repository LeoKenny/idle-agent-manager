# idle-agent-manager

A mod for the [Herdr](https://herdr.dev) desktop app: its Agents list, plus an **Offline**
group for Claude Code sessions that aren't running.

![Idle Agent Manager](preview.png)

| Section | What's in it | Click | Hover |
|---|---|---|---|
| **Interrupted** ⚠ | Sessions cut off by a reboot, crash or closed window (needs the claude-restore hooks) | Resume in a new tab, in its old space | Hide · Delete |
| **Closed** | Every other session on this computer and on Herdr's connected machines | Resume in a new tab | Hide · Delete |
| **Remote** ☁ | Sessions on claude.ai with no copy on any machine | Open on claude.ai | Hide |

Delete asks for a second click and then removes everything Claude Code keeps for the
session (transcript, subagents, file-history, session-env, debug log, job folder, leftover
session files, scratch output, its prompt-history lines after a backup), on every machine
that has a copy. See [RECIPE.md](RECIPE.md) for every detail.

## What it touches

- **Runs programs**: `python3` (its own two scripts) here and, through herdr-core, on
  connected machines; `hc get`; `xdg-open` / `explorer.exe` to open claude.ai links.
- **Reads** outside its folder: `~/.claude/` (transcripts, session and job files, history),
  the claude-restore records, and **Claude Code's login** (`~/.claude/.credentials.json`) to
  list your claude.ai sessions.
- **Network**: `GET https://api.anthropic.com/v1/code/sessions` only. That endpoint isn't
  documented; it's the one Claude Code uses, and may change.
- **Writes**: a cache in `~/.cache/claude-offline/`; and, only when you confirm a Delete,
  removes that session's files and rewrites `~/.claude/history.jsonl` without its lines.

## Install

```sh
cp -r mods/idle-agent-manager ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/idle-agent-manager
```

Then point your layout's agents block at it. Herdr's `main` layout is read-only, so clone it
first:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
# in ~/.config/herdr-app/layouts/my-layout.json, the "agents" block:
#   "content": { "mod": "idle-agent-manager" }
```

### Optional: Interrupted sessions (claude-restore)

`extras/claude-restore/` has the hooks that record which terminal runs which Claude session,
and a background mod that resumes them when the window opens:

```sh
cp extras/claude-restore/hooks/*.sh ~/.claude/hooks/
cp -r extras/claude-restore/mod ~/.config/herdr-app/mods/claude-restore
```

and in `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-restore-track.sh start", "timeout": 10 }] }],
  "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-restore-track.sh end", "timeout": 10 }] }]
}
```

The background mod draws nothing, but Herdr only runs a mod that's in the layout. Add it
to your layout's `floating` list, where an empty mod takes no space (a normal block would
leave an empty panel):

```json
"floating": [{ "id": "claude-restore", "content": { "mod": "claude-restore" }, "edge": "bottom", "align": "start" }]
```

Do the same on each connected machine whose sessions you want restored.

## Tests

```sh
sh tests/run.sh
```

Runs the Python tests (`tests/test_offline.py`, `tests/test_claude_ai.py`) and, when Herdr is
installed, `herdr-app check` on the mod. The tests build a fake home folder with a fake `hc`
and never touch your real sessions or the network. The mod's JavaScript (merging, dedupe,
rows) is covered only by `herdr-app check` loading it, not by unit tests.

## Layout

```
mods/idle-agent-manager/   the mod (main.js, mod.json, offline.py, claude_ai.py)
extras/claude-restore/ optional hooks + background mod for Interrupted
tests/                 test set and runner
RECIPE.md              the brief to rebuild it from scratch (Herdr's sharing format)
preview.png            screenshot
```

## License

[MIT](LICENSE)
