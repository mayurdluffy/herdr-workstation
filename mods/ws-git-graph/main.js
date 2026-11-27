// @ts-check
// Git graph pane: props { folder?, commit? } (else the focused terminal's folder). Every branch's
// commits as a graph with refs; click one for its stat and diff, review it in plannotator
// or send it to the agent beside this pane.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, focused, panes, agents, settings, notify, window } from "herdr";

const SEP = "\x1f";
const LIMIT = 300;
const ROW = 22;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "color.ui=never"];
const LANE_COLORS = ["ansi4", "ansi5", "ansi2", "ansi3", "ansi6", "ansi1", "ansi12", "ansi13", "ansi10", "ansi11"];

/** One `git log --graph` line → { graph, sha?, refs[], subject, author, when }. */
export function parseLine(line) {
  const i = line.indexOf(SEP);
  if (i < 0) return { graph: line.replace(/\s+$/, ""), sha: null, refs: [], subject: "", author: "", when: "" };
  const [sha, refs, subject, author, when] = line.slice(i + 1).split(SEP);
  const list = (refs ?? "").trim().replace(/^\(|\)$/g, "").split(",").map((r) => r.trim()).filter(Boolean);
  return { graph: line.slice(0, i).replace(/\s+$/, ""), sha, refs: list, subject: subject ?? "", author: author ?? "", when: when ?? "" };
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.rows = [];
    this.root = null;
    this.branch = null;
    this.error = null;
    this.loading = false;
    this.selected = null;   // sha
    this.detail = [];       // lines of `git show`
    this.signature = null;  // refs + HEAD, to notice new commits
    this.folder = null;
    this.height = 0;        // px, from on_size_change: virtual lists need a definite height
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.poll(cx));
  }

  // The folder this graph follows: its prop, else the last terminal folder focused.
  target() {
    const fixed = props()?.folder;
    if (fixed) return fixed;
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return pane?.terminal ? pane.cwd : f?.terminal ? f.cwd : this.folder;
  }

  git(args) {
    return exec("git", [...READ, ...args], { cwd: this.root ?? this.target() ?? undefined });
  }

  poll(cx) {
    if (window()?.visible === false || this.loading || !this.root) return;
    const want = this.target();
    if (want && want !== this.folder) { this.refresh(cx); return; }
    cx.spawn(async (cx) => {
      const sig = await this.signatureNow();
      if (sig !== null && sig !== this.signature) this.refresh(cx);
    });
  }

  async signatureNow() {
    const r = await this.git(["for-each-ref", "--format=%(objectname) %(refname)"]).catch(() => null);
    const h = await this.git(["rev-parse", "HEAD"]).catch(() => null);
    return r && r.code === 0 ? `${h?.stdout ?? ""}${r.stdout}` : null;
  }

  refresh(cx) {
    const folder = this.target();
    if (!folder) { this.error = "No folder: focus a terminal in a git repository"; cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
        if (top.code !== 0) { this.root = null; this.rows = []; this.error = `Not a git repository: ${folder}`; return; }
        const root = top.stdout.trim();
        if (root !== this.root) { this.selected = null; this.detail = []; }
        this.root = root;
        this.folder = folder;
        const fmt = ["%h", "%d", "%s", "%an", "%ar"].join(SEP);
        const log = await this.git(["log", "--graph", "--all", "--date-order", "--decorate=short", `--format=${SEP}${fmt}`, `-n`, String(LIMIT)]);
        if (log.code !== 0) throw new Error(log.stderr.trim() || "git log failed");
        this.rows = log.stdout.replace(/\n$/, "").split("\n").filter(Boolean).map(parseLine);
        const b = await this.git(["branch", "--show-current"]);
        this.branch = b.stdout.trim() || "detached HEAD";
        this.signature = await this.signatureNow();
        this.error = this.rows.length ? null : "No commits yet";
        // props.commit: open with that commit selected (once).
        const want = props()?.commit;
        if (want && !this.opened) { this.opened = true; const row = this.rows.find((r) => r.sha && want.startsWith(r.sha)); if (row) this.pick(row.sha, cx); }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  pick(sha, cx) {
    if (this.selected === sha) { this.selected = null; this.detail = []; cx.notify(); return; }
    this.selected = sha;
    this.detail = ["Loading…"];
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.git(["show", "--stat", "--patch", "--no-ext-diff", "--format=%H%n%an <%ae>  ·  %ad%n%n%B", sha]);
      if (this.selected !== sha) return;
      const lines = (r.code === 0 ? r.stdout : r.stderr).replace(/\n$/, "").split("\n");
      this.detail = lines.slice(0, 1500).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l));
      if (lines.length > 1500) this.detail.push(`… ${lines.length - 1500} more lines (Review in plannotator shows all of it)`);
      cx.notify();
    });
  }

  agent() {
    const mine = panes().find((p) => p.mod === "ws-git-graph" && p.pane === props()?.pane);
    const tab = mine?.tab ?? focused()?.tab;
    const list = agents();
    return list.find((a) => a.tab === tab) ?? list.find((a) => a.focused) ?? null;
  }

  review(cx) {
    const agent = this.agent(), sha = this.selected;
    if (!sha) return;
    cx.spawn(async (_cx) => {
      const args = ["hc", "review", "--commit", sha, ...(agent ? ["--terminal", agent.address] : [])];
      const r = await exec("plannotator-tui", args, { timeout: 60000 }).catch((e) => ({ code: 127, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Review commit", body: String(r.stderr).trim().slice(0, 200) || "plannotator-tui failed", level: "error" });
    });
  }

  send(cx) {
    const agent = this.agent(), row = this.rows.find((r) => r.sha === this.selected);
    if (!agent || !row) { notify({ title: "Git graph", body: "No agent in this tab.", level: "warning" }); return; }
    cx.spawn(async (_cx) => {
      const message = `Look at commit ${row.sha} ("${row.subject}") in ${this.root}.`;
      const r = await exec("hc", ["send", agent.address, message]).catch((e) => ({ code: 1, stderr: String(e) }));
      notify(r.code === 0
        ? { title: "Sent to agent", body: `${row.sha} → ${agent.address}`, level: "success", timeout: 2500 }
        : { title: "Could not send", body: String(r.stderr).trim().slice(0, 200), level: "error" });
    });
  }

  graphCells(graph, t) {
    return [...graph].map((ch, i) => {
      const color = ch === "*" ? t.foreground : t[LANE_COLORS[Math.floor(i / 2) % LANE_COLORS.length]] ?? t.muted;
      return div().w(8).flex_none().text_color(color).when(ch === "*", (e) => e.font_semibold()).child(ch === "*" ? "●" : ch === " " ? "" : ch);
    });
  }

  refBadge(ref, t) {
    const head = ref.startsWith("HEAD");
    const tag = ref.startsWith("tag: ");
    const remote = !head && !tag && ref.includes("/");
    const color = head ? t.accent : tag ? t.ansi3 : remote ? t.ansi5 : t.ansi2;
    return div().flex_none().px(5).rounded(4).border_1().border_color(color).text_size(10.5).text_color(color)
      .child(ref.replace(/^HEAD -> /, "⌂ ").replace(/^tag: /, "🏷 "));
  }

  row(r, i, t) {
    const on = r.sha && r.sha === this.selected;
    return h_flex().id(`gg-${i}`).w_full().h(ROW).flex_none().px(10).gap(8).items_center().when(Boolean(r.sha), (e) => e.cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(r.sha, cx)))
      .when(Boolean(on), (e) => e.bg(t.selected))
      .child(h_flex().flex_none().items_center().children(this.graphCells(r.graph, t)))
      .when(Boolean(r.sha), (e) => e
        .child(div().flex_none().text_color(t.dim).child(r.sha))
        .children(r.refs.map((ref) => this.refBadge(ref, t)))
        .child(div().flex_1().min_w(0).truncate().child(r.subject))
        .child(div().flex_none().max_w(120).truncate().text_color(t.dim).child(r.author))
        .child(div().flex_none().w(84).text_right().truncate().text_color(t.dim).child(r.when)));
  }

  detailRow(line, i, t) {
    const kind = line.startsWith("+++") || line.startsWith("---") ? "file" : line[0];
    return div().id(`gd-${i}`).w_full().h(ROW - 2).flex_none().px(12).truncate()
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18").text_color(t.ansi2))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18").text_color(t.ansi1))
      .when(kind === "@", (e) => e.bg(t.raised).text_color(t.dim))
      .when(kind === "file" || line.startsWith("diff --git"), (e) => e.font_semibold())
      .child(line || " ");
  }

  button(id, label, onClick, t) {
    return div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  render(cx) {
    const t = theme();
    const want = this.target();
    if (!this.loading && want && want !== this.folder && !props()?.folder) this.refresh(cx);
    const mono = settings().font_family ?? "JetBrains Mono";
    const body = Math.max(0, this.height - 37);                 // below the header and its border
    const detailH = this.selected ? Math.floor(body / 2) : 0;
    const listH = Math.max(ROW, body - detailH);
    const repo = this.root ? this.root.split("/").pop() : "Git graph";
    const count = this.rows.filter((r) => r.sha).length;
    const header = h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(repo))
      .when(Boolean(this.branch), (e) => e.child(div().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.accent).child(this.branch)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.loading ? "Loading…" : `${count} commits${count >= LIMIT ? " (latest)" : ""}`))
      .child(this.button("gg-refresh", "Refresh", (cx) => this.refresh(cx), t));
    // Plain scroll areas with explicit heights: a virtual list never rendered its rows in a pane.
    const list = this.error && !this.rows.length
      ? div().p(16).text_color(t.dim).child(this.error)
      : div().id("gg-list").w_full().h(listH).flex_none().overflow_y_scrollbar().font_family(mono).text_size(12)
        .child(v_flex().w_full().children(this.rows.map((r, i) => this.row(r, i, t))));
    const detail = this.selected
      ? v_flex().w_full().h(detailH).flex_none().border_t(1).border_color(t.border)
        .child(h_flex().h(32).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
          .child(div().font_semibold().child(this.selected))
          .child(div().flex_1())
          .child(this.button("gg-review", "Review in plannotator", (cx) => this.review(cx), t))
          .child(this.button("gg-send", "Send to agent", (cx) => this.send(cx), t))
          .child(this.button("gg-close", "Close", (cx) => this.pick(this.selected, cx), t)))
        .child(div().id("gg-detail").w_full().h(Math.max(0, detailH - 33)).flex_none().overflow_y_scrollbar().font_family(mono).text_size(12)
          .child(v_flex().w_full().children(this.detail.map((l, i) => this.detailRow(l, i, t)))))
      : null;
    return v_flex().id("ws-git-graph").size_full().min_h(0).overflow_hidden().bg(t.background)
      .on_size_change((size, cx) => { this.height = size.height / (Number(settings().zoom) || 1); cx.notify(); }).text_color(t.foreground).text_size(12.5)
      .child(header).child(list).when(detail !== null, (e) => e.child(detail));
  }
}
