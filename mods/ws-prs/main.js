// @ts-check
// PRs panel (the top bar's PRs, id ws-prs): pull requests (GitHub, via gh) and merge requests
// (GitLab, via glab), reviewed and handled here from start to merge.
// The list: this repository's, those waiting on your review, or yours (everywhere); open or closed.
// A PR's page has three tabs:
//   Conversation: the description, reviews and comments, the unresolved threads, a comment box.
//   Files: each file's diff with its review threads in place (reply, resolve). Click a line,
//          shift-click another, Comment: the comment waits in your review, goes now, or goes to the agent.
//   Checks: every check; click one for its page; Re-run failed.
// Below: Review (Approve, Request changes or Comment, with the waiting line comments), Merge
// (squash, merge or rebase; or when checks pass), Checkout here, and More (agent, close, draft, browser).
// The PRs button's badge counts the PRs waiting on your review (shared "ws.prs.waiting").
// Key commands: ws-prs:repo|review|mine|open|closed|first|back|conversation|files|checks.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState, TextView } from "gpui-base";
import { exec, theme, settings, focused, panes, spaces, layout, window, notify, run, setShared, shared, checking, nextCommand } from "herdr";
import { parseRemote, listRepo, listMine, detail, comment, review, reply, resolve, merge, setOpen, setDraft, rerunFailed, checkout } from "./forge.js";
import { parseDiff, markWords } from "./diff-words.js";
import { addComment, currentAgent, send, agentLabel } from "./comments.js";

const WAITING = "ws.prs.waiting";
const ROW = 20;
const ICON = (name) => `mods/ws-review/icons/${name}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

/** "now", "5m", "3h", "2d", or the date. */
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const m = Math.floor((now - at) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 14 * 1440) return `${Math.floor(m / 1440)}d`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * A file's diff rows with its review threads and waiting comments placed under the line they
 * are on. Returns { rows (parseDiff's, each with i), out (rows, threads and pending in order),
 * loose (threads whose line isn't in the diff any more) }.
 */
export function placeThreads(text, threads, pending) {
  const d = parseDiff(text);
  markWords(d.rows);
  const out = [], placed = new Set();
  const on = (r, side, line) => (side === "old" ? r.kind === "-" && r.oldN === line : r.kind !== "-" && r.newN === line);
  d.rows.forEach((r, i) => {
    out.push({ ...r, i });
    if (r.kind === "@" || r.kind === "\\") return;
    for (const t of threads) if (!placed.has(t) && on(r, t.side, t.line)) { out.push({ kind: "thread", t }); placed.add(t); }
    for (const c of pending) if (!placed.has(c) && on(r, c.side, c.line)) { out.push({ kind: "pending", c }); placed.add(c); }
  });
  return { rows: d.rows, out, loose: threads.filter((t) => !placed.has(t)) };
}

/** Selected diff rows → where a line comment goes: { side, line, startLine, oldLine }. */
export function lineTarget(rows) {
  const lines = rows.filter((r) => r.kind === "+" || r.kind === "-" || r.kind === " ");
  if (!lines.length) return null;
  const old = lines.every((r) => r.kind === "-");
  const nums = lines.map((r) => (old ? r.oldN : r.kind === "-" ? null : r.newN)).filter((n) => n != null);
  if (!nums.length) return null;
  const last = lines[lines.length - 1];
  return { side: old ? "old" : "new", line: Math.max(...nums), startLine: Math.min(...nums), oldLine: last.kind === " " ? last.oldN : null };
}

const keyOf = (pr) => `${pr.forge}:${pr.host}/${pr.repo}#${pr.number}`;

export default class PRs extends View {
  init(_props, cx) {
    this.where = null;        // { forge, host, path, root, on } of the focused repository
    this.whereFor = null;     // the folder `where` was found for
    this.scope = localStorage.getItem("ws-prs.scope") ?? "repo"; // "repo" | "review" | "mine"
    this.state = "open";      // "open" | "closed"
    this.list = []; this.listKey = null; this.listAt = 0; this.listError = null; this.loadingList = false;
    this.pr = null;           // the PR whose page shows (a Detail once loaded)
    this.diffs = new Map();
    this.loadingDetail = false; this.detailAt = 0; this.detailError = null;
    this.tab = "conversation";
    this.file = null;         // Files: the file whose diff shows
    this.range = null;        // { from, to } indexes into that file's rows
    this.compose = null;      // a line comment being written: { path, side, line, startLine, oldLine, quote }
    this.replying = null;     // a thread being replied to (id)
    this.sheet = null;        // "review" | "merge" | "more" above the footer
    this.event = "comment";   // the review's kind: "approve" | "changes" | "comment"
    this.method = localStorage.getItem("ws-prs.method") ?? "squash";
    this.deleteBranch = localStorage.getItem("ws-prs.delete") !== "0";
    this.busy = null;
    this.height = 0;
    this.headH = 100;         // the PR header's measured height
    this.sheetH = 0;          // the open sheet's measured height
    this.lineBox = TextareaState.new({ placeholder: "Comment on these lines…", rows: 3 });
    this.replyBox = TextareaState.new({ placeholder: "Reply…", rows: 2 });
    this.commentBox = TextareaState.new({ placeholder: "Leave a comment", rows: 2 });
    this.reviewBox = TextareaState.new({ placeholder: "Review summary (optional for Approve)", rows: 3 });
    for (const box of [this.lineBox, this.replyBox, this.commentBox, this.reviewBox]) box.set_auto_grow?.(2, 8);
    if (checking()) return;
    // Key commands ("ws-prs:<command>" in keys.json, or herdr-app do ws-prs.<command>):
    // repo / review / mine, open / closed, first (open the first PR), back, conversation / files / checks.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (["repo", "review", "mine"].includes(c)) { this.pr = null; this.setScope(c, cx); }
        else if (c === "open" || c === "closed") { this.pr = null; this.setState(c, cx); }
        else if (c === "first" && this.list[0]) this.open(this.list[0], cx);
        else if (c === "back" && this.pr) this.back(cx);
        else if (["conversation", "files", "checks"].includes(c) && this.pr) { this.tab = c; this.range = null; this.compose = null; }
        cx.notify();
      }
    });
    cx.timer.every(5000, (cx) => this.tick(cx));
    this.tick(cx);
    this.countWaiting(cx);
    cx.timer.every(300000, (cx) => this.countWaiting(cx));
  }

  async close(_cx) {
    for (const box of [this.lineBox, this.replyBox, this.commentBox, this.reviewBox]) box.release();
  }

  // ---------- where and when ----------

  shown() {
    if (window()?.visible === false) return false;
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "ws-prs");
  }

  location() {
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { cwd: (pane?.terminal ? pane.cwd : null) ?? (f?.terminal ? f.cwd : null) ?? space?.folder ?? null, on: space?.machine ?? null };
  }

  /** The focused repository's forge and path, from its origin remote (else its first remote). */
  async locate() {
    const { cwd, on } = this.location();
    if (!cwd) return null;
    if (this.whereFor === `${on ?? ""}:${cwd}`) return this.where;
    const git = (args) => exec("git", args, { cwd, on }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const top = await git(["rev-parse", "--show-toplevel"]);
    let where = null;
    if (top.code === 0) {
      const remotes = (await git(["remote"])).stdout.split("\n").filter(Boolean);
      const name = remotes.includes("origin") ? "origin" : remotes[0];
      const url = name ? (await git(["remote", "get-url", name])).stdout.trim() : "";
      const r = parseRemote(url);
      if (r) where = { ...r, root: top.stdout.trim(), on };
    }
    this.whereFor = `${on ?? ""}:${cwd}`;
    this.where = where;
    return where;
  }

  tick(cx) {
    if (!this.shown()) return;
    cx.spawn(async (cx) => {
      const before = this.where;
      await this.locate();
      if (before !== this.where) cx.notify();
      if (!this.pr) this.loadList(cx, false);
      else if (Date.now() - this.detailAt > 60000 && !this.busy && !this.compose && !this.replying && !this.sheet) this.loadDetail(cx, false);
    });
  }

  /** How many PRs wait on your review: the PRs button's badge. */
  countWaiting(cx) {
    cx.spawn(async (_cx) => {
      const forge = this.where?.forge ?? "github", host = this.where?.host ?? "github.com";
      const rows = await listMine(forge, host, "review", "open").catch(() => null);
      if (rows) setShared(WAITING, rows.length);
    });
  }

  // ---------- the list ----------

  setScope(scope, cx) {
    this.scope = scope; localStorage.setItem("ws-prs.scope", scope);
    this.list = []; this.loadList(cx, true); cx.notify();
  }
  setState(state, cx) { this.state = state; this.list = []; this.loadList(cx, true); cx.notify(); }

  loadList(cx, force) {
    const w = this.where;
    const key = `${this.scope}|${this.state}|${this.scope === "repo" ? `${w?.host}/${w?.path}` : w?.forge ?? "github"}`;
    if (this.loadingList || (!force && key === this.listKey && Date.now() - this.listAt < 60000)) return;
    if (this.scope === "repo" && !w) { this.list = []; this.listKey = key; this.listError = "This folder isn't a GitHub or GitLab repository. To review or Mine shows PRs everywhere."; return; }
    this.loadingList = true;
    cx.spawn(async (cx) => {
      try {
        const rows = this.scope === "repo" ? await listRepo(w, this.state)
          : await listMine(w?.forge ?? "github", w?.host ?? "github.com", this.scope, this.state);
        this.list = rows; this.listError = null;
        if (this.scope === "review" && this.state === "open") setShared(WAITING, rows.length);
      } catch (e) {
        this.listError = String(e?.message ?? e); this.list = [];
      } finally {
        this.listKey = key; this.listAt = Date.now(); this.loadingList = false;
        cx.notify();
      }
    });
  }

  // ---------- a PR ----------

  open(pr, cx) {
    this.pr = pr; this.diffs = new Map(); this.tab = "conversation"; this.file = null; this.range = null;
    this.compose = null; this.replying = null; this.sheet = null; this.detailError = null;
    this.loadDetail(cx, true);
    cx.notify();
  }

  back(cx) { this.pr = null; this.sheet = null; this.compose = null; this.replying = null; this.loadList(cx, true); cx.notify(); }

  loadDetail(cx, first) {
    const pr = this.pr;
    if (!pr || this.loadingDetail) return;
    this.loadingDetail = true;
    cx.spawn(async (cx) => {
      try {
        const d = await detail(pr);
        if (this.pr && keyOf(this.pr) === keyOf(pr)) {
          this.pr = d.pr; this.diffs = d.diffs; this.detailError = null;
          if (!this.file || !this.diffs.has(this.file)) this.file = d.pr.files[0]?.path ?? null;
          if (first) this.range = null;
        }
      } catch (e) {
        this.detailError = String(e?.message ?? e);
      } finally {
        this.detailAt = Date.now(); this.loadingDetail = false;
        cx.notify();
      }
    });
  }

  /** Line comments waiting to go with the next review (kept per PR across reloads). */
  pending(pr = this.pr) {
    if (!pr) return [];
    try { return JSON.parse(localStorage.getItem(`ws-prs.pending:${keyOf(pr)}`) ?? "[]"); } catch { return []; }
  }
  setPending(list, pr = this.pr) {
    if (!pr) return;
    if (list.length) localStorage.setItem(`ws-prs.pending:${keyOf(pr)}`, JSON.stringify(list));
    else localStorage.removeItem(`ws-prs.pending:${keyOf(pr)}`);
  }

  /** Runs an action on the PR, says how it went, and reloads it. */
  act(label, fn, cx, done = null) {
    if (this.busy) return;
    this.busy = label; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await fn();
        notify({ title: done ?? `${label}: done`, body: this.pr ? `#${this.pr.number} ${this.pr.title}` : "", level: "success", timeout: 3000 });
        return true;
      } catch (e) {
        notify({ title: `${label} failed`, body: String(e?.message ?? e).slice(0, 400), level: "error" });
        return false;
      } finally {
        this.busy = null;
        this.loadDetail(cx, false);
        this.listAt = 0;
        cx.notify();
      }
    });
  }

  sameRepo() {
    const w = this.where, pr = this.pr;
    return Boolean(w && pr && !w.on && w.forge === pr.forge && w.host === pr.host && w.path.toLowerCase() === pr.repo.toLowerCase());
  }

  openUrl(url) {
    if (!url) return;
    exec(window()?.platform === "macos" ? "open" : "xdg-open", [url]).catch(() => null);
  }

  copy(text) {
    exec("sh", ["-c", 'printf %s "$1" | (pbcopy 2>/dev/null || wl-copy 2>/dev/null || xclip -selection clipboard)', "copy", text]).catch(() => null);
    notify({ title: "Copied", body: text, level: "success", timeout: 1500 });
  }

  // ---------- the agent ----------

  /** Puts comments in the tray for the agent in the focused tab; `now`: send them too. */
  toAgent(items, now, cx) {
    const agent = currentAgent()?.address;
    if (!agent) { notify({ title: "No agent", body: "Focus a tab with an agent (Claude Code, Codex, …) first.", level: "warning" }); return; }
    const added = items.map((c) => addComment({ agent, source: "pr", ...c }));
    if (!now) {
      notify({ title: `${added.length} in the Comments tray`, body: `for ${agentLabel(agent)}: Send when ready`, level: "success", timeout: 3000 });
      run("layout.select", { stack: "panel-body", child: "ws-comments" });
      return;
    }
    cx.spawn(async (_cx) => {
      const err = await send(agent, added);
      notify(err === "queued" ? { title: "Queued for the agent", body: "It goes when the agent stops working.", level: "info", timeout: 3000 }
        : err ? { title: "Not sent", body: err, level: "error" } : { title: "Sent to the agent", body: agentLabel(agent), level: "success", timeout: 2500 });
    });
  }

  askReview(cx) {
    const pr = this.pr, tool = pr.forge === "github" ? `gh pr view ${pr.number} -R ${pr.host}/${pr.repo} and gh pr diff ${pr.number} -R ${pr.host}/${pr.repo}` : `glab mr view ${pr.number} -R ${pr.repo} and glab mr diff ${pr.number} -R ${pr.repo}`;
    this.toAgent([{ where: `PR #${pr.number} "${pr.title}" ${pr.url}`, quote: "", note: `Review this pull request: read it with ${tool}, then list the problems you find by file and line, most serious first. Don't change any files.` }], true, cx);
  }

  threadItem(t) {
    const pr = this.pr;
    const text = this.diffs.get(t.path);
    let quote = "";
    if (text) {
      const r = parseDiff(text).rows.find((x) => (t.side === "old" ? x.kind === "-" && x.oldN === t.line : x.kind !== "-" && x.newN === t.line));
      if (r) quote = r.text;
    }
    const said = t.comments.map((c) => `${c.author}: ${c.body.trim()}`).join("\n\n");
    return { where: `PR #${pr.number} · ${t.path}${t.line ? `:${t.line}` : ""}`, quote, note: `Review comment to address:\n${said}` };
  }

  fixThreads(cx) {
    const open = (this.pr?.threads ?? []).filter((t) => !t.resolved);
    if (!open.length) { notify({ title: "No unresolved threads", level: "info", timeout: 2000 }); return; }
    this.toAgent(open.map((t) => this.threadItem(t)), false, cx);
  }

  // ---------- line comments ----------

  selectRow(i, shift, cx) {
    if (shift && this.range) this.range = { from: Math.min(this.range.from, i), to: Math.max(this.range.from, i) };
    else this.range = this.range && this.range.from === i && this.range.to === i ? null : { from: i, to: i };
    this.compose = null;
    cx.notify();
  }

  startCompose(rows, cx) {
    if (!this.range) return;
    const picked = rows.slice(this.range.from, this.range.to + 1);
    const target = lineTarget(picked);
    if (!target) { notify({ title: "Pick a changed or context line", level: "info", timeout: 2000 }); return; }
    this.compose = { path: this.file, ...target, quote: picked.filter((r) => r.kind !== "@").map((r) => `${r.kind === " " ? " " : r.kind}${r.text}`).join("\n") };
    this.lineBox.set_value("");
    this.lineBox.focus();
    cx.notify();
  }

  /** "pending": into the review; "now": a one-comment review; "agent": to the agent's tray. */
  finishCompose(how, cx) {
    const c = this.compose, body = this.lineBox.value().trim();
    if (!c) return;
    if (!body && how !== "agent") { notify({ title: "Write the comment first", level: "info", timeout: 2000 }); return; }
    const item = { path: c.path, side: c.side, line: c.line, startLine: c.startLine, oldLine: c.oldLine, body, quote: c.quote };
    this.compose = null; this.range = null;
    if (how === "pending") { this.setPending([...this.pending(), item]); cx.notify(); return; }
    if (how === "agent") {
      this.toAgent([{ where: `PR #${this.pr.number} · ${c.path}:${c.startLine === c.line ? c.line : `${c.startLine}-${c.line}`}`, quote: c.quote, note: body }], false, cx);
      cx.notify();
      return;
    }
    const pr = this.pr;
    this.act("Comment", () => review(pr, "comment", "", [item]), cx, "Comment posted");
  }

  submitReview(cx) {
    const pr = this.pr, body = this.reviewBox.value().trim(), lines = this.pending(), event = this.event;
    if (event === "changes" && !body) { notify({ title: "Say what to change", body: "Request changes needs a summary.", level: "info", timeout: 2500 }); return; }
    if (event === "comment" && !body && !lines.length) { notify({ title: "Nothing to send", body: "Write a summary or add line comments.", level: "info", timeout: 2500 }); return; }
    this.sheet = null;
    this.act(event === "approve" ? "Approve" : event === "changes" ? "Request changes" : "Review", async () => {
      await review(pr, event, body, lines);
      this.setPending([], pr); this.reviewBox.set_value("");
    }, cx, event === "approve" ? "Approved" : event === "changes" ? "Changes requested" : "Review posted");
  }

  // ---------- drawing ----------

  btn(id, label, onClick, t, kind = null, disabled = false) {
    const solid = kind === "solid", bad = kind === "bad", ok = kind === "ok";
    return h_flex().id(id).h(26).px(10).flex_none().items_center().justify_center().rounded(6).text_size(12)
      .bg(solid ? t.solid : t.raised).text_color(disabled ? t.dim : solid ? t.solid_foreground : bad ? t.ansi1 : ok ? t.ansi2 : t.foreground)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(label);
  }

  chip(id, label, on, onClick, t) {
    return div().id(id).h(22).px(8).flex().flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  badge(text, color, t) {
    return div().flex_none().px(5).h(16).flex().items_center().rounded(4).bg(color + "26").text_size(10.5).font_medium().text_color(color).child(text);
  }

  stateBadge(pr, t) {
    if (pr.state === "merged") return this.badge("Merged", t.ansi5, t);
    if (pr.state === "closed") return this.badge("Closed", t.ansi1, t);
    return pr.draft ? this.badge("Draft", t.dim, t) : this.badge("Open", t.ansi2, t);
  }

  checksMark(state, t) {
    if (!state) return null;
    const color = state === "pass" ? t.ansi2 : state === "fail" ? t.ansi1 : t.ansi3;
    return div().flex_none().size(8).rounded(4).bg(color);
  }

  reviewText(pr, t) {
    if (pr.review === "approved") return div().flex_none().text_size(11).text_color(t.ansi2).child("Approved");
    if (pr.review === "changes") return div().flex_none().text_size(11).text_color(t.ansi1).child("Changes requested");
    if (pr.review === "required") return div().flex_none().text_size(11).text_color(t.dim).child("Review required");
    return null;
  }

  listView(t) {
    const w = this.where;
    const repoName = w ? w.path : "no repository";
    const head = v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().h(40).px(14).gap(8).items_center()
        .child(div().font_semibold().child(w?.forge === "gitlab" ? "Merge requests" : "Pull requests"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.scope === "repo" ? repoName : "everywhere"))
        .when(this.loadingList, (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().spin(900)))
        .child(this.chip("pr-refresh", "Refresh", false, (cx) => { this.whereFor = null; cx.spawn(async (cx) => { await this.locate(); this.loadList(cx, true); cx.notify(); }); }, t)))
      .child(h_flex().h(32).px(12).gap(4).items_center()
        .child(this.chip("pr-repo", "This repo", this.scope === "repo", (cx) => this.setScope("repo", cx), t))
        .child(this.chip("pr-review", `To review${shared(WAITING) ? ` ${shared(WAITING)}` : ""}`, this.scope === "review", (cx) => this.setScope("review", cx), t))
        .child(this.chip("pr-mine", "Mine", this.scope === "mine", (cx) => this.setScope("mine", cx), t))
        .child(div().flex_1())
        .child(this.chip("pr-open", "Open", this.state === "open", (cx) => this.setState("open", cx), t))
        .child(this.chip("pr-closed", "Closed", this.state === "closed", (cx) => this.setState("closed", cx), t)));
    const row = (pr, i) => v_flex().id(`pr-${i}`).px(12).py(7).gap(3).flex_none().border_b(1).border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(pr, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_medium().when(pr.draft, (e) => e.text_color(t.muted)).child(pr.title))
        .child(this.checksMark(pr.checks, t) ?? div()))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_none().child(`#${pr.number}`))
        .when(this.scope !== "repo", (e) => e.child(div().flex_none().max_w(160).truncate().child(pr.repo)))
        .child(div().flex_none().max_w(110).truncate().child(pr.author))
        .child(div().flex_none().child(ago(pr.updatedAt)))
        .when(pr.additions != null, (e) => e.child(div().flex_none().text_color(t.ansi2).child(`+${pr.additions}`)).child(div().flex_none().text_color(t.ansi1).child(`−${pr.deletions}`)))
        .child(div().flex_1())
        .when(pr.state !== "open" || pr.draft, (e) => e.child(this.stateBadge(pr, t)))
        .child(this.reviewText(pr, t) ?? div()));
    const empty = this.listError ?? (this.loadingList ? "Loading…" : this.state === "open" ? "No open pull requests here." : "No closed pull requests here.");
    return v_flex().size_full().min_h(0)
      .child(head)
      .child(div().id("pr-list").w_full().h(Math.max(0, this.height - 75)).flex_none().overflow_y_scrollbar()
        .child(v_flex().w_full()
          .when(this.list.length === 0, (e) => e.child(div().p(14).text_size(12.5).text_color(this.listError ? t.ansi1 : t.dim).whitespace_normal().child(empty)))
          .children(this.list.map(row))));
  }

  header(pr, t) {
    const threads = pr.threads ?? [], open = threads.filter((x) => !x.resolved).length;
    const files = pr.files?.length ?? 0, checks = pr.checkList ?? [];
    const failing = checks.filter((c) => c.status === "fail").length;
    const tab = (id, label, n, warn = false) => h_flex().id(`pr-tab-${id}`).h(30).px(10).gap(5).items_center().cursor_pointer().text_size(12)
      .border_b(2).border_color(this.tab === id ? t.accent : t.background).text_color(this.tab === id ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.tab = id; this.range = null; this.compose = null; cx.notify(); })
      .child(div().child(label))
      .when(n != null, (e) => e.child(div().min_w(16).h(15).px(4).rounded(7).bg(warn ? t.ansi1 + "30" : t.raised).text_size(10).text_color(warn ? t.ansi1 : t.muted).flex().items_center().justify_center().child(String(n))));
    return v_flex().id("pr-head").flex_none().border_b(1).border_color(t.border)
      .on_size_change((size, cx) => { const h = size.height / (Number(settings().zoom) || 1); if (Math.abs(h - this.headH) > 0.5) { this.headH = h; cx.notify(); } })
      .child(h_flex().h(38).px(8).gap(6).items_center()
        .child(div().id("pr-back").h(24).px(6).flex().items_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.back(cx)).child("‹ All"))
        .child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(pr.title))
        .when(this.loadingDetail || Boolean(this.busy), (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().spin(900))))
      .child(h_flex().px(12).pb(6).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(this.stateBadge(pr, t))
        .child(div().flex_none().max_w(120).truncate().child(pr.author))
        .child(div().min_w(0).truncate().child(`${pr.head} → ${pr.base}`))
        .child(div().flex_1())
        .child(this.reviewText(pr, t) ?? div()))
      .child(h_flex().px(6).gap(2).items_center()
        .child(tab("conversation", "Conversation", open || null, false))
        .child(tab("files", "Files", files))
        .child(tab("checks", "Checks", checks.length || null, failing > 0)));
  }

  text(body, t, id) {
    return body.trim()
      ? div().w_full().text_size(12.5).child(TextView.markdown(id, body).selectable(true))
      : div().text_size(12).text_color(t.dim).child("No description.");
  }

  threadCard(th, t, key) {
    const pr = this.pr;
    return v_flex().id(`th-${key}`).mx(8).my(6).p(8).gap(6).rounded(7).border_1().border_color(th.resolved ? t.border : t.accent + "80").bg(t.surface).font_family(settings().ui_font_family ?? "system-ui")
      .on_click((_e, cx) => cx.stop_propagation())
      .children(th.comments.map((c, k) => v_flex().gap(2)
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(div().font_semibold().text_color(t.foreground).child(c.author))
          .child(div().text_color(t.dim).child(ago(c.at))))
        .child(div().text_size(12.5).whitespace_normal().text_color(t.foreground).child(c.body.trim() || " "))
        .when(k === 0 && th.outdated, (e) => e.child(div().text_size(10.5).text_color(t.dim).child("outdated")))))
      .when(this.replying === th.id, (e) => e.child(v_flex().gap(6)
        .child(div().px(8).py(6).rounded(6).border_1().border_color(t.accent).bg(t.background).child(Textarea.new(this.replyBox).w_full().text_size(12.5)))
        .child(h_flex().gap(6).justify_end()
          .child(this.btn(`th-cancel-${key}`, "Cancel", (cx) => { this.replying = null; cx.notify(); }, t))
          .child(this.btn(`th-send-${key}`, "Reply", (cx) => {
            const body = this.replyBox.value().trim();
            if (!body) return;
            this.replying = null;
            this.act("Reply", () => reply(pr, th, body), cx, "Reply posted");
          }, t, "solid")))))
      .when(this.replying !== th.id, (e) => e.child(h_flex().gap(6)
        .child(this.btn(`th-reply-${key}`, "Reply", (cx) => { this.replying = th.id; this.replyBox.set_value(""); this.replyBox.focus(); cx.notify(); }, t))
        .child(this.btn(`th-res-${key}`, th.resolved ? "Unresolve" : "Resolve", (cx) => this.act(th.resolved ? "Unresolve" : "Resolve", () => resolve(pr, th, !th.resolved), cx), t))
        .child(this.btn(`th-agent-${key}`, "To agent", (cx) => this.toAgent([this.threadItem(th)], false, cx), t))
        .child(div().flex_1())
        .when(th.resolved, (e) => e.child(div().text_size(11).text_color(t.dim).child("resolved")))));
  }

  conversation(pr, t, bodyH) {
    const open = (pr.threads ?? []).filter((x) => !x.resolved);
    const item = (it, i) => v_flex().id(`tl-${i}`).gap(4).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().font_semibold().child(it.author))
        .when(it.kind === "review", (e) => e.child(this.badge(it.state === "approved" ? "approved" : it.state === "changes_requested" ? "requested changes" : it.state.replace(/_/g, " "),
          it.state === "approved" ? t.ansi2 : it.state === "changes_requested" ? t.ansi1 : t.muted, t)))
        .child(div().text_color(t.dim).child(ago(it.at))))
      .when(Boolean(it.body?.trim()), (e) => e.child(this.text(it.body, t, `tl-body-${i}`)));
    return div().id("pr-conv").w_full().h(bodyH).flex_none().overflow_y_scrollbar()
      .child(v_flex().p(12).gap(10)
        .child(v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border)
          .child(h_flex().gap(6).items_center().text_size(11.5).child(div().font_semibold().child(pr.author)).child(div().text_color(t.dim).child(`opened ${ago(pr.createdAt)} ago`)))
          .child(this.text(pr.body ?? "", t, "pr-body")))
        .when(open.length > 0, (e) => e.child(v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.accent + "80")
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().font_medium().child(`${open.length} unresolved thread${open.length === 1 ? "" : "s"}`))
            .child(this.btn("pr-fix-all", "All to agent", (cx) => this.fixThreads(cx), t)))
          .children(open.map((th, i) => h_flex().id(`ot-${i}`).gap(6).items_center().text_size(12).cursor_pointer().hover((s) => s.text_color(t.accent))
            .on_click((_e, cx) => { this.tab = "files"; this.file = th.path; this.range = null; cx.notify(); })
            .child(div().flex_none().text_color(t.dim).child(`${th.path.split("/").pop()}:${th.line ?? "?"}`))
            .child(div().flex_1().min_w(0).truncate().child(th.comments[0]?.body ?? ""))))))
        .children((pr.timeline ?? []).map(item))
        .when(pr.state === "open", (e) => e.child(v_flex().gap(6)
          .child(div().px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background)
            .on_key_down((ev, cx) => { if (ev.keystroke === "cmd-enter" || ev.keystroke === "ctrl-enter") { cx.stop_propagation(); this.postComment(cx); } })
            .child(Textarea.new(this.commentBox).w_full().text_size(12.5)))
          .child(h_flex().gap(6).justify_end().child(this.btn("pr-comment", "Comment", (cx) => this.postComment(cx), t, "solid"))))));
  }

  postComment(cx) {
    const body = this.commentBox.value().trim(), pr = this.pr;
    if (!body) return;
    this.act("Comment", async () => { await comment(pr, body); this.commentBox.set_value(""); }, cx, "Comment posted");
  }

  line(r, t, key) {
    const tabs = (s) => s.replace(/\t/g, "    ");
    if (!r.words) return div().flex_1().min_w(0).whitespace_normal().child(tabs(r.text) || " ");
    const mark = r.kind === "+" ? t.ansi2 + "44" : t.ansi1 + "44";
    const pieces = r.words.flatMap((w) => (w.text.match(/\s+|\S+/g) ?? []).map((text) => ({ text, changed: w.changed })));
    return h_flex().flex_1().min_w(0).flex_wrap().children(pieces.map((w, k) => div().id(`${key}-w${k}`).flex_none().when(w.changed, (e) => e.bg(mark)).child(tabs(w.text))));
  }

  filesView(pr, t, mono, bodyH) {
    const files = pr.files ?? [];
    const threadsBy = new Map();
    for (const th of pr.threads ?? []) threadsBy.set(th.path, (threadsBy.get(th.path) ?? 0) + (th.resolved ? 0 : 1));
    const listH = Math.min(files.length * 24 + 9, Math.max(80, Math.floor(bodyH * 0.3)));
    const list = div().id("pr-files").w_full().h(listH).flex_none().overflow_y_scrollbar().border_b(1).border_color(t.border)
      .child(v_flex().p(4).children(files.map((f, i) => {
        const parts = f.path.split("/"), name = parts.pop(), n = threadsBy.get(f.path) ?? 0;
        return h_flex().id(`pf-${i}`).h(24).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer().text_size(12)
          .when(this.file === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.file = f.path; this.range = null; this.compose = null; cx.notify(); })
          .child(div().flex_none().max_w(200).truncate().when(f.status === "D", (e) => e.line_through()).child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
          .when(n > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.accent).child(`💬${n}`)))
          .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.additions}`))
          .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.deletions}`));
      })));
    const text = this.file ? this.diffs.get(this.file) : null;
    const placed = text != null ? placeThreads(text, (pr.threads ?? []).filter((th) => th.path === this.file), this.pending().filter((c) => c.path === this.file)) : null;
    const rows = placed?.rows ?? [];
    const range = this.range;
    const out = [];
    for (const [k, x] of (placed?.out ?? []).entries()) {
      if (x.kind === "thread") { out.push(this.threadCard(x.t, t, `${k}`)); continue; }
      if (x.kind === "pending") {
        const c = x.c;
        out.push(v_flex().id(`pc-${k}`).mx(8).my(4).p(8).gap(4).rounded(7).border_1().border_color(t.ansi3 + "90").bg(t.surface)
          .child(h_flex().gap(6).items_center().text_size(11).child(this.badge("pending", t.ansi3, t)).child(div().flex_1()).child(this.btn(`pc-del-${k}`, "Remove", (cx) => {
            this.setPending(this.pending().filter((p) => !(p.path === c.path && p.line === c.line && p.side === c.side && p.body === c.body))); cx.notify();
          }, t)))
          .child(div().text_size(12.5).whitespace_normal().child(c.body)));
        continue;
      }
      const i = x.i, picked = range && i >= range.from && i <= range.to;
      if (x.kind === "@") {
        out.push(div().id(`pd-${k}`).w_full().px(10).h(ROW + 2).flex().items_center().bg(t.raised).text_color(t.dim).truncate().child(x.text));
      } else {
        out.push(h_flex().id(`pd-${k}`).w_full().min_h(ROW).flex_none().gap(8).items_start().cursor_pointer()
          .when(x.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(x.kind === "-", (e) => e.bg(t.ansi1 + "18"))
          .when(Boolean(picked), (e) => e.bg(t.selection ?? t.selected))
          .on_click((ev, cx) => this.selectRow(i, Boolean(ev.modifiers?.shift), cx))
          .child(div().w(38).flex_none().text_right().text_color(t.dim).child(x.kind === "-" ? String(x.oldN ?? "") : x.newN == null ? "" : String(x.newN)))
          .child(div().w(10).flex_none().text_color(x.kind === "+" ? t.ansi2 : x.kind === "-" ? t.ansi1 : t.dim).child(x.kind === " " ? "" : x.kind))
          .child(this.line(x, t, `pd-${k}`)));
      }
      if (this.compose && range && i === range.to) {
        out.push(v_flex().id("pr-compose").mx(8).my(6).p(8).gap(6).rounded(7).border_1().border_color(t.accent).bg(t.surface)
          .on_click((_e, cx) => cx.stop_propagation())
          .child(div().text_size(11).text_color(t.dim).child(`${this.compose.side === "old" ? "old" : ""} line${this.compose.startLine === this.compose.line ? ` ${this.compose.line}` : `s ${this.compose.startLine}-${this.compose.line}`}`))
          .child(div().px(8).py(6).rounded(6).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.lineBox).w_full().text_size(12.5)))
          .child(h_flex().gap(6).flex_wrap()
            .child(this.btn("pc-cancel", "Cancel", (cx) => { this.compose = null; cx.notify(); }, t))
            .child(div().flex_1())
            .child(this.btn("pc-agent", "To agent", (cx) => this.finishCompose("agent", cx), t))
            .when(pr.state === "open", (e) => e
              .child(this.btn("pc-now", "Comment now", (cx) => this.finishCompose("now", cx), t))
              .child(this.btn("pc-add", "Add to review", (cx) => this.finishCompose("pending", cx), t, "solid")))));
      }
    }
    const loose = placed?.loose ?? [];
    const lines = range ? rows.slice(range.from, range.to + 1).filter((r) => r.kind !== "@").length : 0;
    const barH = range && !this.compose ? 38 : 0;
    return v_flex().w_full().h(bodyH).flex_none()
      .child(list)
      .child(div().id("pr-diff").w_full().h(Math.max(0, bodyH - listH - barH)).flex_none().overflow_y_scrollbar().font_family(mono).text_size(12)
        .child(v_flex().w_full()
          .when(!this.file, (e) => e.child(div().p(12).text_color(t.dim).child(files.length ? "Pick a file." : "No files.")))
          .when(Boolean(this.file) && text == null, (e) => e.child(div().p(12).text_color(t.dim).child(this.loadingDetail ? "Loading…" : "No text diff (binary, too large, or renamed only).")))
          .when(loose.length > 0, (e) => e.child(div().px(10).pt(8).text_size(11).text_color(t.dim).child("On lines no longer in this diff:")).children(loose.map((th, k) => this.threadCard(th, t, `loose-${k}`))))
          .children(out)))
      .when(Boolean(range) && !this.compose, (e) => e.child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(12).text_color(t.muted).child(`${lines} line${lines === 1 ? "" : "s"} · shift-click to extend`))
        .child(this.btn("pr-line-comment", "Comment", (cx) => this.startCompose(rows, cx), t, "solid"))));
  }

  checksView(pr, t, bodyH) {
    const checks = [...(pr.checkList ?? [])].sort((a, b) => ({ fail: 0, pending: 1, pass: 2, skip: 3 })[a.status] - ({ fail: 0, pending: 1, pass: 2, skip: 3 })[b.status]);
    const count = (s) => checks.filter((c) => c.status === s).length;
    const color = (s) => (s === "pass" ? t.ansi2 : s === "fail" ? t.ansi1 : s === "pending" ? t.ansi3 : t.dim);
    return v_flex().w_full().h(bodyH).flex_none()
      .child(h_flex().h(36).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().text_color(t.ansi1).child(`${count("fail")} failing`))
        .child(div().text_color(t.ansi3).child(`${count("pending")} running`))
        .child(div().text_color(t.ansi2).child(`${count("pass")} passed`))
        .child(div().flex_1())
        .when(count("fail") > 0 && pr.state === "open", (e) => e.child(this.btn("pr-rerun", "Re-run failed", (cx) => this.act("Re-run failed", () => rerunFailed(pr), cx, "Re-running failed checks"), t))))
      .child(div().id("pr-checks").w_full().h(Math.max(0, bodyH - 37)).flex_none().overflow_y_scrollbar()
        .child(v_flex().p(6)
          .when(!checks.length, (e) => e.child(div().p(8).text_color(t.dim).child("No checks.")))
          .children(checks.map((c, i) => h_flex().id(`ck-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(5).text_size(12)
            .when(Boolean(c.url), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openUrl(c.url)))
            .child(div().size(8).rounded(4).flex_none().bg(color(c.status)))
            .child(div().flex_1().min_w(0).truncate().child(c.name))
            .child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(c.group))))));
  }

  sheetView(pr, t) {
    if (this.sheet === "review") {
      const n = this.pending().length;
      const kind = (id, label, color) => div().id(`rv-k-${id}`).h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12)
        .border_1().border_color(this.event === id ? color : t.border).text_color(this.event === id ? color : t.muted)
        .on_click((_e, cx) => { this.event = id; cx.notify(); }).child(label);
      return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.surface)
        .child(h_flex().gap(6).flex_wrap()
          .child(kind("comment", "Comment", t.foreground))
          .child(kind("approve", "Approve", t.ansi2))
          .child(kind("changes", "Request changes", t.ansi1)))
        .child(div().px(8).py(6).rounded(6).border_1().border_color(t.input).bg(t.background).child(Textarea.new(this.reviewBox).w_full().text_size(12.5)))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child(n ? `with ${n} line comment${n === 1 ? "" : "s"}` : "Add line comments in Files first, or just a summary."))
          .child(this.btn("rv-cancel", "Cancel", (cx) => { this.sheet = null; cx.notify(); }, t))
          .child(this.btn("rv-submit", "Submit review", (cx) => this.submitReview(cx), t, "solid")));
    }
    if (this.sheet === "merge") {
      const how = (id, label) => div().id(`mg-${id}`).h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12)
        .border_1().border_color(this.method === id ? t.accent : t.border).text_color(this.method === id ? t.foreground : t.muted)
        .on_click((_e, cx) => { this.method = id; localStorage.setItem("ws-prs.method", id); cx.notify(); }).child(label);
      const blocked = pr.mergeable === "conflicting" || pr.mergeState === "dirty";
      const waiting = pr.checks === "pending" || pr.mergeState === "blocked" || pr.mergeState === "unstable";
      const note = blocked ? "It has conflicts with the base branch: resolve them first (Checkout, merge the base, push)."
        : pr.mergeState === "behind" ? "The branch is behind its base." : pr.mergeState === "blocked" ? "Branch protection blocks it now (reviews or checks)."
          : pr.checks === "fail" ? "Some checks fail." : pr.checks === "pending" ? "Checks are still running." : "Ready to merge.";
      return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.surface)
        .child(h_flex().gap(6).flex_wrap().child(how("squash", "Squash and merge")).child(how("merge", "Merge commit")).child(how("rebase", "Rebase and merge")))
        .child(h_flex().id("mg-del").gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted)
          .on_click((_e, cx) => { this.deleteBranch = !this.deleteBranch; localStorage.setItem("ws-prs.delete", this.deleteBranch ? "1" : "0"); cx.notify(); })
          .child(div().child(this.deleteBranch ? "☑" : "☐")).child(div().child(`Delete ${pr.head} after merging`)))
        .child(div().text_size(11.5).text_color(blocked ? t.ansi1 : t.dim).whitespace_normal().child(note))
        .child(h_flex().gap(6).justify_end()
          .child(this.btn("mg-cancel", "Cancel", (cx) => { this.sheet = null; cx.notify(); }, t))
          .when(waiting && !blocked, (e) => e.child(this.btn("mg-auto", "Merge when ready", (cx) => { this.sheet = null; this.act("Auto-merge", () => merge(pr, this.method, this.deleteBranch, true), cx, "Will merge when its checks pass"); }, t)))
          .child(this.btn("mg-go", "Merge", (cx) => { this.sheet = null; this.act("Merge", () => merge(pr, this.method, this.deleteBranch, false), cx, "Merged"); }, t, "solid", blocked)));
    }
    if (this.sheet === "more") {
      const item = (id, label, fn) => h_flex().id(`mo-${id}`).h(28).px(10).items_center().rounded(6).cursor_pointer().text_size(12.5)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.sheet = null; fn(cx); cx.notify(); }).child(label);
      return v_flex().flex_none().p(6).border_t(1).border_color(t.border).bg(t.surface)
        .child(item("agent-review", "Ask the agent to review it", (cx) => this.askReview(cx)))
        .child(item("agent-fix", "Unresolved threads to the agent", (cx) => this.fixThreads(cx)))
        .when(pr.state === "open", (e) => e.child(item("draft", pr.draft ? "Mark ready for review" : "Convert to draft", (cx) => this.act(pr.draft ? "Ready for review" : "Convert to draft", () => setDraft(pr, !pr.draft), cx))))
        .when(pr.state !== "merged", (e) => e.child(item("close", pr.state === "open" ? "Close" : "Reopen", (cx) => this.act(pr.state === "open" ? "Close" : "Reopen", () => setOpen(pr, pr.state !== "open"), cx))))
        .child(item("browser", "Open in browser", () => this.openUrl(pr.url)))
        .child(item("copy", "Copy link", () => this.copy(pr.url)));
    }
    return null;
  }

  footer(pr, t) {
    const n = this.pending().length, same = this.sameRepo();
    const toggle = (s, cx) => { this.sheet = this.sheet === s ? null : s; cx.notify(); };
    return h_flex().h(44).flex_none().px(10).gap(6).items_center().border_t(1).border_color(t.border)
      .when(pr.state === "open", (e) => e
        .child(this.btn("pr-review-btn", n ? `Review (${n})` : "Review", (cx) => toggle("review", cx), t, this.sheet === "review" ? "solid" : null))
        .child(this.btn("pr-merge-btn", "Merge", (cx) => toggle("merge", cx), t, this.sheet === "merge" ? "solid" : "ok")))
      .child(h_flex().id("pr-checkout-wrap").tooltip(same ? `Check out ${pr.head} in ${this.where.root}` : "Focus a terminal in a clone of this repository (on this computer) to check it out")
        .child(this.btn("pr-checkout", "Checkout", (cx) => this.act("Checkout", () => checkout(pr, this.where.root), cx, `Checked out ${pr.head}`), t, null, !same)))
      .child(div().flex_1())
      .child(this.btn("pr-more", "More…", (cx) => toggle("more", cx), t, this.sheet === "more" ? "solid" : null));
  }

  render(cx) {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const pr = this.pr;
    const root = v_flex().id("ws-prs").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12.5)
      .on_size_change((size, cx) => { this.height = size.height / (Number(settings().zoom) || 1); cx.notify(); });
    if (!pr) return root.child(this.listView(t));
    // Scroll areas get exact heights: what's left under the header, above the sheet and footer.
    const bodyH = Math.max(0, this.height - this.headH - (pr.files ? 44 : 0) - (this.sheet ? this.sheetH : 0) - 2);
    const body = this.detailError && !pr.files
      ? div().p(14).text_color(t.ansi1).whitespace_normal().child(this.detailError)
      : !pr.files ? div().p(14).text_color(t.dim).child("Loading…")
        : this.tab === "files" ? this.filesView(pr, t, mono, bodyH) : this.tab === "checks" ? this.checksView(pr, t, bodyH) : this.conversation(pr, t, bodyH);
    const inner = pr.files ? this.sheetView(pr, t) : null;
    const sheet = inner ? div().id("pr-sheet").w_full().flex_none()
      .on_size_change((size, cx) => { const h = size.height / (Number(settings().zoom) || 1); if (Math.abs(h - this.sheetH) > 0.5) { this.sheetH = h; cx.notify(); } })
      .child(inner) : null;
    if (!inner) this.sheetH = 0;
    return root.child(this.header(pr, t)).child(body).when(sheet !== null, (e) => e.child(sheet)).when(Boolean(pr.files), (e) => e.child(this.footer(pr, t)));
  }
}
