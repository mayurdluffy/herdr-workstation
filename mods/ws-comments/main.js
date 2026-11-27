// @ts-check
// The comment tray (panel): every comment waiting to go to an agent, grouped by
// agent, the current tab's agent first. Send one, send all, copy, or drop them.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, settings, notify, run, exec } from "herdr";
import { comments, removeComments, currentAgent, agentLabel, send, format } from "./comments.js";

const SOURCE = { file: "File", markdown: "Markdown", diff: "Change", commit: "Commit", terminal: "Terminal" };

export default class Comments extends View {
  init(_props, _cx) {
    this.busy = null;   // agent address being sent to
    this.error = null;
  }

  sendTo(agent, list, cx) {
    if (this.busy) return;
    this.busy = agent;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const err = await send(agent, list);
      this.busy = null;
      if (err) this.error = `${agentLabel(agent)}: ${err}`;
      else notify({ title: `Sent ${list.length} comment${list.length === 1 ? "" : "s"}`, body: agentLabel(agent), level: "success", timeout: 2500 });
      cx.notify();
    });
  }

  copy(list, cx) {
    // Herdr has no clipboard write: hand the text to the platform's copy tool as an argument.
    cx.spawn(async (_cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$1" | (pbcopy 2>/dev/null || wl-copy 2>/dev/null || xclip -selection clipboard)', "copy", format(list)])
        .catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      notify(r.code === 0 ? { title: "Copied comments", level: "success", timeout: 2000 } : { title: "Copy failed", body: r.stderr.trim(), level: "error" });
    });
  }

  small(id, label, onClick, t) {
    return div().id(id).h(22).px(7).flex().items_center().rounded(5).text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  card(c, t, mono) {
    const quote = c.quote.length > 600 ? `${c.quote.slice(0, 600)}…` : c.quote;
    return v_flex().id(`wc-${c.id}`).p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.accent).child(SOURCE[c.source] ?? c.source))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(c.where))
        .child(this.small(`wc-send-${c.id}`, "Send", (cx) => this.sendTo(c.agent, [c], cx), t))
        .child(this.small(`wc-del-${c.id}`, "✕", () => removeComments([c.id]), t)))
      .when(Boolean(quote.trim()), (e) => e.child(div().pl(8).border_l(2).border_color(t.border).font_family(mono).text_size(11.5).text_color(t.muted).child(quote)))
      .when(Boolean(c.note.trim()), (e) => e.child(div().text_size(12.5).child(c.note)));
  }

  group(agent, list, current, t, mono) {
    const busy = this.busy === agent;
    return v_flex().gap(8)
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(current ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(agentLabel(agent))))
      .children(list.map((c) => this.card(c, t, mono)))
      .child(h_flex().gap(8).items_center()
        .child(div().id(`wc-all-${agent}`).flex_1().h(30).flex().items_center().justify_center().rounded(7).cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).text_size(12.5)
          .on_click((_e, cx) => this.sendTo(agent, list, cx))
          .child(busy ? "Sending…" : list.length === 1 ? "Send comment" : `Send all ${list.length}`))
        .child(this.small(`wc-copy-${agent}`, "Copy", (cx) => this.copy(list, cx), t))
        .child(this.small(`wc-clear-${agent}`, "Clear", () => removeComments(list.map((c) => c.id)), t)));
  }

  render(_cx) {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const all = comments();
    const current = currentAgent()?.address ?? null;
    const byAgent = new Map();
    for (const c of all) byAgent.set(c.agent, [...(byAgent.get(c.agent) ?? []), c]);
    const order = [...byAgent.keys()].sort((a, b) => (a === current ? -1 : b === current ? 1 : 0));
    return v_flex().id("ws-comments").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Comments"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(all.length)))
        .child(div().flex_1())
        .child(this.small("wc-add-terminal", "+ From terminal", () => run("mod.open", { name: "ws-comment" }), t)))
      .when(Boolean(this.error), (e) => e.child(div().px(14).py(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(div().id("wc-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().p(12).gap(18)
          .when(all.length === 0, (e) => e.child(v_flex().gap(6).p(4).text_size(12.5).text_color(t.dim)
            .child(div().text_color(t.muted).child("No comments yet."))
            .child(div().child("Select text in Files, Review, Git graph, a Markdown preview or a terminal, then Comment. Comments wait here until you send them to the agent as one message."))))
          .children(order.map((agent) => this.group(agent, byAgent.get(agent), agent === current, t, mono)))));
  }
}
