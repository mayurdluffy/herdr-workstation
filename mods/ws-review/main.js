// @ts-check
// Changes panel (id ws-review): Source Control as VS Code has it, for the agent's work.
// The top: the "…" menu (pull, push, branches, stash, tags and the rest, in ws-git),
// the branch with Sync, a commit message (⌘Enter commits) and the
// Commit button with its drop-down. Then the uncommitted changes, as a list or a tree:
// Accept stages a file or hunk, Reject restores it (a new file is deleted, after a second
// click); accepted files wait under Accepted until you commit. Click a line, shift-click
// another, Comment: the comment goes to the tray with its file and lines. Every git request (from here, the menus or their dialogs) runs here, one at a
// time, and is logged for Show Git Output.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { exec, theme, settings, focused, panes, spaces, agents, layout, window, notify, openOverlay, appHome, writeTextFile, readTextFile, shared, setShared } from "herdr";
import { REQUEST, CLAIM, LOG, MENU, post, view, openDialog, moreMenu, commitMenu, menuSize, commitOptions, planCommit, pushSteps } from "./git-actions.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "color.ui=never"];
const ROW = 20;
const FILE_H = 26;
const MAX_LINES = 2000;
const STATUS_ORDER = { U: 0, A: 1, M: 2, D: 3 };
const ICON = (name) => `mods/ws-review/icons/${name}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

/** `git status --porcelain=v1 -z` → [{ path, pending, accepted, fresh, deleted, conflict }]. */
export function parseStatus(out) {
  const files = [];
  for (const entry of out.split("\0").filter(Boolean)) {
    if (entry.startsWith("## ")) continue;
    const x = entry[0], y = entry[1], path = entry.slice(3);
    const fresh = x === "?" && y === "?";
    const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    files.push({ path, fresh, conflict, pending: fresh || y !== " ", accepted: !fresh && x !== " ", deleted: x === "D" || y === "D" });
  }
  return files;
}

/** The `## ` line of `git status -b` → { branch, upstream, ahead, behind }. */
export function parseBranch(out) {
  const info = { branch: null, upstream: null, ahead: 0, behind: 0 };
  const line = out.split("\0").find((e) => e.startsWith("## "));
  if (!line) return info;
  let s = line.slice(3);
  const tail = /\s\[(.*)\]$/.exec(s);
  let gone = false;
  if (tail) {
    for (const part of tail[1].split(", ")) {
      const [k, n] = part.split(" ");
      if (k === "ahead") info.ahead = +n;
      else if (k === "behind") info.behind = +n;
      else if (k === "gone") gone = true;
    }
    s = s.slice(0, tail.index);
  }
  const fresh = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(s);
  if (fresh) { info.branch = fresh[1]; return info; }
  if (s.startsWith("HEAD (no branch)")) return info;
  const [branch, upstream] = s.split("...");
  info.branch = branch;
  info.upstream = upstream && !gone ? upstream : null;
  return info;
}

/** A diff as rows: header lines, hunks and { kind, text, oldN, newN, hunk }. */
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

const mark = (f) => (f.conflict ? "U" : f.fresh ? "A" : f.deleted ? "D" : "M");
// VS Code's git decoration colors (its default dark and light themes), as the Files panel uses.
const GIT_COLORS = {
  dark: { A: "#73C991", M: "#E2C08D", D: "#C74E39", U: "#E4676B" },
  light: { A: "#007100", M: "#895503", D: "#AD0707", U: "#AD0707" },
};
const markColor = (m) => GIT_COLORS[settings().dark === false ? "light" : "dark"][m] ?? GIT_COLORS.dark.M;
const base = (p) => p.slice(p.lastIndexOf("/") + 1);

/** Files in the chosen order: by name, by path, or by status. */
export function sortFiles(files, sort) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...files].sort((a, b) =>
    sort === "name" ? cmp(base(a.path).toLowerCase(), base(b.path).toLowerCase()) || cmp(a.path, b.path)
      : sort === "status" ? STATUS_ORDER[mark(a)] - STATUS_ORDER[mark(b)] || cmp(a.path, b.path)
        : cmp(a.path, b.path));
}

/** Files as a tree: folders first (a folder holding one folder only is shown as one, "a/b"), then files. */
export function treeRows(files, sort, collapsed, section) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  const count = (n) => n.files.length + [...n.dirs.values()].reduce((s, d) => s + count(d), 0);
  const rows = [];
  const walk = (node, depth, prefix) => {
    for (const name of [...node.dirs.keys()].sort()) {
      let child = node.dirs.get(name), label = name;
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [next, inner] = [...child.dirs][0];
        label += `/${next}`; child = inner;
      }
      const path = prefix ? `${prefix}/${label}` : label, key = `${section}:${path}`;
      rows.push({ kind: "dir", key, name: label, depth, count: count(child), open: !collapsed.has(key) });
      if (!collapsed.has(key)) walk(child, depth + 1, path);
    }
    for (const f of sortFiles(node.files, sort)) rows.push({ kind: "file", f, depth });
  };
  walk(root, 0, "");
  return rows;
}

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

/** The lines of git's output worth a notification: its errors, not its hints. */
function summary(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:"));
  return lines.slice(-6).join("\n").slice(0, 400) || "git failed";
}

export default class Review extends View {
  init(_props, cx) {
    this.root = null;
    this.on = null;
    this.cwd = null;
    this.space = null;      // the space this.cwd was shown for
    this.files = [];
    this.head = { branch: null, upstream: null, ahead: 0, behind: 0 };
    this.remotes = [];
    this.open = null;       // path
    this.diff = null;       // parseDiff result for the open file
    this.range = null;      // { from, to } row indexes
    this.error = null;
    this.note = null;
    this.busy = false;
    this.loading = false;
    this.again = false;     // a refresh was asked for while one ran
    this.confirm = null;    // path waiting for a second Reject click
    this.height = 0;
    this.topH = 150;
    this.key = null;
    this.op = null;         // the git request running now, e.g. "Pull"
    this.chain = Promise.resolve();
    this.seen = new Set();  // requests this copy has looked at
    this.collapsed = new Set();
    this.anchor = null;     // where the last menu button was pressed
    this.sentAt = 0;
    this.message = TextareaState.new({ placeholder: "Message (⌘Enter to commit)", rows: 1 });
    this.message.set_auto_grow(1, 6);
    this.message.on("change", () => { if (this.root) localStorage.setItem(`msg:${this.root}`, this.message.value()); });
    this.message.on("submit", (e, cx) => { if (e.secondary) this.commit("commit", cx); });
    this.refresh(cx);
    cx.timer.every(3000, (cx) => { this.pump(cx); if (this.visible()) this.refresh(cx); });
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
    // A mod pane or panel has no folder: keep this space's last one, else the space's own.
    const last = this.space === space?.id ? this.cwd : null;
    return { cwd: (pane?.terminal ? pane.cwd : null) ?? (f?.terminal ? f.cwd : null) ?? last ?? space?.folder ?? null, on: space?.machine ?? null, space: space?.id ?? null };
  }

  git(args) {
    return exec("git", [...READ, ...args], { cwd: this.root ?? undefined, on: this.on });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on, space } = this.location();
    if (!cwd) { this.error = "Focus a terminal in a git repository"; return; }
    this.loading = true;
    this.again = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        this.cwd = cwd; this.space = space;
        if (top.code !== 0) { this.root = null; this.files = []; this.head = { branch: null, upstream: null, ahead: 0, behind: 0 }; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        if (root !== this.root) {
          this.open = null; this.diff = null; this.range = null; this.key = null; this.collapsed = new Set();
          this.message.set_value(localStorage.getItem(`msg:${root}`) ?? "");
        }
        this.root = root; this.on = on;
        const st = await this.git(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=all"]);
        if (st.code !== 0) throw new Error(st.stderr.trim());
        this.files = parseStatus(st.stdout);
        this.head = parseBranch(st.stdout);
        const rm = await this.git(["remote"]);
        this.remotes = rm.code === 0 ? rm.stdout.split("\n").filter(Boolean) : [];
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
        if (this.again) this.refresh(cx);
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
    this.note = d.rows.length > MAX_LINES ? `Showing the first ${MAX_LINES} lines.` : null;
    if (d.rows.length > MAX_LINES) d.rows = d.rows.slice(0, MAX_LINES);
    this.diff = d;
  }

  pick(path, cx) {
    this.open = path; this.diff = null; this.range = null; this.confirm = null;
    cx.spawn(async (cx) => { await this.load(path); cx.notify(); });
    cx.notify();
  }

  // ---------- Source Control ----------

  /** What the menus and dialogs know about this repository. */
  ctx() {
    return {
      root: this.root, on: this.on, ...this.head, remotes: this.remotes,
      staged: this.files.filter((f) => f.accepted).length, changes: this.files.filter((f) => f.pending).length,
      message: this.message.value(), view: view(),
    };
  }

  /** Takes up a request the menus or dialogs posted, once, in the copy that claims it. */
  pump(cx) {
    const req = /** @type {any} */ (shared(REQUEST));
    if (!req?.id || this.seen.has(req.id)) return;
    this.seen.add(req.id);
    cx.spawn(async (cx) => {
      // Claimed requests and old ones (from before a restart) never run again.
      if (shared(CLAIM) === req.id || Date.now() - (req.at ?? 0) > 60000) return;
      setShared(CLAIM, req.id);
      this.chain = this.chain.then(() => this.execute(req, cx)).catch(() => null);
      await this.chain;
    });
  }

  log(args, r, ms) {
    const list = /** @type {any[]} */ (shared(LOG) ?? []);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    setShared(LOG, [...(Array.isArray(list) ? list : []), { at: Date.now(), args: args.map(quote).join(" "), code: r.code, ms, out: out.length > 4000 ? `${out.slice(0, 4000)}\n…` : out }].slice(-150));
  }

  /** Runs a request's steps in order; the first failure stops it (and may ask about a retry). */
  async execute(req, cx) {
    this.op = req.title;
    cx.notify();
    try {
      for (const step of req.steps) {
        const { args, cwd, timeout } = Array.isArray(step) ? { args: step, cwd: undefined, timeout: undefined } : step;
        const started = Date.now();
        const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "git", "-c", "color.ui=never", ...args], { cwd: cwd ?? req.cwd ?? undefined, on: req.on, timeout: timeout ?? 180000 })
          .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
        this.log(args, r, Date.now() - started);
        if (r.code !== 0) {
          const text = `${r.stderr}\n${r.stdout}`;
          const retry = req.onError?.find((h) => text.includes(h.match));
          if (retry) openDialog("ask", this.ctx(), "confirm", { confirm: retry.confirm, request: retry.request });
          else notify({ title: `${req.title} failed`, body: summary(text), level: "error" });
          return;
        }
      }
      const after = req.after ?? {};
      if (after.clearMessage) { this.message.set_value(""); if (this.root) localStorage.removeItem(`msg:${this.root}`); }
      if (typeof after.setMessage === "string") this.message.set_value(after.setMessage);
      if (after.openSpace) notify({ title: "Cloned", body: `${after.openSpace}\nClick to open it as a space.`, level: "success", timeout: 15000, action: { name: "space.new", args: { folder: after.openSpace } } });
    } finally {
      this.op = null; this.key = null; this.diff = null;
      this.refresh(cx);
      cx.notify();
    }
  }

  /** Commits (or a drop-down variant). A missing message or nothing accepted asks in a dialog. */
  commit(id, cx) {
    if (this.op || Date.now() - this.sentAt < 600) return;
    const opts = commitOptions(id), ctx = this.ctx();
    if (!opts || !ctx.root) return;
    const plan = planCommit(ctx, opts, ctx.message);
    if (plan.error) { notify({ title: "Commit", body: plan.error, level: "warning" }); return; }
    if (plan.ask) { openDialog(id, ctx, "input"); return; }
    this.sentAt = Date.now();
    post(plan.request);
    this.pump(cx);
  }

  /** The big button when there is nothing to commit: Sync Changes, or Publish Branch. */
  primary() {
    const { branch, upstream, ahead, behind } = this.head;
    if (this.files.length || this.message.value().trim()) return { icon: "check", label: "Commit", act: (cx) => this.commit("commit", cx), on: this.files.length > 0 };
    if (upstream && (ahead || behind)) return { icon: "refresh", label: "Sync Changes", counts: true, act: (cx) => this.sync(cx), on: true };
    if (branch && !upstream && this.remotes.length) return { icon: "cloud-upload", label: "Publish Branch", act: (cx) => this.publish(cx), on: true };
    return { icon: "check", label: "Commit", act: () => null, on: false };
  }

  sync(cx) {
    if (this.op) return;
    const ctx = this.ctx();
    try { post({ title: "Sync", cwd: ctx.root, on: ctx.on, steps: [...(ctx.upstream ? [["pull"]] : []), ...pushSteps(ctx)] }); }
    catch (e) { notify({ title: "Sync", body: String(e?.message ?? e), level: "warning" }); return; }
    this.pump(cx);
  }

  publish(cx) {
    if (this.remotes.length > 1) { openDialog("branch.publish", this.ctx(), "pick"); return; }
    this.sync(cx);
  }

  /** Opens the "…" menu or the Commit drop-down under the button that was pressed. */
  menu(which) {
    const b = this.anchor;
    if (this.closing) { this.closing = false; return; }
    if (!b) return;
    const ctx = this.ctx(), z = Number(settings().zoom) || 1;
    const items = which === "commit" ? commitMenu(ctx) : moreMenu(ctx);
    const size = menuSize(items);
    const leftEdge = b.x + b.width - size.width * z;
    const side = leftEdge >= 0 ? "left" : "right";
    const at = { x: Math.round(side === "left" ? leftEdge : b.x), y: Math.round(b.y + b.height + 3 * z) };
    openOverlay({ mod: "ws-git", kind: "popup", frame: "none", width: size.width, height: size.height, at, props: { mode: "menu", menu: which, ctx, side } });
  }

  // ---------- review ----------

  // Runs the steps of an action (git args, or async functions returning an exec result), then refreshes.
  act(label, steps, cx) {
    if (this.busy) return;
    this.busy = true; this.confirm = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const step of steps) {
          const started = Date.now();
          const r = Array.isArray(step) ? await this.git(step) : await step();
          if (Array.isArray(step) && r) this.log(step, r, Date.now() - started);
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

  unacceptAll(cx) {
    const paths = this.files.filter((f) => f.accepted).map((f) => f.path);
    if (paths.length) this.act("Unaccept all", [["restore", "--staged", "--", ...paths]], cx);
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
    const quoted = rows.map((r) => `${r.kind === "\\" || r.kind === " " ? " " : r.kind}${r.text}`).join("\n");
    openOverlay({ mod: "ws-comment", kind: "dialog", width: 560,
      props: { source: "diff", where: `${this.open}${lines ? `:${lines}` : ""} (uncommitted change)`, quote: quoted, agent: this.agent()?.address } });
  }


  // ---------- drawing ----------

  // `col`: a fixed-width column (1: Accept, 2: Reject or Unaccept), so a section's buttons
  // line up with its rows' whatever the labels.
  btn(id, label, onClick, t, tone, col = 0) {
    const color = tone === "ok" ? t.ansi2 : tone === "bad" ? t.ansi1 : t.muted;
    return div().id(id).h(22).px(7).flex().flex_none().items_center().rounded(5).text_size(11.5).text_color(color).cursor_pointer()
      .when(col > 0, (e) => e.w(col === 1 ? 76 : 90).justify_center())
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  /** A square button that opens a menu under itself (and closes it when pressed again). */
  icon(id, content, which, t) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5).text_size(14).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (ev) => this.press(which, ev))
      .on_click((_e, cx) => { cx.stop_propagation(); this.menu(which); }).child(content);
  }

  /** A press on a menu button: where it is, and whether its menu was open (then the click only closes it). */
  press(which, ev) {
    if (ev.bounds) this.anchor = ev.bounds;
    const m = /** @type {any} */ (shared(MENU));
    this.closing = Boolean(m && m.which === which && (m.open || Date.now() - (m.at ?? 0) < 400));
    if (m?.open) setShared(MENU, { ...m, open: false, at: Date.now() });
  }

  fileRow(f, t, depth, tree) {
    const on = this.open === f.path;
    const parts = f.path.split("/"), name = parts.pop();
    const m = mark(f), color = markColor(m);
    return h_flex().id(`rv-${f.path}`).h(FILE_H).flex_none().pl(8 + depth * 14).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().max_w(260).truncate().text_color(color).when(f.deleted, (e) => e.line_through()).child(name))
        .when(!tree && parts.length > 0, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))))
      .when(f.pending, (e) => e
        .child(this.btn(`rv-acc-${f.path}`, "Accept", (cx) => this.accept(f.path, cx), t, "ok", 1))
        .child(this.btn(`rv-rej-${f.path}`, this.confirm === f.path ? (f.fresh ? "Delete file?" : "Discard?") : "Reject", (cx) => this.reject(f.path, cx), t, "bad", 2)))
      .when(!f.pending, (e) => e.child(this.btn(`rv-un-${f.path}`, "Unaccept", (cx) => this.unaccept(f.path, cx), t, null, 2)))
      .child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(color).child(m));
  }

  dirRow(r, t) {
    return h_flex().id(`rv-dir-${r.key}`).h(FILE_H).flex_none().pl(8 + r.depth * 14).pr(8).gap(5).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (this.collapsed.has(r.key)) this.collapsed.delete(r.key); else this.collapsed.add(r.key); cx.notify(); })
      .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(r.open ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.name))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(String(r.count)));
  }

  /** One section's rows, as a list or a tree, in the chosen order. */
  rows(files, section, t) {
    const v = view();
    if (v.mode !== "tree") return sortFiles(files, v.sort).map((f) => this.fileRow(f, t, 0, false));
    return treeRows(files, v.sort, this.collapsed, section).map((r) => (r.kind === "dir" ? this.dirRow(r, t) : this.fileRow(r.f, t, r.depth, true)));
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

  sourceControl(t, pending, accepted) {
    const { branch, upstream, ahead, behind } = this.head;
    const big = this.primary();
    const header = h_flex().h(40).flex_none().pl(14).pr(8).gap(4).items_center()
      .child(div().font_semibold().child("Changes"))
      .child(div().flex_1())
      .child(this.icon("rv-i-more", svg(ICON("more")).size(16), "more", t));
    // ↓ and ↑ counts, as VS Code's status bar shows them.
    const counts = (size) => h_flex().flex_none().gap(6).items_center()
      .child(h_flex().gap(2).items_center().child(div().child(String(behind))).child(svg(ICON("arrow-down")).size(size).flex_none()))
      .child(h_flex().gap(2).items_center().child(div().child(String(ahead))).child(svg(ICON("arrow-up")).size(size).flex_none()));
    // The sync icon, a | and the counts, as VS Code's status bar has them.
    const chip = (id, icon, act, content, pipe = false) => h_flex().id(id).h(24).flex_none().px(6).gap(7).items_center().rounded(6)
      .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => act(cx)).child(svg(ICON(icon)).size(13).flex_none())
      .when(pipe, (e) => e.child(div().w(1).h(13).flex_none().bg(t.border)))
      .child(content);
    const branchRow = h_flex().h(32).flex_none().pl(6).pr(12).gap(8).items_center().text_size(12)
      .child(h_flex().id("rv-branch").flex_none().max_w(220).h(24).px(6).gap(5).items_center().rounded(6).cursor_pointer().text_color(t.accent)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => { if (this.root) openDialog("checkout", this.ctx(), "pick"); })
        .child(svg(ICON("git-branch")).size(13).flex_none())
        .child(div().min_w(0).truncate().child(branch ?? (this.root ? "detached HEAD" : "no repository"))))
      .when(Boolean(upstream), (e) => e.child(chip("rv-sync", "refresh", (cx) => this.sync(cx), counts(11), true)))
      .when(!upstream && Boolean(branch) && this.remotes.length > 0, (e) => e.child(chip("rv-publish", "cloud-upload", (cx) => this.publish(cx), div().child("Publish"))))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center().justify_end().text_color(t.dim)
        .when(Boolean(this.op), (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().spin(900)).child(div().min_w(0).truncate().child(`${this.op}…`))));
    const box = div().w_full().on_key_down((e, cx) => { if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") { this.commit("commit", cx); cx.stop_propagation(); } })
      .child(Textarea.new(this.message).w_full().px(8).py(6).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground));
    const fg = big.on ? t.solid_foreground : t.dim;
    const commitBtn = h_flex().h(32).w_full().items_center().rounded(7).overflow_hidden().bg(big.on ? t.solid : t.raised).text_color(fg).text_size(12.5).font_medium()
      .child(h_flex().id("rv-commit").flex_1().h_full().gap(6).items_center().justify_center().when(big.on && !this.op, (e) => e.cursor_pointer().hover((s) => s.opacity(0.9)))
        .on_click((_e, cx) => { if (big.on && !this.op) big.act(cx); })
        .when(Boolean(this.op), (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().spin(900)).child(div().child(`${this.op}…`)))
        .when(!this.op, (e) => e.child(svg(ICON(big.icon)).size(14).flex_none()).child(div().child(big.label))
          .when(Boolean(big.counts), (e) => e.child(div().ml(4).child(counts(12))))))
      .child(div().w(1).h(18).flex_none().bg(fg).opacity(0.3))
      .child(h_flex().id("rv-commit-more").w(32).h_full().flex_none().items_center().justify_center().cursor_pointer().hover((s) => s.opacity(0.85))
        .on_mouse_down("left", (ev) => this.press("commit", ev))
        .on_click(() => this.menu("commit")).child(svg(ICON("chevron-down")).size(15)));
    return v_flex().id("rv-top").w_full().flex_none().border_b(1).border_color(t.border)
      .on_size_change((size, cx) => { const h = size.height / (Number(settings().zoom) || 1); if (Math.abs(h - this.topH) > 0.5) { this.topH = h; cx.notify(); } })
      .child(header).child(branchRow)
      .child(v_flex().px(12).pt(4).pb(10).gap(8).child(box).child(commitBtn));
  }

  render(cx) {
    const t = theme();
    const loc = this.location();
    if (!this.loading && loc.cwd && loc.cwd !== this.cwd) this.refresh(cx);
    this.pump(cx);
    const mono = settings().font_family ?? "JetBrains Mono";
    const pending = this.files.filter((f) => f.pending), accepted = this.files.filter((f) => !f.pending);
    const pendingRows = this.rows(pending, "p", t), acceptedRows = this.rows(accepted, "a", t);
    const listRows = pendingRows.length + acceptedRows.length + (accepted.length ? 1 : 0) + (pending.length ? 1 : 0);
    const body = Math.max(0, this.height - this.topH - (this.range ? 40 : 0));
    const listH = Math.min(Math.max(60, listRows * FILE_H + 24), Math.floor(body * 0.45));
    const diffH = Math.max(0, body - listH - 1);
    const f = this.open ? this.file(this.open) : null;
    const local = !this.on;
    // A section's name and count, then its actions laid out like the rows' buttons below
    // (same padding, gap and a blank where the rows have their status letter), so they line up.
    const section = (label, n, actions) => h_flex().h(28).mt(2).flex_none().px(8).gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().text_size(10.5).font_medium().text_color(t.dim).child(label))
        .child(div().flex_none().min_w(18).h(16).px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).flex().items_center().justify_center().child(String(n))))
      .children(actions)
      .child(div().w(12).flex_none());
    const list = div().id("rv-files").w_full().h(listH).flex_none().overflow_y_scrollbar().border_b(1).border_color(t.border)
      .child(v_flex().p(6).w_full()
        .when(accepted.length > 0, (e) => e.child(section("ACCEPTED · commit when ready", accepted.length, [this.btn("rv-unaccept-all", "Unaccept all", (cx) => this.unacceptAll(cx), t, null, 2)])).children(acceptedRows))
        .when(pending.length > 0, (e) => e.child(section("TO REVIEW", pending.length, [
          this.btn("rv-accept-all", "Accept all", (cx) => this.acceptAll(cx), t, "ok", 1),
          this.btn("rv-reject-all", "Reject all", () => openDialog("discard.all", this.ctx(), "confirm"), t, "bad", 2),
        ])).children(pendingRows))
        .when(this.files.length === 0, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading && !this.root ? "Loading…" : "No uncommitted changes")))));
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
      .child(this.sourceControl(t, pending, accepted)).child(list).child(diff).when(footer !== null, (e) => e.child(footer));
  }
}
