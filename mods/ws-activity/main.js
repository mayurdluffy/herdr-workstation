// @ts-check
// Activity (the status bar's "activity" block): watches every agent's state.
// - The Dock badge counts the agents that need you or finished while you weren't looking.
// - While Herdr isn't the app in front, an agent that needs you or finishes posts a system
//   notification (Herdr's own toast is inside the window, where you aren't). The bell
//   turns that off; Herdr's sounds and toasts are its own (Settings > Alerts).
// - Comments queued for a busy agent go to it once it stops working.
// - "Next" goes to the agent that needs you most.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, theme, run, exec, window, setBadge, checking, shared, setShared, notify } from "herdr";
import { comments, send, agentLabel, updateComments } from "./comments.js";

export const ALERTS = "ws.alerts"; // { system: boolean }
const TICK = 750;
// Keys of features that are gone: emptied once, so shared.json doesn't carry them forever.
const OBSOLETE = ["ws.browser.sessions", "ws.browser.active", "ws.turns"];
const ICON = (name) => `mods/ws-activity/icons/${name}.svg`;

/** Agents that need the person: blocked (a question), or done while they weren't looking. */
export const needsYou = (status) => status === "blocked" || status === "done";

/** The agent to go to next: a question first, then a finished one; the longest-waiting first. */
export function nextAgent(list) {
  const rank = (a) => (a.status === "blocked" ? 0 : 1);
  return list.filter((a) => needsYou(a.status)).sort((a, b) => rank(a) - rank(b) || a.seq - b.seq)[0] ?? null;
}

/** Which system notification a state change earns, if any. */
export function alertFor(was, is) {
  if (was === undefined || was === is) return null;
  if (is === "blocked") return "blocked";
  if (is === "done" && (was === "working" || was === "blocked")) return "done";
  // Finished on the tab Herdr shows: idle, not done, though the person may be in another app.
  if (is === "idle" && was === "working") return "done";
  return null;
}

/** Posts a notification through the system, which shows it over other apps. */
function systemNotify(title, body) {
  const mac = window()?.platform === "macos";
  const [cmd, args] = mac
    ? ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]]
    : ["notify-send", ["--app-name=Herdr", title, body]];
  exec(cmd, args).catch(() => null);
}

export default class Activity extends View {
  init(_props, cx) {
    this.last = new Map();     // agent address -> its status at the last tick
    this.badge = undefined;
    this.attention = 0;
    this.sending = new Set();  // agents queued comments are going to now
    if (checking()) return;
    for (const k of OBSOLETE) if (shared(k) != null) setShared(k, null);
    this.tick(cx, true);
    cx.timer.every(TICK, (cx) => this.tick(cx, false));
  }

  alerts() {
    const a = /** @type {any} */ (shared(ALERTS));
    return { system: a?.system !== false };
  }

  tick(cx, first) {
    const list = agents();
    const seen = new Set();
    for (const a of list) {
      seen.add(a.address);
      const was = first ? undefined : this.last.get(a.address);
      if (!first && was === a.status) continue;
      this.last.set(a.address, a.status);
      this.changed(a, was);
    }
    for (const address of [...this.last.keys()]) if (!seen.has(address)) this.last.delete(address);
    const attention = list.filter((a) => needsYou(a.status)).length;
    const text = attention ? String(attention) : null;
    if (text !== this.badge) { this.badge = text; setBadge(text); }
    if (attention !== this.attention) { this.attention = attention; cx.notify(); }
    this.dispatch(list, cx);
  }

  changed(a, was) {
    const alert = alertFor(was, a.status);
    if (alert && this.alerts().system && window()?.active === false) {
      const who = `${a.program?.name ?? a.app ?? "Agent"} · ${a.space_name} › ${a.tab_name}`;
      systemNotify(alert === "blocked" ? "Needs you" : "Finished", who);
    }
  }

  // Comments queued for a busy agent go once it has stopped (done or idle; never into a question).
  dispatch(list, cx) {
    const queued = comments().filter((c) => c.queued);
    if (!queued.length) return;
    const byAgent = new Map();
    for (const c of queued) byAgent.set(c.agent, [...(byAgent.get(c.agent) ?? []), c]);
    for (const [agent, group] of byAgent) {
      const status = list.find((a) => a.address === agent)?.status;
      if (this.sending.has(agent) || (status !== "done" && status !== "idle")) continue;
      this.sending.add(agent);
      cx.spawn(async (_cx) => {
        const err = await send(agent, group, { now: true });
        this.sending.delete(agent);
        if (!err) notify({ title: `Sent ${group.length} queued comment${group.length === 1 ? "" : "s"}`, body: agentLabel(agent), level: "success", timeout: 3000 });
        else {
          updateComments(group.map((c) => c.id), { queued: false });
          notify({ title: "Queued comments not sent", body: `${agentLabel(agent)}: ${err}`, level: "error" });
        }
      });
    }
  }

  render(_cx) {
    const t = theme();
    const list = agents();
    const next = nextAgent(list);
    const queued = comments().filter((c) => c.queued).length;
    const system = this.alerts().system;
    const chip = (id) => h_flex().id(id).h(20).px(6).gap(5).flex_none().items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground));
    return h_flex().size_full().px(8).gap(4).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .when(queued > 0, (el) => el.child(chip("act-queued").tooltip("Comments waiting for their agent to finish; they go by themselves")
        .on_click(() => { run("layout.select", { stack: "panel-body", child: "ws-comments" }); run("layout.show", { id: "panel" }); })
        .child(div().child(`${queued} queued`))))
      .when(Boolean(next), (el) => el.child(chip("act-next").text_color(next.status === "blocked" ? t.blocked : t.foreground)
        .tooltip(`Go to ${agentLabel(next.address)}`)
        .on_click(() => run("agent.focus", { terminal: next.address }))
        .child(div().size(6).rounded(3).flex_none().bg(next.status === "blocked" ? t.blocked : (t.done ?? t.accent)))
        .child(div().min_w(0).truncate().child(`Next: ${next.program?.name ?? next.app ?? "agent"}`))
        .child(div().text_color(t.dim).child("›"))))
      .child(chip("act-bell").text_color(system ? t.muted : t.dim)
        .tooltip(`${system ? "System notifications on" : "System notifications off"} (while Herdr isn't in front). Click to switch.`)
        .on_click(() => setShared(ALERTS, { ...this.alerts(), system: !system }))
        .child(svg(ICON(system ? "bell" : "bell-off")).size(13).flex_none()));
  }
}
