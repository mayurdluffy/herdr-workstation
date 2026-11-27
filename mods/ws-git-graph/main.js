// @ts-check
// Git graph, as a panel (Graph button) or a pane, drawn like VS Code's Git Graph:
// colored lanes with curved forks and merges, branch and tag badges in their lane's
// color, then Description · Date · Author · Commit. props { folder?, commit? }; without a
// folder it follows the focused terminal's repository. Show all branches, the current
// one, or click a badge to show only that branch. Click a commit for its diff; comment on
// the commit or on diff lines (click, shift-click), or review it in plannotator.
// Find narrows the list to commits whose message, author, hash or branch match.
// It redraws when the repository's refs change (a watch on its git folder; remote
// spaces and Linux poll instead).
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, props, focused, panes, spaces, agents, settings, notify, window, openOverlay, appHome, writeTextFile, watchFolder, layout } from "herdr";
import { layoutLanes, graphSvg } from "./lanes.js";
import { markWords } from "./diff-words.js";

const SEP = "\x1f";
const LIMIT = 400;
const DETAIL_LIMIT = 1500;
const ROW = 24;
const LANE = 16;
const PAD = 6;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "color.ui=never"];
const LANE_COLORS = ["ansi4", "ansi5", "ansi2", "ansi3", "ansi6", "ansi1", "ansi12", "ansi13", "ansi10", "ansi11", "ansi14", "ansi9"];

/** `%D` decorations → [{ name, kind: "head" | "local" | "remote" | "tag" }]. */
export function parseRefs(text, remotes) {
  const out = [];
  for (const raw of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "HEAD") continue; // detached HEAD: the ring on the dot shows it
    if (raw.startsWith("HEAD -> ")) out.push({ name: raw.slice(8), kind: "head" });
    else if (raw.startsWith("tag: ")) out.push({ name: raw.slice(5), kind: "tag" });
    else if (remotes.some((r) => raw.startsWith(`${r}/`))) { if (!raw.endsWith("/HEAD")) out.push({ name: raw, kind: "remote" }); }
    else out.push({ name: raw, kind: "local" });
  }
  return out;
}

/**
 * A commit's refs as badges: a local branch and its remote twin on the same commit are one
 * badge ("main" with remotes ["origin"]), as VS Code's Git Graph shows them. The checked-out
 * branch comes first, then `first` (the branch the list is narrowed to), branches, remotes, tags.
 */
export function groupRefs(refs, first = null) {
  const locals = new Map(refs.filter((r) => r.kind === "head" || r.kind === "local").map((r) => [r.name, { ...r, remotes: [] }]));
  const out = [...locals.values()];
  for (const r of refs) {
    if (r.kind === "remote") {
      const slash = r.name.indexOf("/"), remote = r.name.slice(0, slash), name = r.name.slice(slash + 1);
      const twin = locals.get(name);
      if (twin) twin.remotes.push(remote); else out.push({ ...r, remotes: [] });
    } else if (r.kind === "tag") out.push({ ...r, remotes: [] });
  }
  const rank = (r) => (r.kind === "head" ? 0 : r.name === first ? 1 : r.kind === "local" ? 2 : r.kind === "remote" ? 3 : 4);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** The commits matching a search: every word must appear in the subject, author, hash or a ref. */
export function matches(rows, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.subject}\n${r.author}\n${r.hash}\n${r.refs.map((x) => x.name).join("\n")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Whether a batch of changed paths under the git folder `dir` touches what the graph shows:
 *  HEAD, a ref, packed refs (the batch holding `dir` itself means anything may have changed). */
export const refsChanged = (paths, dir) => paths.some((p) => p === dir || (!p.endsWith(".lock") && /(?:^|\/)(?:HEAD|packed-refs)$|\/refs(?:\/|$)/.test(p)));

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
    this.rows = [];          // { hash, short, parents, refs, subject, author, date, col, color }
    this.graph = null;       // { path, width, height }
    this.root = null;
    this.branch = null;
    this.head = null;
    this.error = null;
    this.loading = false;
    this.selected = null;    // hash
    this.detail = [];
    this.range = null;
    this.signature = null;
    this.folder = null;
    this.space = null;       // the space this.folder was shown for
    this.height = 0;
    this.width = 0;
    this.scope = "all";      // "all" | "current" | a ref name
    this.remotesShown = true;
    this.on = null;          // the machine the repository is on (null: here)
    this.watching = null;    // { dir, pending } while watching the repository's git folder
    this.polledAt = 0;
    this.find = InputState.new({ placeholder: "Find commits: message, author, hash, branch" });
    this.find.on("change", (_e, cx) => cx.notify());
    this.refresh(cx);
    // Remote repositories (no watch there) every 4s; local ones as a fallback every 30s.
    cx.timer.every(4000, (cx) => { if (this.on || !this.watching || Date.now() - this.polledAt > 30000) this.poll(cx); });
    // A reload or crash skips close(): sweep graph files no copy has drawn for a day.
    exec("find", [`${appHome()}/data/ws-git-graph`, "-name", "graph-*.svg", "-mmin", "+1440", "-delete"]).catch(() => null);
  }

  async close(_cx) {
    this.watching?.pending?.cancel();
    this.find.release();
    if (this.graph) await exec("rm", ["-f", `${appHome()}/${this.graph.path}`]);
  }

  /** The panel copy is shown only while the panel shows the graph; a pane copy is always shown. */
  shown() {
    if (window()?.visible === false) return false;
    if (props()?.pane || props()?.folder) return true;
    const find = (node, id) => { if (node?.id === id) return node; for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; } return null; };
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel && !body) return true;
    return Boolean(panel && !panel.hidden && body?.active === "ws-graph");
  }

  /** Watches the repository's git folder (here only) and redraws when its refs change. */
  watch(cx) {
    if (this.on || !this.root) { this.watching?.pending?.cancel(); this.watching = null; return; }
    cx.spawn(async (cx) => {
      const r = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
      const dir = r?.code === 0 ? r.stdout.trim() : null;
      if (!dir || this.watching?.dir === dir) return;
      this.watching?.pending?.cancel();
      const watching = { dir, pending: null };
      this.watching = watching;
      try {
        while (this.watching === watching) {
          watching.pending = watchFolder(dir);
          const paths = await watching.pending;
          if (this.watching !== watching) break;
          if (!paths.length) continue;
          if (refsChanged(paths, dir) && this.shown() && !this.loading) this.poll(cx);
        }
      } catch {
        // Too many folders watched, or the folder went: the timer polls instead.
        if (this.watching === watching) this.watching = null;
      }
    });
  }

  target() {
    const fixed = props()?.folder;
    if (fixed) return fixed;
    const f = focused(), space = spaces().find((s) => s.active);
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    // A mod pane or panel has no folder: keep this space's last one, else the space's own.
    const last = this.space === space?.id ? this.folder : null;
    return (pane?.terminal ? pane.cwd : f?.terminal ? f.cwd : null) ?? last ?? space?.folder ?? null;
  }

  git(args) {
    return exec("git", [...READ, ...args], { cwd: this.root ?? this.target() ?? undefined, on: this.on });
  }

  machine() {
    return props()?.folder ? null : spaces().find((s) => s.active)?.machine ?? null;
  }

  poll(cx) {
    if (!this.shown() || this.loading || !this.root) return;
    this.polledAt = Date.now();
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

  scopeArgs() {
    if (this.scope === "current") return ["HEAD"];
    if (this.scope !== "all") return [this.scope];
    return this.remotesShown ? ["--all"] : ["--branches", "--tags", "HEAD"];
  }

  setScope(scope, cx) { this.scope = scope; this.selected = null; this.detail = []; this.range = null; this.refresh(cx); }
  toggleRemotes(cx) { this.remotesShown = !this.remotesShown; this.refresh(cx); }

  // From render, pass rendering: notifying then throws (and would leave loading stuck).
  refresh(cx, rendering = false) {
    const folder = this.target(), space = spaces().find((s) => s.active)?.id ?? null;
    if (!folder) { this.error = "Focus a terminal in a git repository"; if (!rendering) cx.notify(); return; }
    this.loading = true;
    if (!rendering) cx.notify();
    cx.spawn(async (cx) => {
      try {
        const on = this.machine();
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
        this.folder = folder; this.space = space; this.on = on;
        if (top.code !== 0) { this.root = null; this.rows = []; this.error = `Not a git repository: ${folder}`; return; }
        const root = top.stdout.trim();
        if (root !== this.root) { this.selected = null; this.detail = []; this.range = null; this.scope = "all"; }
        const moved = root !== this.root;
        this.root = root;
        if (moved || !this.watching) this.watch(cx);
        const remotes = (await this.git(["remote"])).stdout.split("\n").filter(Boolean);
        const fmt = ["%H", "%P", "%h", "%D", "%s", "%an", "%ad"].join(SEP);
        const log = await this.git(["log", ...this.scopeArgs(), "--date-order", `--format=${fmt}`, "--date=format:%-d %b %Y %H:%M", "-n", String(LIMIT)]);
        if (log.code !== 0) throw new Error(log.stderr.trim() || "git log failed");
        const commits = log.stdout.split("\n").filter(Boolean).map((line) => {
          const [hash, parents, short, refs, subject, author, date] = line.split(SEP);
          return { hash, parents: parents ? parents.split(" ") : [], short, refs: parseRefs(refs ?? "", remotes), subject: subject ?? "", author: author ?? "", date: date ?? "" };
        });
        const lanes = layoutLanes(commits);
        this.rows = commits.map((c, i) => ({ ...c, ...lanes.rows[i] }));
        this.head = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
        const b = await this.git(["branch", "--show-current"]);
        this.branch = b.stdout.trim() || "detached HEAD";
        await this.draw(lanes);
        this.signature = await this.signatureNow();
        this.error = this.rows.length ? null : "No commits yet";
        const want = props()?.commit;
        if (want && !this.opened) {
          this.opened = true;
          const row = this.rows.find((r) => r.hash.startsWith(want) || want.startsWith(r.short));
          if (row) this.pick(row.hash, cx);
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  palette() {
    const t = theme();
    const p = LANE_COLORS.map((k) => t[k] ?? t.accent);
    return Object.assign(p, { background: t.background });
  }

  // The lanes as one SVG file behind the rows; a new file each time, the old one removed.
  async draw(lanes) {
    const headIndex = this.rows.findIndex((r) => r.hash === this.head);
    const { svg, width, height } = graphSvg(lanes, { rowH: ROW, lane: LANE, pad: PAD, palette: this.palette(), head: headIndex });
    const dir = "data/ws-git-graph";
    const path = `${dir}/graph-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.svg`;
    await exec("mkdir", ["-p", `${appHome()}/${dir}`]);
    await writeTextFile(`${appHome()}/${path}`, svg, null);
    const old = this.graph;
    this.graph = { path, width, height };
    if (old) await exec("rm", ["-f", `${appHome()}/${old.path}`]);
  }

  pick(hash, cx) {
    if (this.selected === hash) { this.selected = null; this.detail = []; this.range = null; cx.notify(); return; }
    this.selected = hash;
    this.detail = [{ text: "Loading…", file: null, line: null }];
    this.range = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.git(["show", "--stat", "--patch", "--no-ext-diff", "--format=%H%n%an  ·  %ad%n%n%B", hash]);
      if (this.selected !== hash) return;
      const lines = (r.code === 0 ? r.stdout : r.stderr).replace(/\n$/, "").split("\n");
      this.detail = locate(lines.slice(0, DETAIL_LIMIT).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l)));
      // Changed words inside changed lines.
      markWords(this.detail, (l) => (l.text.startsWith("+++") || l.text.startsWith("---") ? "" : l.text[0]), (l) => l.text.slice(1));
      if (lines.length > DETAIL_LIMIT) this.detail.push({ text: `… ${lines.length - DETAIL_LIMIT} more lines (Review shows all of it)`, file: null, line: null });
      cx.notify();
    });
  }

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
    const row = this.rows.find((r) => r.hash === this.selected);
    if (!row) return;
    let where = `commit ${row.short} "${row.subject}"`, quote = "";
    if (this.range) {
      const picked = this.detail.slice(this.range.from, this.range.to + 1);
      const located = picked.filter((l) => l.file);
      if (located.length) {
        const file = located[0].file, first = located[0].line, last = located[located.length - 1].line;
        where = `commit ${row.short} · ${file}:${first === last ? first : `${first}-${last}`}`;
      }
      quote = picked.map((l) => l.text).join("\n");
    }
    openOverlay({ mod: "ws-comment", kind: "dialog", width: 560, props: { source: "commit", where, quote, agent: this.agent()?.address } });
  }

  review(cx) {
    const agent = this.agent(), hash = this.selected;
    if (!hash) return;
    cx.spawn(async (_cx) => {
      const args = ["hc", "review", "--commit", hash, ...(agent ? ["--terminal", agent.address] : [])];
      const r = await exec("plannotator-tui", args, { timeout: 60000, cwd: this.root ?? undefined }).catch((e) => ({ code: 127, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Review commit", body: String(r.stderr).trim().slice(0, 200) || "plannotator-tui failed", level: "error" });
    });
  }

  // A branch or tag badge in its lane's color; clicking a branch shows only that branch.
  // The checked-out branch has a check mark; a local branch's remote twins on the same
  // commit show as "☁ origin" inside its badge.
  badge(ref, laneColor, t, key) {
    const tag = ref.kind === "tag", remote = ref.kind === "remote", head = ref.kind === "head";
    const color = tag ? t.ansi3 : laneColor;
    const solid = head || ref.kind === "local";
    const twins = ref.remotes ?? [];
    const tip = head ? `${ref.name}: checked out` : remote ? `${ref.name}: remote branch` : tag ? `tag ${ref.name}` : ref.name;
    return h_flex().id(key).flex_none().max_w(200).h(18).px(5).gap(3).items_center().rounded(4)
      .border_1().border_color(color).bg(solid ? color : t.background).text_size(10.5)
      .text_color(solid ? t.background : color).when(head, (e) => e.font_semibold())
      .tooltip(twins.length ? `${tip} · same commit as ${twins.map((r) => `${r}/${ref.name}`).join(", ")}` : tip)
      .when(!tag, (e) => e.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.setScope(ref.name, cx); }))
      .child(div().flex_none().child(tag ? "◆" : remote ? "☁" : head ? "✓" : "⎇"))
      .child(div().min_w(0).truncate().child(ref.name))
      .when(twins.length > 0, (e) => e.child(div().flex_none().ml(2).pl(4).border_l(1).border_color(t.background).opacity(0.8).child(`☁ ${twins.join(" ")}`)));
  }

  header(t) {
    const chip = (id, label, on, onClick) => div().id(id).h(22).px(8).flex().flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.border : t.background)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
    const filtered = this.scope !== "all" && this.scope !== "current";
    const repo = this.root ? this.root.split("/").pop() : "Git graph";
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().h(40).px(14).gap(8).items_center()
        .child(div().font_semibold().child(repo))
        .when(Boolean(this.branch), (e) => e.child(div().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.accent).child(`⎇ ${this.branch}`)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.loading ? "Loading…" : this.find.value().trim() ? `${matches(this.rows, this.find.value().trim()).length} of ${this.rows.length} commits` : `${this.rows.length} commits${this.rows.length >= LIMIT ? " (latest)" : ""}`))
        .child(chip("gg-refresh", "Refresh", false, (cx) => this.refresh(cx))))
      .child(h_flex().h(34).px(12).gap(6).items_center()
        .child(div().flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
          .child(Input.new(this.find).w_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(this.find.value().trim()), (e) => e.child(chip("gg-find-clear", "Clear", false, (cx) => { this.find.set_value(""); cx.notify(); }))))
      .child(h_flex().h(32).px(12).gap(6).items_center()
        .child(div().text_size(11.5).text_color(t.dim).child("Branches"))
        .child(chip("gg-all", "All", this.scope === "all", (cx) => this.setScope("all", cx)))
        .child(chip("gg-current", "Current", this.scope === "current", (cx) => this.setScope("current", cx)))
        .when(filtered, (e) => e.child(chip("gg-only", `⎇ ${this.scope}  ✕`, true, (cx) => this.setScope("all", cx))))
        .child(div().flex_1())
        .when(this.scope === "all", (e) => e.child(chip("gg-remotes", `${this.remotesShown ? "☑" : "☐"} Remote branches`, false, (cx) => this.toggleRemotes(cx)))));
  }

  columns(t, cols) {
    const cell = (label, w) => div().flex_none().w(w).truncate().child(label);
    return h_flex().h(26).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim).font_semibold()
      .child(cell(cols.graph >= 52 ? "Graph" : "", cols.graph - 10))
      .child(div().flex_1().min_w(0).child("Description"))
      .when(cols.date, (e) => e.child(cell("Date", 116)))
      .when(cols.author, (e) => e.child(cell("Author", 110)))
      .when(cols.commit, (e) => e.child(cell("Commit", 62)));
  }

  row(r, i, t, cols, palette, found = false) {
    const on = r.hash === this.selected;
    const laneColor = palette[r.color % palette.length];
    const first = this.scope !== "all" && this.scope !== "current" ? this.scope : null;
    return h_flex().id(`gg-${i}`).w_full().h(ROW).flex_none().pr(10).gap(8).items_center().cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pick(r.hash, cx))
      .child(div().flex_none().w(cols.graph).when(found, (e) => e.flex().items_center().justify_center()
        .child(div().size(8).rounded(4).bg(laneColor).when(r.hash === this.head, (d) => d.border(2).border_color(t.foreground)))))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .children(groupRefs(r.refs, first).map((ref, k) => this.badge(ref, laneColor, t, `gg-ref-${i}-${k}`)))
        .child(div().flex_1().min_w(0).truncate().when(r.parents.length > 1, (e) => e.text_color(t.muted)).child(r.subject)))
      .when(cols.date, (e) => e.child(div().flex_none().w(116).truncate().text_color(t.muted).child(r.date)))
      .when(cols.author, (e) => e.child(div().flex_none().w(110).truncate().text_color(t.muted).child(r.author)))
      .when(cols.commit, (e) => e.child(div().flex_none().w(62).truncate().text_color(t.dim).child(r.short)));
  }

  detailRow(l, i, t) {
    const kind = l.text.startsWith("+++") || l.text.startsWith("---") ? "file" : l.text[0];
    const picked = this.range && i >= this.range.from && i <= this.range.to;
    if (l.words && (kind === "+" || kind === "-")) {
      const mark = kind === "+" ? t.ansi2 + "40" : t.ansi1 + "40";
      return h_flex().id(`gd-${i}`).w_full().min_h(ROW - 4).flex_none().px(12).flex_wrap().cursor_pointer()
        .bg(kind === "+" ? t.ansi2 + "18" : t.ansi1 + "18").text_color(kind === "+" ? t.ansi2 : t.ansi1)
        .when(Boolean(picked), (e) => e.bg(t.selection ?? t.selected))
        .on_click((ev, cx) => this.selectLine(i, Boolean(ev.modifiers?.shift), cx))
        .child(div().flex_none().child(kind))
        .children(l.words.flatMap((w) => (w.text.match(/\s+|\S+/g) ?? []).map((text) => ({ text, changed: w.changed })))
          .map((w, k) => div().id(`gd-${i}-${k}`).flex_none().when(w.changed, (e) => e.bg(mark)).child(w.text)));
    }
    return div().id(`gd-${i}`).w_full().min_h(ROW - 4).flex_none().px(12).whitespace_normal().cursor_pointer()
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
    if (!this.loading && want && want !== this.folder && !props()?.folder) this.refresh(cx, true);
    const mono = settings().font_family ?? "JetBrains Mono";
    const palette = this.palette();
    const graphW = Math.max(36, this.graph?.width ?? 36);
    // Columns drop as the panel narrows: Commit, then Author, then Date.
    const cols = { graph: graphW, date: this.width >= 560, author: this.width >= 700, commit: this.width >= 800 };
    const top = 40 + 32 + 34 + 26 + 3;
    const query = this.find.value().trim();
    const shownRows = query ? matches(this.rows, query) : this.rows;
    const body = Math.max(0, this.height - top);
    const detailH = this.selected ? Math.floor(body * 0.5) : 0;
    const listH = Math.max(ROW, body - detailH);
    const list = this.error && !this.rows.length
      ? div().p(16).text_color(t.dim).child(this.error)
      : query
        // Found commits: a dot in each one's lane color instead of the lanes.
        ? div().id("gg-found").w_full().h(listH).flex_none().overflow_y_scrollbar().text_size(12.5)
          .child(v_flex().w_full()
            .when(shownRows.length === 0, (e) => e.child(div().p(16).text_color(t.dim).child(`No commit matches "${query}" (of the ${this.rows.length} shown)`)))
            .children(shownRows.map((r, i) => this.row(r, i, t, cols, palette, true))))
        : div().id("gg-list").w_full().h(listH).flex_none().overflow_y_scrollbar().text_size(12.5)
          .child(div().relative().w_full().h(this.rows.length * ROW)
            .child(v_flex().w_full().children(this.rows.map((r, i) => this.row(r, i, t, cols, palette))))
            // The lanes, drawn once as an SVG over the rows' empty graph column.
            .when(Boolean(this.graph), (e) => e.child(image(this.graph.path).absolute().left(0).top(0).w(this.graph.width).h(this.graph.height))));
    const lines = this.range ? this.range.to - this.range.from + 1 : 0;
    const row = this.rows.find((r) => r.hash === this.selected);
    const detail = this.selected
      ? v_flex().w_full().h(detailH).flex_none().border_t(1).border_color(t.border)
        .child(h_flex().h(32).flex_none().px(10).gap(2).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(lines ? `${row?.short} · ${lines} line${lines === 1 ? "" : "s"}` : `${row?.short ?? ""}  ${row?.subject ?? ""}`))
          .child(this.button("gg-comment", lines ? "Comment on lines" : "Comment", () => this.comment(), t))
          .child(this.button("gg-review", "Review", (cx) => this.review(cx), t))
          .child(this.button("gg-close", "✕", (cx) => this.pick(this.selected, cx), t)))
        .child(div().id("gg-detail").w_full().h(Math.max(0, detailH - 33)).flex_none().overflow_y_scrollbar().font_family(mono).text_size(12)
          .child(v_flex().w_full().children(this.detail.map((l, i) => this.detailRow(l, i, t)))))
      : null;
    return v_flex().id("ws-git-graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .on_size_change((size, cx) => { const z = Number(settings().zoom) || 1; this.height = size.height / z; this.width = size.width / z; cx.notify(); })
      .text_color(t.foreground).text_size(12.5)
      .child(this.header(t)).child(this.columns(t, cols)).child(list).when(detail !== null, (e) => e.child(detail));
  }
}
