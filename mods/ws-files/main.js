// Workstation Files: Herdr's shipped `files` mod (Apache-2.0) plus, on an open file,
// Comment (selected lines go to the comment tray), a Markdown Preview/Code switch with
// comments on the preview, Annotate (plannotator) and Open beside. Marked "WS:" below.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, agents, openOverlay, notify, run } from "herdr";

// WS: the agent comments go to, and line numbers of an offset range in a text.
function tabAgent() {
  const f = focused(), list = agents();
  return list.find((a) => a.address === f?.terminal) ?? list.filter((a) => a.tab === f?.tab).sort((a, b) => b.seq - a.seq)[0] ?? null;
}
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path ?? "");

// The panels share data in one VM, but their host tasks belong to separate copies.
const scans = globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map();

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [key, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(key);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.status?.code === 0 && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25); // Let both listeners for a watch batch join before starting Git.
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          next.status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (next.status?.code !== 0 && scans.get(repo) === next) scans.delete(repo);
        }
      });
      scans.set(repo, next);
      scan = next;
    }
    // Resume through our own host task, so another copy's close cannot cancel our follow-up work.
    while (current() && !scan.pollAt && !scan.task.is_done()) await cx.sleep(50);
    if (!current()) return null;
    if (!scan.pollAt) continue; // The scanning copy closed or reloaded.
    return scan;
  }
  return null;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

// WS: a folder takes its most important change below it, as VS Code's explorer shows it:
// a conflict, then a deletion, then an edit, then a new file.
const MARK_RANK = { U: 4, D: 3, M: 2, A: 1 };
function folderMarks(marks) {
  const out = {};
  for (const [path, mark] of Object.entries(marks)) {
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      const dir = path.slice(0, at);
      if ((MARK_RANK[out[dir]] ?? 0) >= MARK_RANK[mark]) break; // its parents already have it, or more
      out[dir] = mark;
    }
  }
  return out;
}
// VS Code's git decoration colors (its default dark and light themes).
const GIT_COLORS = {
  dark: { A: "#73C991", M: "#E2C08D", D: "#C74E39", U: "#E4676B" },
  light: { A: "#007100", M: "#895503", D: "#AD0707", U: "#AD0707" },
};
const markColor = (_t, mark) => GIT_COLORS[settings().dark === false ? "light" : "dark"][mark] ?? GIT_COLORS.dark.M;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(500, cx => this.refreshIfDue(cx));
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading) return;
    const now = Date.now();
    if (context.catchUp || (context.dirtyAt && now >= context.watchAt) || now >= context.pollAt) this.refresh(cx);
  }

  watch(root, context, cx) {
    if (context.on || context.watch?.root === root) return;
    context.watch?.pending?.cancel();
    const watch = { root };
    context.watch = watch;
    cx.spawn(async cx => {
      try {
        while (this.context === context && context.watch === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && context.watch === watch && this.current(context)) {
            context.dirtyAt = Date.now() + 1;
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (context.watch === watch) context.watch = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    const visiting = next !== this.context?.key;
    if (visiting) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders, file: this.file });
        this.context.watch?.pending?.cancel();
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, dirtyAt: 0 }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    const context = this.context;
    const now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading) return;
    if (context.catchUp && !context.dirtyAt) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: visiting || context.catchUp,
      allowInactive: visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        this.watch(cwd, context, cx);
        const dirtyAtListing = context.dirtyAt;
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        if (!this.current(context)) return;
        const marks = {};
        let covered = dirtyAtListing;
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const scan = await repoStatus(root, on, request, cx, () => this.context === context);
          if (!scan || !this.current(context)) return;
          const { status, started, pollAt, watchAt } = scan;
          context.lastStatus = started;
          context.pollAt = pollAt;
          context.watchAt = watchAt;
          covered = Math.min(dirtyAtListing, started);
          if (request.urgent && request.after > started) context.catchUp = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            // WS: a conflict (UU, AA, DD, AU, UA, DU, UD) is U before anything else, as in Changes.
            const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
            marks[`${root}/${entry.slice(3)}`] = conflict ? "U" : xy === "??" || xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
          }
        } else {
          context.watchAt = Date.now();
        }
        if (!this.current(context)) return;
        if (context.dirtyAt <= covered) context.dirtyAt = 0;
        this.marks = marks; this.folderMarks = folderMarks(marks); this.error = null; // WS: folders too
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.text = null; this.mdSelection = null; this.preview = isMarkdown(path); // WS
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.text = text.length > 400000 ? text.slice(0, 400000) : text; // WS
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // WS: a comment on the selected code (or the cursor's line), or on the preview's selection.
  comment() {
    if (!this.file || this.text === null) return;
    let start, end;
    if (this.preview && isMarkdown(this.file)) {
      const r = this.mdSelection?.range;
      if (!r) { notify({ title: "Comment", body: "Select text in the preview first.", level: "warning", timeout: 2500 }); return; }
      start = r.start; end = r.end;
    } else if (this.code) {
      const r = this.code.selected_range();
      start = Math.min(r.start, r.end); end = Math.max(r.start, r.end);
      if (start === end) { // just a cursor: the whole line
        start = this.text.lastIndexOf("\n", start - 1) + 1;
        const nl = this.text.indexOf("\n", end);
        end = nl < 0 ? this.text.length : nl;
      }
    } else return;
    const first = lineOf(this.text, start), last = lineOf(this.text, Math.max(start, end - 1));
    const where = `${this.file}:${first === last ? first : `${first}-${last}`}`;
    openOverlay({ mod: "ws-comment", kind: "dialog", width: 560,
      props: { source: this.preview && isMarkdown(this.file) ? "markdown" : "file", where, quote: this.text.slice(start, end), agent: tabAgent()?.address } });
  }

  annotate(cx) {
    const agent = tabAgent(), file = `${this.root}/${this.file}`;
    cx.spawn(async (_cx) => {
      const r = await exec("plannotator-tui", ["hc", "open", file, ...(agent ? ["--terminal", agent.address] : [])], { timeout: 60000 }).catch((e) => ({ code: 127, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Annotate", body: String(r.stderr).trim().slice(0, 200) || "plannotator-tui failed", level: "error" });
    });
  }

  wsButton(id, label, onClick, t, on = false) {
    return div().id(id).h(24).px(7).flex().flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      const mark = entry.dir ? this.folderMarks?.[`${this.root}/${path}`] : this.marks[`${this.root}/${path}`]; // WS: folders too
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        // WS: the name in its change's color; a file's letter, or a folder's dot, at the end.
        .child(div().flex_1().min_w(0).truncate().when(Boolean(mark), el => el.text_color(markColor(t, mark))).child(entry.name))
        .when(Boolean(mark) && !entry.dir, el => el.child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(markColor(t, mark)).child(mark)))
        .when(Boolean(mark) && entry.dir, el => el.child(div().w(12).flex_none().flex().justify_center().child(div().size(6).rounded(3).bg(markColor(t, mark)).opacity(0.75)))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    else this.refreshIfDue(cx);
    const t = theme();
    const font = this.code ? settings() : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      // WS: actions on the open file.
      .when(Boolean(this.file) && this.text !== null, el => el.child(h_flex().h(34).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .when(isMarkdown(this.file), el => el
          .child(this.wsButton("wf-preview", "Preview", (cx) => { this.preview = true; cx.notify(); }, t, this.preview))
          .child(this.wsButton("wf-code", "Code", (cx) => { this.preview = false; cx.notify(); }, t, !this.preview)))
        .child(div().flex_1())
        .child(this.wsButton("wf-comment", "Comment", () => this.comment(), t))
        .when(isMarkdown(this.file), el => el
          .child(this.wsButton("wf-annotate", "Annotate", (cx) => this.annotate(cx), t))
          .child(this.wsButton("wf-beside", "Open beside", () => run("pane.split", { direction: "right", mod: "ws-md-preview", props: { file: `${this.root}/${this.file}` } }), t)))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code
        ? (this.preview && isMarkdown(this.file) && this.text !== null
          // WS: rendered Markdown; select text, then Comment.
          ? div().id("wf-md").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(12).text_size(13.5)
            .child(TextView.markdown("wf-md-body", this.text).selectable(true).on_selection_change((sel, cx) => { this.mdSelection = sel; cx.notify(); }))
          : Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0))
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
