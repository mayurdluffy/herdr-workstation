// @ts-check
// Source Control, as VS Code has it: the "…" menu with its submenus, the Commit
// button's drop-down, and how a commit is made. Shared by ws-review (the Changes
// panel, which runs every git request) and ws-git (the menus, and the dialogs
// that ask for a name, a branch or a yes). Edit lib/, then scripts/sync-lib.sh.
import { shared, setShared, openOverlay } from "herdr";

/** shared keys: a request for the panel to run, the Git Output log, list/tree and sort, the panel's claim. */
export const REQUEST = "ws.git.request";
export const LOG = "ws.git.log";
export const VIEW = "ws.git.view";
export const CLAIM = "ws.git.claimed";
/** The open menu: { which, open, at } (`at`: when a press outside closed it). */
export const MENU = "ws.git.menu";

/** Dialog widths, by what the action mostly shows; dialogs are as tall as their content, except the viewer. */
export const SIZES = { input: [500], pick: [600], confirm: [460], view: [900, 620] };

/** Opens ws-git's dialog for one action (`flow`: a menu item's id, or "ask" with `confirm` and `request`). */
export function openDialog(flow, ctx, size = "input", extra = {}) {
  const [width, height] = SIZES[size] ?? SIZES.input;
  openOverlay({ mod: "ws-git", kind: "dialog", width, ...(height ? { height } : {}), props: { mode: "dialog", flow, ctx, ...extra } });
}

export const ITEM_H = 26, SEP_H = 9, PAD = 5, MAIN_W = 214, SUB_W = 252, GAP = 2;

/**
 * What the panel knows when it opens a menu or a dialog.
 * @typedef {{ root: string | null, on: string | null, branch: string | null, upstream: string | null,
 *   ahead: number, behind: number, remotes: string[], staged: number, changes: number,
 *   message: string, view: { mode: string, sort: string }, rebasing?: boolean }} GitContext
 */

/**
 * One git run: argv after `git`, in `cwd` (default: the request's).
 * @typedef {string[] | { args: string[], cwd?: string, timeout?: number }} Step
 */

/**
 * What the panel runs, in order, stopping at the first failure.
 * `after`: clearMessage, setMessage (text), openSpace (a folder to offer as a space).
 * `onError`: a failure whose output matches `match` asks `confirm` and, on yes, runs `request`.
 * @typedef {{ title: string, cwd: string | null, on: string | null, steps: Step[],
 *   after?: { clearMessage?: boolean, setMessage?: string, openSpace?: string },
 *   onError?: { match: string, confirm: { title: string, detail: string, label: string }, request: Request }[] }} Request
 */

/** @param {Request} request */
export function post(request) {
  setShared(REQUEST, { ...request, at: Date.now(), id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` });
}

export function view() {
  const v = /** @type {any} */ (shared(VIEW)) ?? {};
  return { mode: v.mode === "tree" ? "tree" : "list", sort: ["name", "path", "status"].includes(v.sort) ? v.sort : "path" };
}

export function setView(change) {
  setShared(VIEW, { ...view(), ...change });
}

const S = null; // a separator

/** VS Code's "…" menu. An item: { id, label, sub?, checked?, disabled? }. @param {GitContext} ctx */
export function moreMenu(ctx) {
  const v = ctx.view, none = !ctx.root;
  const item = (id, label, extra = {}) => ({ id, label, disabled: none, ...extra });
  return [
    v.mode === "tree" ? { id: "view.list", label: "View as List" } : { id: "view.tree", label: "View as Tree" },
    S,
    { label: "View & Sort", sub: [
      { id: "view.list", label: "View as List", checked: v.mode !== "tree" },
      { id: "view.tree", label: "View as Tree", checked: v.mode === "tree" },
      S,
      { id: "sort.name", label: "Sort Changes by Name", checked: v.sort === "name" },
      { id: "sort.path", label: "Sort Changes by Path", checked: v.sort === "path" },
      { id: "sort.status", label: "Sort Changes by Status", checked: v.sort === "status" },
    ] },
    S,
    item("pull", "Pull"),
    item("push", "Push"),
    { id: "clone", label: "Clone" },
    item("checkout", "Checkout to..."),
    item("fetch", "Fetch"),
    S,
    { label: "Commit", disabled: none, sub: [
      item("commit", "Commit"),
      item("commit.staged", "Commit Staged"),
      item("commit.all", "Commit All"),
      item("commit.undo", "Undo Last Commit"),
      item("rebase.abort", "Abort Rebase", { disabled: none || !ctx.rebasing }),
      S,
      item("commit.amend", "Commit (Amend)"),
      item("commit.staged.amend", "Commit Staged (Amend)"),
      item("commit.all.amend", "Commit All (Amend)"),
      S,
      item("commit.signoff", "Commit (Signed Off)"),
      item("commit.staged.signoff", "Commit Staged (Signed Off)"),
      item("commit.all.signoff", "Commit All (Signed Off)"),
    ] },
    { label: "Changes", disabled: none, sub: [
      item("stage.all", "Stage All Changes"),
      item("unstage.all", "Unstage All Changes"),
      item("discard.all", "Discard All Changes"),
    ] },
    { label: "Pull, Push", disabled: none, sub: [
      item("sync", "Sync"),
      S,
      item("pull", "Pull"),
      item("pull.rebase", "Pull (Rebase)"),
      item("pull.from", "Pull from..."),
      S,
      item("push", "Push"),
      item("push.to", "Push to..."),
      S,
      item("fetch", "Fetch"),
      item("fetch.prune", "Fetch (Prune)"),
      item("fetch.all", "Fetch From All Remotes"),
    ] },
    { label: "Branch", disabled: none, sub: [
      item("merge", "Merge..."),
      item("rebase", "Rebase Branch..."),
      S,
      item("branch.create", "Create Branch..."),
      item("branch.createFrom", "Create Branch From..."),
      S,
      item("branch.rename", "Rename Branch..."),
      item("branch.delete", "Delete Branch..."),
      item("branch.deleteRemote", "Delete Remote Branch..."),
      S,
      item("branch.publish", "Publish Branch..."),
    ] },
    { label: "Remote", disabled: none, sub: [
      item("remote.add", "Add Remote..."),
      item("remote.remove", "Remove Remote"),
    ] },
    { label: "Stash", disabled: none, sub: [
      item("stash", "Stash"),
      item("stash.untracked", "Stash (Include Untracked)"),
      item("stash.staged", "Stash Staged"),
      S,
      item("stash.applyLatest", "Apply Latest Stash"),
      item("stash.apply", "Apply Stash..."),
      S,
      item("stash.popLatest", "Pop Latest Stash"),
      item("stash.pop", "Pop Stash..."),
      S,
      item("stash.drop", "Drop Stash..."),
      item("stash.dropAll", "Drop All Stashes..."),
      S,
      item("stash.view", "View Stash..."),
    ] },
    { label: "Tags", disabled: none, sub: [
      item("tag.create", "Create Tag..."),
      item("tag.delete", "Delete Tag..."),
      item("tag.deleteRemote", "Delete Remote Tag..."),
      S,
      item("tag.push", "Push Tags"),
    ] },
    S,
    { id: "output", label: "Show Git Output" },
  ];
}

/** The Commit button's drop-down. @param {GitContext} ctx */
export function commitMenu(ctx) {
  const none = !ctx.root;
  return [
    { id: "commit", label: "Commit", disabled: none },
    { id: "commit.amend", label: "Commit (Amend)", disabled: none },
    { id: "commit.push", label: "Commit & Push", disabled: none },
    { id: "commit.sync", label: "Commit & Sync", disabled: none },
  ];
}

export function columnHeight(items) {
  return PAD * 2 + items.reduce((h, it) => h + (it ? ITEM_H : SEP_H), 0);
}

/** The top of each item in its column. */
export function tops(items) {
  let y = PAD;
  return items.map((it) => { const at = y; y += it ? ITEM_H : SEP_H; return at; });
}

/** The popup that holds a menu and, beside it, whichever submenu is open. */
export function menuSize(items) {
  const at = tops(items);
  let height = columnHeight(items);
  items.forEach((it, i) => { if (it?.sub) height = Math.max(height, at[i] - PAD + columnHeight(it.sub)); });
  const subs = items.some((it) => it?.sub);
  return { width: MAIN_W + (subs ? GAP + SUB_W : 0), height };
}

/** Which commit a menu item means. */
export function commitOptions(id) {
  const m = /^commit(\.staged|\.all)?(\.amend|\.signoff|\.push|\.sync)?$/.exec(id);
  if (!m) return null;
  return {
    kind: m[1] === ".staged" ? "staged" : m[1] === ".all" ? "all" : "smart",
    amend: m[2] === ".amend",
    signoff: m[2] === ".signoff",
    then: m[2] === ".push" ? "push" : m[2] === ".sync" ? "sync" : null,
  };
}

/** Pushes the current branch: to its upstream, else publishes it. @param {GitContext} ctx */
export function pushSteps(ctx) {
  if (ctx.upstream) return [["push"]];
  if (!ctx.branch) throw new Error("Not on a branch (detached HEAD): check out a branch to push.");
  const remote = ctx.remotes.includes("origin") ? "origin" : ctx.remotes[0];
  if (!remote) throw new Error("This repository has no remote. Add one: … › Remote › Add Remote...");
  return [["push", "-u", remote, ctx.branch]];
}

/**
 * What a commit needs before it can run: `ask` lists what to ask first
 * ("message": there is none; "stageAll": nothing accepted, so commit everything?).
 * @param {GitContext} ctx
 * @param {{ kind: string, amend: boolean, signoff: boolean, then: string | null }} opts
 * @param {string} message
 * @param {{ stageAll?: boolean }} answers
 * @returns {{ error?: string, ask?: string, request?: Request }}
 */
export function planCommit(ctx, opts, message, answers = {}) {
  const text = message.trim();
  if (!opts.amend && !text) return { ask: "message" };
  let stage = opts.kind === "all";
  if (opts.kind === "staged" && !ctx.staged && !opts.amend) return { error: "There are no accepted (staged) changes to commit." };
  if (opts.kind === "smart" && !ctx.staged) {
    if (!ctx.changes && !opts.amend) return { error: "There are no changes to commit." };
    if (ctx.changes && !opts.amend && !answers.stageAll) return { ask: "stageAll" };
    if (ctx.changes && answers.stageAll) stage = true;
  }
  const commit = ["commit", ...(opts.amend ? ["--amend"] : []), ...(opts.signoff ? ["--signoff"] : []), ...(text ? ["-m", text] : ["--no-edit"])];
  /** @type {Step[]} */
  const steps = [...(stage ? [["add", "-A"]] : []), commit];
  try {
    if (opts.then === "push") steps.push(...pushSteps(ctx));
    if (opts.then === "sync") steps.push(...(ctx.upstream ? [["pull"]] : []), ...pushSteps(ctx));
  } catch (e) { return { error: String(e?.message ?? e) }; }
  const title = opts.then === "push" ? "Commit & Push" : opts.then === "sync" ? "Commit & Sync" : opts.amend ? "Commit (Amend)" : "Commit";
  return { request: { title, cwd: ctx.root, on: ctx.on, steps, after: { clearMessage: true } } };
}
