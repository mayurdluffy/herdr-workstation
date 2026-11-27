// @ts-check
// Git graph, as a panel (Graph button) or a pane. props { folder?, commit? }; without a
// folder it follows the focused terminal's repository. Every branch's commits with refs;
// click one for its diff. Comment on the commit or on diff lines (click, shift-click),
// review it in plannotator, or send it to the agent.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, focused, panes, agents, settings, notify, window, openOverlay } from "herdr";

const SEP = "\x1f";
const LIMIT = 300;
const DETAIL_LIMIT = 1500;
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

/** `git show` lines → each with the file and new-side line number it belongs to. */
export function locate(lines) {
  let file = null, line = 0;
  return lines.map((text) => {
    const header = /^\+\+\+ b\/(.*)$/.exec(text);
    if (header) { file = header[1]; return { text, file: null, line: null }; }
    if (text.startsWith("diff --git")) { file = null; return { text, file: null, line: null }; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) { line = +hunk[1]; return { text, file: null, line: null }; }
    if (!file || text.startsWith("---")) return { text, file: null, line: null };
    if (text[0] === "+" || text[0] === " ") return { text, file, line: line++ };
    if (text[0] === "-") return { text, file, line: Math.max(1, line - 1) };
    return { text, file: null, line: null };
  });
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.rows = [];
    this.root = null;
    this.branch = null;
    this.error = null;
    this.loading = false;
    this.selected = null;   // sha
    this.detail = [];       // located lines of `git show`
    this.range = null;      // { from, to } indexes into detail
    this.signature = null;  // refs + HEAD, to notice new commits
    this.folder = null;
    this.height = 0;        // px, from on_size_change: the lists need definite heights
    this.width = 0;
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
    if (!folder) { this.error = "Focus a terminal in a git repository"; cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
        this.folder = folder;
        if (top.code !== 0) { this.root = null; this.rows = []; this.error = `Not a git repository: ${folder}`; return; }
        const root = top.stdout.trim();
        if (root !== this.root) { this.selected = null; this.detail = []; this.range = null; }
        this.root = root;
        const fmt = ["%h", "%d", "%s", "%an", "%ar"].join(SEP);
        const log = await this.git(["log", "--graph", "--all", "--date-order", "--decorate=short", `--format=${SEP}${fmt}`, "-n", String(LIMIT)]);
        if (log.code !== 0) throw new Error(log.stderr.trim() || "git log failed");
        this.rows = log.stdout.replace(/\n$/, "").split("\n").filter(Boolean).map(parseLine);
        const b = await this.git(["branch", "--show-current"]);
        this.branch = b.stdout.trim() || "detached HEAD";
        this.signature = await this.signatureNow();
        this.error = this.rows.length ? null : "No commits yet";
        const want = props()?.commit;
        if (want && !this.opened) {
          this.opened = true;
          const row = this.rows.find((r) => r.sha && want.startsWith(r.sha));
          if (row) this.pick(row.sha, cx);
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  pick(sha, cx) {
    if (this.selected === sha) { this.selected = null; this.detail = []; this.range = null; cx.notify(); return; }
    this.selected = sha;
    this.detail = [{ text: "Loading…", file: null, line: null }];
    this.range = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.git(["show", "--stat", "--patch", "--no-ext-diff", "--format=%H%n%an  ·  %ad%n%n%B", sha]);
      if (this.selected !== sha) return;
      const lines = (r.code === 0 ? r.stdout : r.stderr).replace(/\n$/, "").split("\n");
      this.detail = locate(lines.slice(0, DETAIL_LIMIT).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l)));
      if (lines.length > DETAIL_LIMIT) this.detail.push({ text: `… ${lines.length - DETAIL_LIMIT} more lines (Review shows all of it)`, file: null, line: null });
      cx.notify();
    });
  }

  // Click a diff line to select it; shift-click extends the selection.
  selectLine(i, shift, cx) {
    if (shift && this.range) this.range = { from: Math.min(this.range.from, i), to: Math.max(this.range.from, i) };
    else this.range = this.range && this.range.from === i && this.range.to === i ? null : { from: i, to: i };
    cx.notify();
  }

  agent() {
    const mine = panes().find((p) => p.mod === "ws-git-graph" && p.pane === props()?.pane);
    const tab = mine?.tab ?? focused()?.tab;
    const list = agents();
    return list.filter((a) => a.tab === tab).sort((a, b) => b.seq - a.seq)[0] ?? list.find((a) => a.focused) ?? null;
  }

  comment() {
    const row = this.rows.find((r) => r.sha === this.selected);
    if (!row) return;
    let where = `commit ${row.sha} "${row.subject}"`, quote = "";
    if (this.range) {
      const picked = this.detail.slice(this.range.from, this.range.to + 1);
      const located = picked.filter((l) => l.file);
      if (located.length) {
        const file = located[0].file, first = located[0].line, last = located[located.length - 1].line;
        where = `commit ${row.sha} · ${file}:${first === last ? first : `${first}-${last}`}`;
      }
      quote = picked.map((l) => l.text).join("\n");
    }
    openOverlay({ mod: "ws-comment", kind: "dialog", width: 560, height: 420, props: { source: "commit", where, quote, agent: this.agent()?.address } });
  }

  review(_cx) {
    const agent = this.agent(), sha = this.selected;
    if (!sha) return;
    _cx.spawn(async (_cx) => {
      const args = ["hc", "review", "--commit", sha, ...(agent ? ["--terminal", agent.address] : [])];
      const r = await exec("plannotator-tui", args, { timeout: 60000, cwd: this.root ?? undefined }).catch((e) => ({ code: 127, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Review commit", body: String(r.stderr).trim().slice(0, 200) || "plannotator-tui failed", level: "error" });
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
    return div().flex_none().max_w(160).truncate().px(5).rounded(4).border_1().border_color(color).text_size(10.5).text_color(color)
      .child(ref.replace(/^HEAD -> /, "⌂ ").replace(/^tag: /, "tag "));
  }

  row(r, i, t, wide) {
    const on = r.sha && r.sha === this.selected;
    return h_flex().id(`gg-${i}`).w_full().h(ROW).flex_none().px(10).gap(8).items_center()
      .when(Boolean(r.sha), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(r.sha, cx)))
      .when(Boolean(on), (e) => e.bg(t.selected))
      .child(h_flex().flex_none().items_center().children(this.graphCells(r.graph, t)))
      .when(Boolean(r.sha), (e) => e
        .child(div().flex_none().text_color(t.dim).child(r.sha))
        .children(r.refs.map((ref) => this.refBadge(ref, t)))
        .child(div().flex_1().min_w(0).truncate().child(r.subject))
        .when(wide, (e) => e
          .child(div().flex_none().max_w(120).truncate().text_color(t.dim).child(r.author))
          .child(div().flex_none().w(84).text_right().truncate().text_color(t.dim).child(r.when))));
  }

  detailRow(l, i, t) {
    const kind = l.text.startsWith("+++") || l.text.startsWith("---") ? "file" : l.text[0];
    const picked = this.range && i >= this.range.from && i <= this.range.to;
    return div().id(`gd-${i}`).w_full().h(ROW - 2).flex_none().px(12).truncate().cursor_pointer()
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18").text_color(t.ansi2))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18").text_color(t.ansi1))
      .when(kind === "@", (e) => e.bg(t.raised).text_color(t.dim))
      .when(kind === "file" || l.text.startsWith("diff --git"), (e) => e.font_semibold())
      .when(Boolean(picked), (e) => e.bg(t.selection ?? t.selected))
      .on_click((ev, cx) => this.selectLine(i, Boolean(ev.modifiers?.shift), cx))
      .child(l.text || " ");
  }

  button(id, label, onClick, t) {
    return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  render(cx) {
    const t = theme();
    const want = this.target();
    if (!this.loading && want && want !== this.folder && !props()?.folder) this.refresh(cx);
    const mono = settings().font_family ?? "JetBrains Mono";
    const body = Math.max(0, this.height - 43);
    const detailH = this.selected ? Math.floor(body * 0.55) : 0;
    const listH = Math.max(ROW, body - detailH);
    const wide = this.width >= 480;
    const count = this.rows.filter((r) => r.sha).length;
    const repo = this.root ? this.root.split("/").pop() : "Git graph";
    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(repo))
      .when(Boolean(this.branch), (e) => e.child(div().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.accent).child(this.branch)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.loading ? "Loading…" : `${count} commits${count >= LIMIT ? " (latest)" : ""}`))
      .child(this.button("gg-refresh", "Refresh", (cx) => this.refresh(cx), t));
    // Plain scroll areas with explicit heights: a virtual list never rendered its rows in a pane.
    const list = this.error && !this.rows.length
      ? div().p(16).text_color(t.dim).child(this.error)
      : div().id("gg-list").w_full().h(listH).flex_none().overflow_y_scrollbar().font_family(mono).text_size(12)
        .child(v_flex().w_full().children(this.rows.map((r, i) => this.row(r, i, t, wide))));
    const lines = this.range ? this.range.to - this.range.from + 1 : 0;
    const detail = this.selected
      ? v_flex().w_full().h(detailH).flex_none().border_t(1).border_color(t.border)
        .child(h_flex().h(32).flex_none().px(10).gap(2).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(lines ? `${this.selected} · ${lines} line${lines === 1 ? "" : "s"}` : this.selected))
          .child(this.button("gg-comment", lines ? "Comment on lines" : "Comment", () => this.comment(), t))
          .child(this.button("gg-review", "Review", (cx) => this.review(cx), t))
          .child(this.button("gg-close", "✕", (cx) => this.pick(this.selected, cx), t)))
        .child(div().id("gg-detail").w_full().h(Math.max(0, detailH - 33)).flex_none().overflow_y_scrollbar().font_family(mono).text_size(12)
          .child(v_flex().w_full().children(this.detail.map((l, i) => this.detailRow(l, i, t)))))
      : null;
    return v_flex().id("ws-git-graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .on_size_change((size, cx) => { const z = Number(settings().zoom) || 1; this.height = size.height / z; this.width = size.width / z; cx.notify(); })
      .text_color(t.foreground).text_size(12.5)
      .child(header).child(list).when(detail !== null, (e) => e.child(detail));
  }
}
