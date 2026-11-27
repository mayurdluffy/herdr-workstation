// @ts-check
// Workstation menu (mod.open:ws-menu): one popup for review, annotate, git graph,
// Markdown preview, browser and usage. It acts for the terminal that had focus
// when it opened, so a review's Send goes to that agent.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, agents, focused, panes, props, closeOverlay, notify, theme, run, pickFiles, setShared } from "herdr";

// Each item: key, label, hint, and what it does with the target terminal.
const ITEMS = [
  { key: "r", label: "Review changes", hint: "diff of uncommitted work, comments go to the agent", act: "review" },
  { key: "p", label: "Pick what to review", hint: "staged, unstaged, branch, a commit or a PR", act: "pick" },
  { key: "l", label: "Review the agent's last reply", hint: "annotate it and send feedback", act: "last" },
  { key: "d", label: "Annotate docs in this folder", hint: "Markdown tree with comments", act: "docs" },
  { key: "a", label: "Approve a plan…", hint: "pick a Markdown file: Approve or send feedback", act: "gate" },
  { key: "g", label: "Git graph", hint: "branches and commits beside this pane", act: "graph" },
  { key: "m", label: "Preview Markdown…", hint: "live preview beside this pane", act: "preview" },
  { key: "b", label: "Browser", hint: "open the live browser beside this agent", act: "browser" },
  { key: "u", label: "Refresh usage limits", hint: "Claude and Codex", act: "usage" },
];

export default class WsMenu extends View {
  init(_props, cx) {
    const f = focused();
    // The menu opens over the window; remember who it acts for before anything moves.
    this.terminal = f?.terminal ?? null;
    this.pane = f?.pane ?? null;
    this.cwd = (f?.pane ? panes().find((p) => p.pane === f.pane)?.cwd : null) ?? f?.cwd ?? null;
    this.agent = agents().find((a) => a.address === this.terminal) ?? null;
    this.busy = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  // Runs a command line; reports its output only when it fails.
  async call(label, cmd, args) {
    const r = await exec(cmd, args, { timeout: 60000 }).catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));
    if (r.code !== 0) {
      const missing = r.code === 127 || /not found|No such file/i.test(r.stderr);
      notify({
        title: label,
        body: missing ? `${cmd} is not installed. Run the workstation installer again.` : (r.stderr || r.stdout).trim().slice(0, 300),
        level: "error",
      });
    }
  }

  act(item, cx) {
    if (this.busy) return;
    const t = this.terminal;
    const target = t ? ["--terminal", t] : [];
    const needsTerminal = ["review", "pick", "last", "docs", "gate", "browser"];
    if (needsTerminal.includes(item.act) && !t) {
      notify({ title: item.label, body: "Focus a terminal (an agent's) first.", level: "warning" });
      this.close();
      return;
    }
    this.busy = item.label;
    cx.notify();
    cx.spawn(async (_cx) => {
      try {
        switch (item.act) {
          case "review": await this.call(item.label, "plannotator-tui", ["hc", "review", ...target]); break;
          case "pick": await this.call(item.label, "plannotator-tui", ["hc", "review", "--pick", ...target]); break;
          case "last": await this.call(item.label, "plannotator-tui", ["hc", "last", ...target]); break;
          case "docs": await this.call(item.label, "plannotator-tui", ["hc", "open", ...target]); break;
          case "gate": {
            const files = await pickFiles({ prompt: "Review" });
            if (files?.[0]) await this.call(item.label, "plannotator-tui", ["hc", "open", files[0], "--gate", ...target]);
            break;
          }
          case "graph":
            run("pane.split", { direction: "right", mod: "ws-git-graph", ...(this.pane ? { pane: this.pane } : {}), props: { folder: this.cwd } });
            break;
          case "preview": {
            const files = await pickFiles({ prompt: "Preview" });
            if (files?.[0]) run("pane.split", { direction: "right", mod: "ws-md-preview", ...(this.pane ? { pane: this.pane } : {}), props: { file: files[0] } });
            break;
          }
          case "browser": await this.call(item.label, "herdr-web-browser", ["--owner", t, "show"]); break;
          case "usage": setShared("usage-limits.refresh", Date.now()); break;
        }
      } finally {
        this.close();
      }
    });
  }

  render(_cx) {
    const th = theme();
    const who = this.agent ? `${this.agent.program?.name ?? this.agent.app ?? "agent"} · ${this.terminal}` : this.terminal ? `terminal ${this.terminal}` : "no terminal focused";
    return v_flex().id("ws-menu").size_full().bg(th.surface).p(6).gap(1).text_size(13).text_color(th.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); return; }
        const item = ITEMS.find((i) => i.key === e.key);
        if (item) { cx.stop_propagation(); this.act(item, cx); }
      })
      .child(div().px(10).py(6).text_size(11.5).text_color(th.muted).child(this.busy ? `${this.busy}…` : `Workstation · ${who}`))
      .children(ITEMS.map((item) =>
        h_flex().id(`ws-${item.act}`).px(10).py(6).gap(10).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(th.hover))
          .on_click((_e, cx) => this.act(item, cx))
          .child(div().w(18).h(18).flex_none().rounded(4).bg(th.raised).flex().items_center().justify_center()
            .text_size(11).text_color(th.muted).child(item.key.toUpperCase()))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().child(item.label))
            .child(div().truncate().text_size(11).text_color(th.dim).child(item.hint)))));
  }
}
