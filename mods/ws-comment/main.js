// @ts-check
// Add one comment: a dialog with the quoted text and a note box.
// props { source, where, quote, agent? } from another mod; with no props it
// comments on the focused terminal's selected text (cmd-shift-m).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
import { props, closeOverlay, theme, focused, panes, run, exec, notify, window, settings } from "herdr";
import { addComment, currentAgent, agentLabel, send } from "./comments.js";

// The selection Herdr just copied. Terminals copy on select, so this is the selection.
async function clipboard() {
  const mac = window()?.platform === "macos";
  // pbpaste turns non-ASCII into "?" unless the locale says UTF-8.
  const tries = mac ? [["sh", ["-c", "LANG=en_US.UTF-8 LC_CTYPE=en_US.UTF-8 pbpaste"]]] : [["wl-paste", ["--no-newline"]], ["xclip", ["-o", "-selection", "clipboard"]], ["xsel", ["-ob"]]];
  for (const [cmd, args] of tries) {
    const r = await exec(cmd, args).catch(() => null);
    if (r && r.code === 0) return r.stdout;
  }
  return "";
}

export default class Comment extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const agent = p.agent ? { address: p.agent } : currentAgent();
    this.agent = agent?.address ?? null;
    this.source = p.source ?? "terminal";
    this.where = p.where ?? "";
    this.quote = p.quote ?? "";
    this.error = null;
    this.busy = false;
    this.note = TextareaState.new({ placeholder: "Your comment for the agent…", rows: 4 });
    this.note.on("submit", (_e, cx) => this.save(false, cx));
    this.note.focus();
    if (!p.source) this.fromTerminal(cx);
  }

  fromTerminal(cx) {
    const f = focused();
    const pane = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    const where = `terminal ${f?.terminal ?? "?"}${pane?.cwd ? ` (${pane.cwd.replace(/^\/Users\/[^/]+/, "~")})` : ""}`;
    this.where = where;
    if (!f?.selection) { this.error = "Select text in a terminal first."; return; }
    run("terminal.copy");
    cx.spawn(async (cx) => {
      await cx.sleep(80);
      this.quote = (await clipboard()).slice(0, 20000);
      if (!this.quote.trim()) this.error = "Couldn't read the selection.";
      cx.notify();
    });
  }

  close() {
    this.note.release();
    closeOverlay(props()?.overlay);
  }

  save(now, cx) {
    if (this.busy) return;
    if (!this.agent) { this.error = "No agent in this tab to send comments to."; cx.notify(); return; }
    const note = this.note.value();
    if (!note.trim() && !this.quote.trim()) { this.error = "Write a comment first."; cx.notify(); return; }
    const item = addComment({ agent: this.agent, source: this.source, where: this.where, quote: this.quote, note });
    if (!now) { this.close(); return; }
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const err = await send(this.agent, [item]);
      this.busy = false;
      if (err) { this.error = `Kept in the tray: ${err}`; cx.notify(); return; }
      notify({ title: "Sent to agent", body: agentLabel(this.agent), level: "success", timeout: 2500 });
      this.close();
    });
  }

  button(id, label, primary, onClick, t) {
    return h_flex().id(id).h(30).px(14).flex_none().items_center().rounded(7).border_1().border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  render(_cx) {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const quote = this.quote.length > 1200 ? `${this.quote.slice(0, 1200)}…` : this.quote;
    // As tall as its content: the header, the quote (if any), the note, the buttons.
    return v_flex().id("ws-comment").w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { cx.stop_propagation(); this.save(Boolean(e.modifiers?.shift), cx); }
      })
      .child(h_flex().gap(12).items_start()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(14.5).font_semibold().child("Comment"))
          .when(Boolean(this.where), (e) => e.child(div().truncate().text_size(12).text_color(t.dim).child(this.where))))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("esc")))
      .when(Boolean(quote), (e) => e.child(div().id("ws-comment-quote").max_h(160).overflow_y_scroll().px(10).py(8).rounded(6).bg(t.background)
        .border_l(3).border_color(t.accent).font_family(mono).text_size(12).text_color(t.muted).child(quote)))
      .child(div().id("ws-comment-note").px(10).py(8).rounded(8).border_1().border_color(t.accent).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.note).w_full().h(72).text_size(13)))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.agent ? `to ${agentLabel(this.agent)}` : "no agent in this tab"))
        .child(this.button("ws-comment-cancel", "Cancel", false, () => this.close(), t))
        .child(this.button("ws-comment-send", this.busy ? "Sending…" : "Send now", false, (cx) => this.save(true, cx), t))
        .child(this.button("ws-comment-add", "Add to tray", true, (cx) => this.save(false, cx), t)));
  }
}
