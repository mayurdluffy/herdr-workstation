// @ts-check
// Changes panel (id ws-review): the agent's uncommitted changes, file by file. Accept stages a file or
// hunk, Reject restores it (a new file is deleted, after a second click). Accepted files
// wait under Accepted until you commit. Click a line, shift-click another, Comment: the
// comment goes to the tray with its file and lines. Full review opens plannotator.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, settings, focused, panes, spaces, agents, layout, window, notify, openOverlay, appHome, writeTextFile, readTextFile } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "color.ui=never"];
const ROW = 20;
const MAX_LINES = 2000;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

/** `git status --porcelain=v1 -z` → [{ path, pending, accepted, fresh, deleted }]. */
export function parseStatus(out) {
  const files = [];
  for (const entry of out.split("\0").filter(Boolean)) {
    const x = entry[0], y = entry[1], path = entry.slice(3);
    const fresh = x === "?" && y === "?";
    files.push({ path, fresh, pending: fresh || y !== " ", accepted: !fresh && x !== " ", deleted: x === "D" || y === "D" });
  }
  return files;
}

/** A unified diff → { header: string[], hunks: [{ header, lines, index }], rows }. */
export function parseDiff(text) {
  const all = text.replace(/\n$/, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  const header = first < 0 ? all : all.slice(0, first);
  const hunks = [], rows = [];
  let hunk = null, oldN = 0, newN = 0;
  for (const line of first < 0 ? [] : all.slice(first)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) {
      hunk = { header: line, lines: [], index: hunks.length };
      hunks.push(hunk);
      oldN = +m[1]; newN = +m[2];
      rows.push({ kind: "@", text: line, hunk: hunk.index });
      continue;
    }
    if (!hunk) continue;
    hunk.lines.push(line);
    const kind = line[0];
    if (kind === "+") rows.push({ kind, text: line.slice(1), newN: newN++, hunk: hunk.index });
    else if (kind === "-") rows.push({ kind, text: line.slice(1), oldN: oldN++, newN, hunk: hunk.index });
    else if (kind === " ") rows.push({ kind, text: line.slice(1), oldN: oldN++, newN: newN++, hunk: hunk.index });
    else rows.push({ kind: "\\", text: line, hunk: hunk.index });
  }
  return { header, hunks, rows };
}

export default class Review extends View {
  init(_props, cx) {
    this.root = null;
    this.on = null;
    this.cwd = null;
    this.files = [];
    this.open = null;       // path
    this.diff = null;       // parseDiff result for the open file
    this.range = null;      // { from, to } row indexes
    this.error = null;
    this.note = null;
    this.busy = false;
    this.loading = false;
    this.confirm = null;    // path waiting for a second Reject click
    this.height = 0;
    this.key = null;
    this.refresh(cx);
    cx.timer.every(3000, (cx) => { if (this.visible()) this.refresh(cx); });
  }

  // Only poll git while the panel shows Changes and the window is up.
  visible() {
    if (window()?.visible === false || window()?.active === false) return false;
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "ws-review");
  }

  location() {
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { cwd: (pane?.terminal ? pane.cwd : null) ?? (f?.terminal ? f.cwd : null) ?? this.cwd ?? space?.folder ?? null, on: space?.machine ?? null };
  }

  git(args) {
    return exec("git", [...READ, ...args], { cwd: this.root ?? undefined, on: this.on });
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = this.location();
    if (!cwd) { this.error = "Focus a terminal in a git repository"; cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        this.cwd = cwd;
        if (top.code !== 0) { this.root = null; this.files = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        if (root !== this.root) { this.open = null; this.diff = null; this.range = null; this.key = null; }
        this.root = root; this.on = on;
        const st = await this.git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (st.code !== 0) throw new Error(st.stderr.trim());
        this.files = parseStatus(st.stdout);
        this.error = null;
        if (this.open && !this.files.some((f) => f.path === this.open)) { this.open = null; this.diff = null; this.range = null; }
        if (!this.open) this.open = this.files.find((f) => f.pending)?.path ?? this.files[0]?.path ?? null;
        if (this.open && (st.stdout !== this.key || !this.diff)) await this.load(this.open);
        this.key = st.stdout;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  file(path) { return this.files.find((f) => f.path === path); }

  async load(path) {
    const f = this.file(path);
    if (!f) return;
    let text = "";
    if (f.fresh) {
      const body = await readTextFile(`${this.root}/${path}`, { on: this.on }).catch(() => null);
      if (body !== null && !body.includes("\0")) {
        const lines = body.replace(/\n$/, "").split("\n");
        text = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
      }
    } else {
      // Pending files show what isn't accepted yet; accepted-only files show what was staged.
      const args = f.pending ? ["diff", "--no-ext-diff", "--no-textconv", "-U3", "--", path] : ["diff", "--cached", "--no-ext-diff", "--no-textconv", "-U3", "--", path];
      const r = await this.git(args);
      text = r.code === 0 ? r.stdout : "";
    }
    if (this.open !== path) return;
    const d = parseDiff(text);
    this.note = d.rows.length > MAX_LINES ? `Showing the first ${MAX_LINES} lines; Full review shows the rest.` : null;
    if (d.rows.length > MAX_LINES) d.rows = d.rows.slice(0, MAX_LINES);
    this.diff = d;
  }

  pick(path, cx) {
    this.open = path; this.diff = null; this.range = null; this.confirm = null;
    cx.spawn(async (cx) => { await this.load(path); cx.notify(); });
    cx.notify();
  }

  // Runs the steps of an action (git args, or async functions returning an exec result), then refreshes.
  act(label, steps, cx) {
    if (this.busy) return;
    this.busy = true; this.confirm = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const step of steps) {
          const r = Array.isArray(step) ? await this.git(step) : await step();
          if (r && r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) {
        notify({ title: `${label} failed`, body: String(e?.message ?? e).slice(0, 300), level: "error" });
      } finally {
        this.busy = false; this.key = null; this.diff = null; this.range = null;
        this.refresh(cx);
      }
    });
  }

  accept(path, cx) { this.act("Accept", [["add", "--", path]], cx); }
  unaccept(path, cx) { this.act("Unaccept", [["restore", "--staged", "--", path]], cx); }

  reject(path, cx) {
    const f = this.file(path);
    if (!f) return;
    if (this.confirm !== path) { this.confirm = path; cx.notify(); return; }
    if (f.fresh) this.act("Reject", [["clean", "-f", "--", path]], cx);
    else this.act("Reject", [["restore", "--worktree", "--", path]], cx);
  }

  acceptAll(cx) {
    const paths = this.files.filter((f) => f.pending).map((f) => f.path);
    if (paths.length) this.act("Accept all", [["add", "--", ...paths]], cx);
  }

  // A hunk as a patch git can apply: the file's header plus that hunk.
  hunkStep(index, reverse) {
    return async () => {
      const d = this.diff, hunk = d?.hunks[index];
      if (!hunk) return { code: 1, stdout: "", stderr: "That hunk changed; try again" };
      const patch = [...d.header, hunk.header, ...hunk.lines].join("\n") + "\n";
      const dir = `${appHome()}/data/ws-review`;
      const file = `${dir}/hunk-${Date.now()}.patch`;
      await exec("mkdir", ["-p", dir]);
      await writeTextFile(file, patch, null);
      const r = await this.git(reverse ? ["apply", "--reverse", "--recount", file] : ["apply", "--cached", "--recount", file]);
      await exec("rm", ["-f", file]);
      return r;
    };
  }

  selectRow(i, shift, cx) {
    if (shift && this.range) this.range = { from: Math.min(this.range.from, i), to: Math.max(this.range.from, i) };
    else this.range = this.range && this.range.from === i && this.range.to === i ? null : { from: i, to: i };
    cx.notify();
  }

  agent() {
    const f = focused(), list = agents();
    return list.find((a) => a.address === f?.terminal) ?? list.filter((a) => a.tab === f?.tab).sort((a, b) => b.seq - a.seq)[0] ?? null;
  }

  comment() {
    if (!this.range || !this.diff || !this.open) return;
    const rows = this.diff.rows.slice(this.range.from, this.range.to + 1).filter((r) => r.kind !== "@");
    const nums = rows.map((r) => r.newN).filter((n) => n !== undefined);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const lines = nums.length ? (lo === hi ? `${lo}` : `${lo}-${hi}`) : "";
    const quote = rows.map((r) => `${r.kind === "\\" || r.kind === " " ? " " : r.kind}${r.text}`).join("\n");
    openOverlay({ mod: "ws-comment", kind: "dialog", width: 560, height: 420,
      props: { source: "diff", where: `${this.open}${lines ? `:${lines}` : ""} (uncommitted change)`, quote, agent: this.agent()?.address } });
  }

  fullReview(cx) {
    const agent = this.agent();
    cx.spawn(async (_cx) => {
      const r = await exec("plannotator-tui", ["hc", "review", ...(agent ? ["--terminal", agent.address] : [])], { timeout: 60000, cwd: this.root ?? undefined })
        .catch((e) => ({ code: 127, stdout: "", stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Full review", body: String(r.stderr).trim().slice(0, 200) || "plannotator-tui failed", level: "error" });
    });
  }

  btn(id, label, onClick, t, tone) {
    const color = tone === "ok" ? t.ansi2 : tone === "bad" ? t.ansi1 : t.muted;
    return div().id(id).h(22).px(7).flex().flex_none().items_center().rounded(5).text_size(11.5).text_color(color).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  fileRow(f, t) {
    const on = this.open === f.path;
    const parts = f.path.split("/"), name = parts.pop();
    const mark = f.fresh ? "A" : f.deleted ? "D" : "M";
    const markColor = mark === "A" ? t.ansi2 : mark === "D" ? t.ansi1 : t.blocked;
    return h_flex().id(`rv-${f.path}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(12).flex_none().text_size(11).text_color(markColor).child(mark))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().flex_none().max_w(240).truncate().child(name)))
      .when(f.pending, (e) => e
        .child(this.btn(`rv-acc-${f.path}`, "Accept", (cx) => this.accept(f.path, cx), t, "ok"))
        .child(this.btn(`rv-rej-${f.path}`, this.confirm === f.path ? (f.fresh ? "Delete file?" : "Discard?") : "Reject", (cx) => this.reject(f.path, cx), t, "bad")))
      .when(!f.pending, (e) => e.child(this.btn(`rv-un-${f.path}`, "Unaccept", (cx) => this.unaccept(f.path, cx), t)));
  }

  diffRow(r, i, t, f, local) {
    const picked = this.range && i >= this.range.from && i <= this.range.to;
    if (r.kind === "@") {
      return h_flex().id(`rd-${i}`).w_full().h(ROW + 4).flex_none().px(10).gap(4).items_center().bg(t.raised)
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.text))
        .when(Boolean(f?.pending && !f.fresh && local), (e) => e
          .child(this.btn(`rh-acc-${i}`, "Accept hunk", (cx) => this.act("Accept hunk", [this.hunkStep(r.hunk, false)], cx), t, "ok"))
          .child(this.btn(`rh-rej-${i}`, "Reject hunk", (cx) => this.act("Reject hunk", [this.hunkStep(r.hunk, true)], cx), t, "bad")));
    }
    return h_flex().id(`rd-${i}`).w_full().h(ROW).flex_none().gap(8).cursor_pointer()
      .when(r.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(r.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .when(Boolean(picked), (e) => e.bg(t.selection ?? t.selected))
      .on_click((ev, cx) => this.selectRow(i, Boolean(ev.modifiers?.shift), cx))
      .child(div().w(38).flex_none().text_right().text_color(t.dim).child(r.kind === "-" || r.newN === undefined ? "" : String(r.newN)))
      .child(div().w(10).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().min_w(0).truncate().child(r.text.replace(/\t/g, "    ") || " "));
  }

  render(cx) {
    const t = theme();
    const loc = this.location();
    if (!this.loading && loc.cwd && loc.cwd !== this.cwd) this.refresh(cx);
    const mono = settings().font_family ?? "JetBrains Mono";
    const pending = this.files.filter((f) => f.pending), accepted = this.files.filter((f) => !f.pending);
    const listRows = this.files.length + (accepted.length ? 1 : 0) + (pending.length ? 1 : 0);
    const body = Math.max(0, this.height - 43 - (this.range ? 40 : 0));
    const listH = Math.min(Math.max(60, listRows * 26 + 20), Math.floor(body * 0.4));
    const diffH = Math.max(0, body - listH - 1);
    const f = this.open ? this.file(this.open) : null;
    const local = !this.on;
    const header = h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Changes"))
      .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${pending.length} to review`))
      .when(accepted.length > 0, (e) => e.child(div().text_size(10.5).text_color(t.ansi2).child(`${accepted.length} accepted`)))
      .child(div().flex_1())
      .when(pending.length > 0, (e) => e.child(this.btn("rv-accept-all", "Accept all", (cx) => this.acceptAll(cx), t, "ok")))
      .child(this.btn("rv-full", "Full review", (cx) => this.fullReview(cx), t))
      .child(this.btn("rv-refresh", this.busy || this.loading ? "…" : "Refresh", (cx) => { this.key = null; this.refresh(cx); }, t));
    const section = (label) => div().px(8).pt(6).pb(2).text_size(10.5).text_color(t.dim).child(label);
    const list = div().id("rv-files").w_full().h(listH).flex_none().overflow_y_scrollbar().border_b(1).border_color(t.border)
      .child(v_flex().p(6).w_full()
        .when(pending.length > 0, (e) => e.child(section("TO REVIEW")).children(pending.map((x) => this.fileRow(x, t))))
        .when(accepted.length > 0, (e) => e.child(section("ACCEPTED · commit when ready")).children(accepted.map((x) => this.fileRow(x, t))))
        .when(this.files.length === 0, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : "No uncommitted changes")))));
    const rows = this.diff?.rows ?? [];
    const diff = div().id("rv-diff").w_full().h(diffH).flex_none().overflow_y_scrollbar().font_family(mono).text_size(12)
      .child(v_flex().w_full()
        .when(Boolean(this.note), (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.dim).child(this.note)))
        .when(Boolean(f) && Boolean(this.diff) && rows.length === 0, (e) => e.child(div().p(12).text_color(t.dim).child("No text diff (binary, empty or too large)")))
        .children(rows.map((r, i) => this.diffRow(r, i, t, f, local))));
    const count = this.range ? (this.diff?.rows.slice(this.range.from, this.range.to + 1).filter((r) => r.kind !== "@").length ?? 0) : 0;
    const footer = this.range
      ? h_flex().h(40).flex_none().px(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(12).text_color(t.muted).child(`${count} line${count === 1 ? "" : "s"} selected · shift-click to extend`))
        .child(div().id("rv-comment").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().bg(t.solid).text_color(t.solid_foreground).text_size(12.5)
          .on_click(() => this.comment()).child("Comment"))
      : null;
    return v_flex().id("ws-review").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12.5)
      .on_size_change((size, cx) => { this.height = size.height / (Number(settings().zoom) || 1); cx.notify(); })
      .child(header).child(list).child(diff).when(footer !== null, (e) => e.child(footer));
  }
}
