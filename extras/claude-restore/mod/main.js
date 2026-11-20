import { View, div } from "gpui-kit";
import { exec, checking } from "herdr";

// Runs once when the window opens: restores Claude sessions in terminals that came back
// as idle shells. The logic lives in ~/.claude/hooks/claude-restore-run.sh. No panel:
// sessions that can't be restored show in the agents mod's Offline section.
export default class ClaudeRestore extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        await exec("sh", ["-c", "$HOME/.claude/hooks/claude-restore-run.sh"], { timeout: 60000 });
      } catch (e) {
        // Records are kept on failure, so the Offline section still shows them.
      }
      cx.notify();
    });
  }

  render(_cx) {
    return div().size_0();
  }
}
