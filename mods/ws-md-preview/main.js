// @ts-check
// Markdown preview pane: props { file }. Renders the file, reloads when it changes,
// comments on a selection (file and lines go with it), and opens the file in plannotator.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { readTextFile, watchFolder, theme, props, panes, agents, focused, exec, notify, openOverlay } from "herdr";

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.split("/").pop() ?? p;

export default class MdPreview extends View {
  init(_props, cx) {
    this.file = props()?.file ?? null;
    this.text = null;
    this.error = null;
    this.selection = null;
    this.watch = null;
    if (!this.file) return;
    this.load(cx);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          this.watch = watchFolder(dirname(this.file));
          const paths = await this.watch;
          if (!paths.length) return; // cancelled
          if (paths.some((p) => p === this.file || p === dirname(this.file))) this.load(cx);
        }
      } catch {
        // Watching failed (too many watches): the Reload button still works.
      }
    });
  }

  async close(_cx) {
    this.watch?.cancel();
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.file);
        this.text = text;
        this.error = text === null ? "File not found (or larger than 1 MiB)" : null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // The agent this pane works beside: an agent in the same tab, else the focused one.
  agent() {
    const mine = panes().find((p) => p.mod === "ws-md-preview" && p.pane === props()?.pane);
    const tab = mine?.tab ?? focused()?.tab;
    const list = agents();
    return list.find((a) => a.tab === tab && a.focused) ?? list.find((a) => a.tab === tab) ?? list.find((a) => a.focused) ?? null;
  }

  // The selection's lines, from where it sits in the Markdown source.
  lines() {
    const r = this.selection?.range;
    if (!r || this.text === null) return "";
    const first = this.text.slice(0, r.start).split("\n").length;
    const last = this.text.slice(0, Math.max(r.start, r.end - 1)).split("\n").length;
    return first === last ? `:${first}` : `:${first}-${last}`;
  }

  comment() {
    if (!this.selection) return;
    const quote = this.selection.range ? this.text.slice(this.selection.range.start, this.selection.range.end) : this.selection.text;
    openOverlay({ mod: "ws-comment", kind: "dialog", width: 560,
      props: { source: "markdown", where: `${this.file}${this.lines()}`, quote, agent: this.agent()?.address } });
  }

  annotate(cx) {
    const agent = this.agent();
    cx.spawn(async (_cx) => {
      const args = ["hc", "open", this.file, ...(agent ? ["--terminal", agent.address] : [])];
      const r = await exec("plannotator-tui", args, { timeout: 60000 }).catch((e) => ({ code: 127, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Annotate", body: String(r.stderr).trim().slice(0, 200) || "plannotator-tui failed", level: "error" });
    });
  }

  button(id, label, onClick, t) {
    return div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  render(_cx) {
    const t = theme();
    const header = h_flex().h(36).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().truncate().child(this.file ? basename(this.file) : "Markdown preview"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.file ? dirname(this.file) : ""))
      .when(Boolean(this.selection), (e) => e.child(this.button("md-comment", `Comment${this.lines() ? ` on ${this.lines().slice(1)}` : ""}`, () => this.comment(), t)))
      .when(Boolean(this.file), (e) => e
        .child(this.button("md-annotate", "Annotate", (cx) => this.annotate(cx), t))
        .child(this.button("md-reload", "Reload", (cx) => this.load(cx), t)));
    const body = !this.file
      ? div().p(16).text_color(t.dim).child("No file. Open one from the Workstation menu, or Ctrl-click a .md path in a terminal.")
      : this.error
        ? div().p(16).text_color(t.ansi1).child(this.error)
        : this.text === null
          ? div().p(16).text_color(t.dim).child("Loading…")
          : div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14)
            .child(TextView.markdown("md-body", this.text).selectable(true)
              .on_selection_change((s, cx) => { this.selection = s ?? null; cx.notify(); }));
    return v_flex().id("ws-md-preview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13.5)
      .child(header).child(body);
  }
}
