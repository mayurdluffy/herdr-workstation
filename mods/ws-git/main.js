// @ts-check
// Source Control menus and dialogs, as VS Code has them. Opened by the Changes panel:
//   { mode: "menu", menu: "more" | "commit", ctx, side }  a popup: the "…" menu with its
//     submenus (they open toward `side`), or the Commit button's drop-down;
//   { mode: "dialog", flow, ctx, ... }  the questions one action needs (a name, a branch,
//     a yes), then hands the git steps to the panel, which runs them (see lib/git-actions.js).
// A menu item that needs no answers is handed over straight from the menu.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, props, closeOverlay, theme, notify, settings, pickFolder, shared, setShared } from "herdr";
import {
  LOG, MENU, ITEM_H, SEP_H, PAD, MAIN_W, SUB_W, GAP, moreMenu, commitMenu, menuSize, tops, columnHeight,
  commitOptions, planCommit, pushSteps, post, setView, view, openDialog,
} from "./git-actions.js";

/** Thrown by a menu's stand-in for a dialog: this item has questions, open it as a dialog. */
class NeedDialog extends Error {}

// ---------- git reads ----------

function git(ctx, args, timeout = 60000) {
  return exec("env", ["GIT_TERMINAL_PROMPT=0", "git", "-c", "color.ui=never", ...args], { cwd: ctx.root ?? undefined, on: ctx.on, timeout });
}

async function out(ctx, args, timeout) {
  const r = await git(ctx, args, timeout);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
  return r.stdout;
}

const F = "%1f";
/** Branches and tags, newest first: { name, kind: "local" | "remote" | "tag", hash, subject }. */
async function refs(ctx) {
  const text = await out(ctx, ["for-each-ref", "--sort=-committerdate", `--format=%(refname)${F}%(refname:short)${F}%(objectname:short)${F}%(subject)`, "refs/heads", "refs/remotes", "refs/tags"]);
  return text.split("\n").filter(Boolean).map((line) => {
    const [full, name, hash, subject] = line.split("\x1f");
    const kind = full.startsWith("refs/heads/") ? "local" : full.startsWith("refs/tags/") ? "tag" : "remote";
    return { full, name, kind, hash, subject: subject ?? "" };
  }).filter((r) => !(r.kind === "remote" && r.full.endsWith("/HEAD")));
}

async function remotes(ctx) {
  const text = await out(ctx, ["remote", "-v"]);
  const seen = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const [name, url] = line.split(/\s+/);
    if (!seen.has(name)) seen.set(name, url);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

async function stashes(ctx) {
  const text = await out(ctx, ["stash", "list", "--format=%gd%x1f%s%x1f%cr"]);
  return text.split("\n").filter(Boolean).map((l) => { const [ref, subject, when] = l.split("\x1f"); return { ref, subject, when }; });
}

const KIND_ICON = { local: "branch", remote: "cloud", tag: "tag" };
const icon = (name) => `mods/ws-git/icons/${name}.svg`;
const refItem = (r) => ({ icon: KIND_ICON[r.kind], label: r.name, description: r.hash, detail: r.subject, value: r.name });

/** A branch or tag name as git takes it; VS Code turns spaces into dashes. */
function refName(text) { return text.trim().replace(/\s+/g, "-"); }
function badRef(name, what = "branch") {
  if (!name) return `Give the ${what} a name`;
  if (/[~^:?*[\\\x00-\x20\x7f]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(name)) return `"${name}" isn't a valid ${what} name`;
  return null;
}

function request(ctx, title, steps, extra = {}) {
  return { title, cwd: ctx.root, on: ctx.on, steps, ...extra };
}

async function pickRemote(ui, ctx, title) {
  const list = await remotes(ctx);
  if (!list.length) throw new Error("This repository has no remote. Add one: … › Remote › Add Remote...");
  if (list.length === 1) return list[0].name;
  return ui.pick({ title, placeholder: "Pick a remote", items: list.map((r) => ({ icon: "cloud", label: r.name, description: r.url, value: r.name })) });
}

function requireBranch(ctx) {
  if (!ctx.branch) throw new Error("Not on a branch (detached HEAD). Check out a branch first.");
  return ctx.branch;
}

// ---------- the actions: each asks what it needs, then returns the panel's request ----------

async function commitFlow(ui, ctx, opts) {
  let message = ctx.message ?? "";
  const answers = {};
  for (;;) {
    const plan = planCommit(ctx, opts, message, answers);
    if (plan.error) throw new Error(plan.error);
    if (plan.request) return plan.request;
    if (plan.ask === "message") {
      message = await ui.input({ title: "Commit", prompt: "Commit message", hint: ctx.branch ? `Commits on ${ctx.branch}` : "", ok: "Commit", validate: (v) => (v.trim() ? null : "Write a commit message") });
    } else if (plan.ask === "stageAll") {
      await ui.confirm({ title: "Commit all changes?", detail: `Nothing is accepted (staged) yet. Accept all ${ctx.changes} change${ctx.changes === 1 ? "" : "s"} and commit them directly?`, label: "Commit all" });
      answers.stageAll = true;
    }
  }
}

async function createBranch(ui, ctx, from) {
  const name = refName(await ui.input({ title: from ? `Create branch from ${from}` : "Create branch", prompt: "Branch name", ok: "Create", map: refName, validate: (v) => badRef(refName(v)) }));
  return request(ctx, "Create Branch", [["checkout", "-b", name, ...(from ? [from] : [])]]);
}

const stashFlow = (flag) => ({
  size: "input",
  async run(ui, ctx) {
    const msg = (await ui.input({ title: "Stash", prompt: "Stash message (optional)", ok: "Stash", allowEmpty: true })).trim();
    return request(ctx, "Stash", [["stash", "push", ...(flag ? [flag] : []), ...(msg ? ["-m", msg] : [])]]);
  },
});

const pickStash = (title, verb) => async (ui, ctx) => {
  const list = await stashes(ctx);
  if (!list.length) throw new Error("There are no stashes.");
  return ui.pick({ title, placeholder: `Pick a stash to ${verb}`, items: list.map((s) => ({ icon: "stash", label: s.ref, description: s.when, detail: s.subject, value: s.ref })) });
};

const simple = (title, ...steps) => ({ run: async (_ui, ctx) => request(ctx, title, steps) });

/** @type {Record<string, { size?: string, run: (ui: any, ctx: any, p?: any) => Promise<any> }>} */
const FLOWS = {
  pull: simple("Pull", ["pull"]),
  "pull.rebase": simple("Pull (Rebase)", ["pull", "--rebase"]),
  "pull.from": {
    size: "pick",
    async run(ui, ctx) {
      const remote = await pickRemote(ui, ctx, "Pull from");
      const branch = await ui.pick({
        title: `Pull from ${remote}`, placeholder: "Pick a branch to pull",
        load: async () => (await refs(ctx)).filter((r) => r.kind === "remote" && r.name.startsWith(`${remote}/`)).map(refItem),
      });
      return request(ctx, "Pull", [["pull", remote, branch.slice(remote.length + 1)]]);
    },
  },
  push: { run: async (_ui, ctx) => request(ctx, "Push", pushSteps(ctx)) },
  "push.to": {
    size: "pick",
    async run(ui, ctx) {
      const branch = requireBranch(ctx);
      const remote = await pickRemote(ui, ctx, "Push to");
      return request(ctx, "Push", [["push", ...(ctx.upstream ? [] : ["-u"]), remote, branch]]);
    },
  },
  sync: { run: async (_ui, ctx) => request(ctx, "Sync", [...(ctx.upstream ? [["pull"]] : []), ...pushSteps(ctx)]) },
  fetch: simple("Fetch", ["fetch"]),
  "fetch.prune": simple("Fetch (Prune)", ["fetch", "--prune"]),
  "fetch.all": simple("Fetch From All Remotes", ["fetch", "--all"]),
  clone: {
    size: "input",
    async run(ui, ctx) {
      const url = (await ui.input({ title: "Clone", prompt: "Repository URL", hint: "https://github.com/owner/repo.git or git@github.com:owner/repo.git", ok: "Choose folder…", validate: (v) => (v.trim() ? null : "Give a repository URL") })).trim();
      const parent = await ui.folder("Choose where to clone the repository");
      const name = url.replace(/[/\\]+$/, "").replace(/\.git$/, "").split(/[/:\\]/).pop() || "repository";
      return { title: "Clone", cwd: parent, on: null, steps: [{ args: ["clone", "--progress", url], cwd: parent, timeout: 600000 }], after: { openSpace: `${parent}/${name}` } };
    },
  },
  checkout: {
    size: "pick",
    async run(ui, ctx) {
      const pick = await ui.pick({
        title: "Checkout to", placeholder: "Select a branch or tag to checkout",
        load: async () => [
          { icon: "plus", label: "Create new branch...", value: { create: true } },
          { icon: "plus", label: "Create new branch from...", value: { createFrom: true } },
          { icon: "commit", label: "Checkout detached...", value: { detached: true } },
          ...(await refs(ctx)).filter((r) => !(r.kind === "local" && r.name === ctx.branch)).map((r) => ({ ...refItem(r), value: r })),
        ],
      });
      if (pick.create) return createBranch(ui, ctx, null);
      if (pick.createFrom) return FLOWS["branch.createFrom"].run(ui, ctx);
      if (pick.detached) {
        const ref = await ui.pick({ title: "Checkout detached", placeholder: "Select a branch or tag", load: async () => (await refs(ctx)).map(refItem) });
        return request(ctx, "Checkout", [["checkout", "--detach", ref]]);
      }
      if (pick.kind === "remote") {
        const local = pick.name.slice(pick.name.indexOf("/") + 1);
        const exists = (await refs(ctx)).some((r) => r.kind === "local" && r.name === local);
        return request(ctx, "Checkout", [exists ? ["checkout", local] : ["checkout", "--track", pick.name]]);
      }
      return request(ctx, "Checkout", [["checkout", pick.name]]);
    },
  },
  "commit.undo": {
    async run(_ui, ctx) {
      const message = (await out(ctx, ["log", "-1", "--format=%B"])).trim();
      const parent = await git(ctx, ["rev-parse", "--verify", "-q", "HEAD~1"]);
      return request(ctx, "Undo Last Commit", [parent.code === 0 ? ["reset", "--soft", "HEAD~1"] : ["update-ref", "-d", "HEAD"]], { after: { setMessage: message } });
    },
  },
  "rebase.abort": simple("Abort Rebase", ["rebase", "--abort"]),
  "stage.all": simple("Stage All Changes", ["add", "-A"]),
  "unstage.all": {
    async run(_ui, ctx) {
      const head = await git(ctx, ["rev-parse", "--verify", "-q", "HEAD"]);
      return request(ctx, "Unstage All Changes", [head.code === 0 ? ["reset", "-q"] : ["rm", "-r", "--cached", "-q", "."]]);
    },
  },
  "discard.all": {
    size: "confirm",
    async run(ui, ctx) {
      const tracked = (await out(ctx, ["diff", "--name-only"])).split("\n").filter(Boolean);
      const fresh = (await out(ctx, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
      if (!tracked.length && !fresh.length) throw new Error("There are no unstaged changes to discard.");
      const parts = [tracked.length && `restores ${tracked.length} changed file${tracked.length === 1 ? "" : "s"}`, fresh.length && `deletes ${fresh.length} new file${fresh.length === 1 ? "" : "s"}`].filter(Boolean);
      await ui.confirm({ title: "Discard all changes?", detail: `This ${parts.join(" and ")}. Staged changes stay. This can't be undone.`, label: "Discard All", danger: true });
      return request(ctx, "Discard All Changes", [...(tracked.length ? [["restore", "--worktree", "--", "."]] : []), ...(fresh.length ? [["clean", "-fd", "--", "."]] : [])]);
    },
  },
  merge: {
    size: "pick",
    async run(ui, ctx) {
      const ref = await ui.pick({ title: "Merge", placeholder: `Select a branch to merge into ${ctx.branch ?? "HEAD"}`, load: async () => (await refs(ctx)).filter((r) => r.kind !== "tag" && r.name !== ctx.branch).map(refItem) });
      return request(ctx, "Merge", [["merge", ref]]);
    },
  },
  rebase: {
    size: "pick",
    async run(ui, ctx) {
      const ref = await ui.pick({ title: "Rebase Branch", placeholder: `Select a branch to rebase ${ctx.branch ?? "HEAD"} onto`, load: async () => (await refs(ctx)).filter((r) => r.kind !== "tag" && r.name !== ctx.branch).map(refItem) });
      return request(ctx, "Rebase", [["rebase", ref]]);
    },
  },
  "branch.create": { size: "input", run: (ui, ctx) => createBranch(ui, ctx, null) },
  "branch.createFrom": {
    size: "pick",
    async run(ui, ctx) {
      const from = await ui.pick({ title: "Create Branch From", placeholder: "Select a ref to create the branch from", load: async () => (await refs(ctx)).map(refItem) });
      return createBranch(ui, ctx, from);
    },
  },
  "branch.rename": {
    size: "input",
    async run(ui, ctx) {
      const branch = requireBranch(ctx);
      const name = refName(await ui.input({ title: "Rename Branch", prompt: "New branch name", value: branch, ok: "Rename", validate: (v) => badRef(refName(v)) }));
      return request(ctx, "Rename Branch", [["branch", "-m", name]]);
    },
  },
  "branch.delete": {
    size: "pick",
    async run(ui, ctx) {
      const branch = await ui.pick({ title: "Delete Branch", placeholder: "Select a branch to delete", load: async () => (await refs(ctx)).filter((r) => r.kind === "local" && r.name !== ctx.branch).map(refItem) });
      const force = request(ctx, "Delete Branch", [["branch", "-D", branch]]);
      return request(ctx, "Delete Branch", [["branch", "-d", branch]], {
        onError: [{ match: "not fully merged", confirm: { title: "Delete unmerged branch?", detail: `The branch "${branch}" is not fully merged. Delete it anyway?`, label: "Delete Branch" }, request: force }],
      });
    },
  },
  "branch.deleteRemote": {
    size: "pick",
    async run(ui, ctx) {
      const ref = await ui.pick({ title: "Delete Remote Branch", placeholder: "Select a remote branch to delete", load: async () => (await refs(ctx)).filter((r) => r.kind === "remote").map(refItem) });
      const remote = ref.slice(0, ref.indexOf("/")), branch = ref.slice(ref.indexOf("/") + 1);
      await ui.confirm({ title: "Delete remote branch?", detail: `This deletes "${branch}" on ${remote} for everyone.`, label: "Delete", danger: true });
      return request(ctx, "Delete Remote Branch", [["push", remote, "--delete", branch]]);
    },
  },
  "branch.publish": {
    size: "pick",
    async run(ui, ctx) {
      const branch = requireBranch(ctx);
      const remote = await pickRemote(ui, ctx, `Publish ${branch} to`);
      return request(ctx, "Publish Branch", [["push", "-u", remote, branch]]);
    },
  },
  "remote.add": {
    size: "input",
    async run(ui, ctx) {
      const url = (await ui.input({ title: "Add Remote", prompt: "Remote URL", ok: "Next", validate: (v) => (v.trim() ? null : "Give the remote's URL") })).trim();
      const taken = (await remotes(ctx)).map((r) => r.name);
      const name = (await ui.input({ title: "Add Remote", prompt: "Remote name", value: taken.includes("origin") ? "" : "origin", ok: "Add Remote",
        validate: (v) => (!v.trim() ? "Give the remote a name" : taken.includes(v.trim()) ? `There is already a remote named ${v.trim()}` : badRef(v.trim(), "remote")) })).trim();
      return request(ctx, "Add Remote", [["remote", "add", name, url]]);
    },
  },
  "remote.remove": {
    size: "pick",
    async run(ui, ctx) {
      const list = await remotes(ctx);
      if (!list.length) throw new Error("This repository has no remotes.");
      const name = await ui.pick({ title: "Remove Remote", placeholder: "Pick a remote to remove", items: list.map((r) => ({ icon: "cloud", label: r.name, description: r.url, value: r.name })) });
      return request(ctx, "Remove Remote", [["remote", "remove", name]]);
    },
  },
  stash: stashFlow(null),
  "stash.untracked": stashFlow("--include-untracked"),
  "stash.staged": stashFlow("--staged"),
  "stash.applyLatest": simple("Apply Latest Stash", ["stash", "apply"]),
  "stash.popLatest": simple("Pop Latest Stash", ["stash", "pop"]),
  "stash.apply": { size: "pick", run: async (ui, ctx) => request(ctx, "Apply Stash", [["stash", "apply", await pickStash("Apply Stash", "apply")(ui, ctx)]]) },
  "stash.pop": { size: "pick", run: async (ui, ctx) => request(ctx, "Pop Stash", [["stash", "pop", await pickStash("Pop Stash", "pop")(ui, ctx)]]) },
  "stash.drop": {
    size: "pick",
    async run(ui, ctx) {
      const ref = await pickStash("Drop Stash", "drop")(ui, ctx);
      await ui.confirm({ title: "Drop stash?", detail: `This deletes ${ref} for good.`, label: "Drop", danger: true });
      return request(ctx, "Drop Stash", [["stash", "drop", ref]]);
    },
  },
  "stash.dropAll": {
    size: "confirm",
    async run(ui, ctx) {
      const n = (await stashes(ctx)).length;
      if (!n) throw new Error("There are no stashes.");
      await ui.confirm({ title: "Drop all stashes?", detail: `This deletes all ${n} stash${n === 1 ? "" : "es"} for good.`, label: "Drop All", danger: true });
      return request(ctx, "Drop All Stashes", [["stash", "clear"]]);
    },
  },
  "stash.view": {
    size: "view",
    async run(ui, ctx) {
      const ref = await pickStash("View Stash", "view")(ui, ctx);
      let r = await git(ctx, ["stash", "show", "-p", "--include-untracked", ref]);
      if (r.code !== 0) r = await git(ctx, ["stash", "show", "-p", ref]);
      await ui.view({ title: ref, text: r.code === 0 ? r.stdout : r.stderr, diff: true });
      return null;
    },
  },
  "tag.create": {
    size: "input",
    async run(ui, ctx) {
      const name = refName(await ui.input({ title: "Create Tag", prompt: "Tag name", ok: "Next", map: refName, validate: (v) => badRef(refName(v), "tag") }));
      const msg = (await ui.input({ title: `Create Tag ${name}`, prompt: "Message (optional: without one, a lightweight tag)", ok: "Create Tag", allowEmpty: true })).trim();
      return request(ctx, "Create Tag", [msg ? ["tag", "-a", name, "-m", msg] : ["tag", name]]);
    },
  },
  "tag.delete": {
    size: "pick",
    async run(ui, ctx) {
      const tag = await ui.pick({ title: "Delete Tag", placeholder: "Select a tag to delete", load: async () => (await refs(ctx)).filter((r) => r.kind === "tag").map(refItem) });
      return request(ctx, "Delete Tag", [["tag", "-d", tag]]);
    },
  },
  "tag.deleteRemote": {
    size: "pick",
    async run(ui, ctx) {
      const remote = await pickRemote(ui, ctx, "Delete a tag on");
      const tag = await ui.pick({
        title: `Delete Remote Tag on ${remote}`, placeholder: "Select a remote tag to delete",
        load: async () => (await out(ctx, ["ls-remote", "--tags", remote], 60000)).split("\n").filter((l) => l && !l.endsWith("^{}"))
          .map((l) => { const [hash, ref] = l.split(/\s+/); const name = ref.replace(/^refs\/tags\//, ""); return { icon: "tag", label: name, description: hash.slice(0, 7), value: name }; }),
      });
      await ui.confirm({ title: "Delete remote tag?", detail: `This deletes the tag "${tag}" on ${remote} for everyone.`, label: "Delete", danger: true });
      return request(ctx, "Delete Remote Tag", [["push", remote, "--delete", `refs/tags/${tag}`]]);
    },
  },
  "tag.push": simple("Push Tags", ["push", "--tags"]),
  output: { size: "view", async run(ui) { await ui.view({ title: "Git Output", output: true }); return null; } },
  // The panel asks before a request it was given can go on (a branch that isn't merged).
  ask: { size: "confirm", async run(ui, _ctx, p) { await ui.confirm(p.confirm); return p.request; } },
};

function flowFor(id) {
  const opts = commitOptions(id);
  if (opts) return { size: "input", run: (ui, ctx) => commitFlow(ui, ctx, opts) };
  return FLOWS[id] ?? null;
}

/** Opens the dialog that runs one action. */
function openFlow(id, ctx) { openDialog(id, ctx, flowFor(id)?.size ?? "input"); }

// ---------- the view ----------

export default class Git extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.ctx = p.ctx ?? {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (p.mode === "dialog") return this.initDialog(p, cx);
    this.main = -1; this.open = null; this.sub = -1; this.col = "main";
    // The button that opened this menu reads it: a press on it while open only closes it.
    setShared(MENU, { which: p.menu, open: true, at: 0 });
    this.rebasing = false;
    if (this.ctx.root) cx.spawn(async (cx) => {
      const r = await git(this.ctx, ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]).catch(() => null);
      const dirs = r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      for (const d of dirs) {
        const t = await exec("test", ["-d", d], { cwd: this.ctx.root, on: this.ctx.on }).catch(() => null);
        if (t?.code === 0) this.rebasing = true;
      }
      cx.notify();
    });
  }

  close() {
    if (props()?.mode !== "dialog") setShared(MENU, { which: props()?.menu, open: false, at: Date.now() });
    closeOverlay(props()?.overlay);
  }

  // ----- menu -----

  items() {
    const ctx = { ...this.ctx, rebasing: this.rebasing, view: view() };
    return props()?.menu === "commit" ? commitMenu(ctx) : moreMenu(ctx);
  }

  choose(item, cx) {
    if (!item?.id || item.disabled) return;
    const id = item.id;
    if (id.startsWith("view.")) { setView({ mode: id.slice(5) }); return this.close(); }
    if (id.startsWith("sort.")) { setView({ sort: id.slice(5) }); return this.close(); }
    const flow = flowFor(id);
    if (!flow) return this.close();
    const ctx = this.ctx;
    // Run it here; at its first question it becomes a dialog.
    const ask = () => { throw new NeedDialog(); };
    const ui = { input: ask, pick: ask, confirm: ask, view: ask, folder: ask };
    cx.spawn(async () => {
      try {
        const req = await flow.run(ui, ctx);
        if (req) post(req);
        this.close();
      } catch (e) {
        this.close();
        if (e instanceof NeedDialog) openFlow(id, ctx);
        else notify({ title: item.label.replace(/\.\.\.$/, ""), body: String(e?.message ?? e).slice(0, 300), level: "error" });
      }
    });
  }

  enabled(list, i) { return Boolean(list[i] && !list[i].disabled); }

  next(list, from, dir) {
    for (let k = 1; k <= list.length; k++) {
      const i = (from + dir * k + list.length * 2) % list.length;
      if (this.enabled(list, i)) return i;
    }
    return from;
  }

  menuKey(e, cx) {
    const items = this.items(), side = props()?.side ?? "left";
    const sub = this.open !== null ? items[this.open]?.sub ?? null : null;
    const k = e.key, toward = side === "left" ? "left" : "right", back = side === "left" ? "right" : "left";
    if (k === "escape") { if (this.col === "sub") { this.col = "main"; this.sub = -1; } else return this.close(); }
    else if (k === "down" || k === "up") {
      const dir = k === "down" ? 1 : -1;
      if (this.col === "sub" && sub) this.sub = this.next(sub, this.sub < 0 ? (dir > 0 ? -1 : 0) : this.sub, dir);
      else { this.main = this.next(items, this.main < 0 ? (dir > 0 ? -1 : 0) : this.main, dir); this.open = items[this.main]?.sub ? this.main : null; }
    } else if (k === toward || ((k === "enter" || k === " ") && this.col === "main" && items[this.main]?.sub)) {
      if (this.col === "main" && items[this.main]?.sub && !items[this.main].disabled) { this.open = this.main; this.col = "sub"; this.sub = this.next(items[this.main].sub, -1, 1); }
    } else if (k === back) { this.col = "main"; this.sub = -1; }
    else if (k === "enter" || k === " ") this.choose(this.col === "sub" && sub ? sub[this.sub] : items[this.main], cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  column(list, t, which, x, y) {
    const at = tops(list);
    return v_flex().id(`wsg-col-${which}`).absolute().left(x).top(y).w(which === "main" ? MAIN_W : SUB_W).h(columnHeight(list))
      .p(PAD).rounded(8).bg(t.popover).border_1().border_color(t.border).text_size(12.5).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(list.map((it, i) => {
        if (!it) return div().h(SEP_H).flex_none().flex().items_center().px(6).child(div().w_full().h(1).bg(t.border));
        const on = which === "main" ? (this.main === i || this.open === i) : this.sub === i;
        const off = Boolean(it.disabled);
        return h_flex().id(`wsg-${which}-${i}`).h(ITEM_H).flex_none().px(6).gap(4).items_center().rounded(5)
          .text_color(off ? t.dim : t.foreground)
          .when(on && !off, (e) => e.bg(t.selected))
          .when(!off, (e) => e.cursor_pointer())
          .on_hover((h, cx) => {
            if (!h) return;
            if (which === "main") { this.main = i; this.open = it.sub && !off ? i : null; this.col = "main"; this.sub = -1; }
            else { this.sub = i; this.col = "sub"; }
            cx.notify();
          })
          .on_click((_e, cx) => {
            if (it.sub) { if (!off) { this.open = i; this.main = i; cx.notify(); } }
            else this.choose(it, cx);
          })
          .child(div().w(14).flex_none().text_size(11).child(it.checked ? "✓" : ""))
          .child(div().flex_1().min_w(0).truncate().child(it.label))
          .when(Boolean(it.sub), (e) => e.child(div().flex_none().text_color(t.dim).child((props()?.side ?? "left") === "left" ? "‹" : "›")));
      }));
  }

  renderMenu() {
    const t = theme(), items = this.items(), side = props()?.side ?? "left";
    const size = menuSize(items), at = tops(items);
    const mainX = side === "left" ? size.width - MAIN_W : 0;
    const root = div().id("wsg-menu").relative().w(size.width).h(size.height)
      .track_focus(this.handle).on_key_down((e, cx) => this.menuKey(e, cx))
      .on_mouse_down("left", () => this.close())
      // A press outside closes the popup (Herdr does that); say so, so it isn't reopened by the same press.
      .on_mouse_down_out(() => setShared(MENU, { which: props()?.menu, open: false, at: Date.now() }))
      .child(this.column(items, t, "main", mainX, 0));
    const open = this.open !== null ? items[this.open] : null;
    if (!open?.sub) return root;
    const subH = columnHeight(open.sub);
    const y = Math.max(0, Math.min(at[this.open] - PAD, size.height - subH));
    const x = side === "left" ? mainX - GAP - SUB_W : MAIN_W + GAP;
    return root.child(this.column(open.sub, t, "sub", x, y));
  }

  // ----- dialog -----

  initDialog(p, cx) {
    this.step = null;           // { kind: "input" | "pick" | "confirm" | "view", ...options, resolve }
    this.note = "Loading…";
    this.input = InputState.new({});
    this.input.on("change", (_e, cx) => { if (this.step) this.step.error = null; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.at = 0;
    this.scroll = ScrollHandle.new();
    const flow = flowFor(p.flow);
    cx.spawn(async (cx) => {
      if (!flow) return this.close();
      try {
        const req = await flow.run(this.ui(cx), this.ctx, p);
        if (req) post(req);
        this.close();
      } catch (e) {
        this.close();
        notify({ title: "Source Control", body: String(e?.message ?? e).slice(0, 300), level: "error" });
      }
    });
  }

  ui(cx) {
    const ask = (kind) => (opts) => new Promise((resolve) => {
      this.step = { kind, ...opts, resolve, error: null };
      this.at = 0;
      if (kind === "input" || kind === "pick") {
        const value = kind === "input" ? opts.value ?? "" : "";
        this.input.set_value(value);
        if (value) this.input.set_selected_range({ start: 0, end: value.length });
        this.input.focus();
      } else { this.input.blur(); this.handle.focus(); }
      if (kind === "pick" && opts.load) {
        this.step.items = null;
        const step = this.step;
        cx.spawn(async (cx) => {
          try { step.items = await opts.load(); }
          catch (e) { step.items = []; step.error = String(e?.message ?? e); }
          cx.notify();
        });
      }
      cx.notify();
    });
    return {
      input: ask("input"), pick: ask("pick"), confirm: ask("confirm"), view: ask("view"),
      folder: async (prompt) => {
        this.step = null; this.note = "Choose a folder…"; cx.notify();
        const dir = await pickFolder({ prompt });
        if (!dir) throw new Error("No folder chosen.");
        this.note = "…"; cx.notify();
        return dir;
      },
    };
  }

  matches() {
    const s = this.step;
    if (s?.kind !== "pick" || !s.items) return [];
    const q = this.input.value().trim().toLowerCase();
    return q ? s.items.filter((it) => `${it.label} ${it.description ?? ""} ${it.detail ?? ""}`.toLowerCase().includes(q)) : s.items;
  }

  submit(_cx) {
    const s = this.step;
    if (!s) return;
    if (s.kind === "input") {
      const raw = this.input.value();
      const error = s.validate?.(raw) ?? (!s.allowEmpty && !raw.trim() ? "Required" : null);
      if (error) { s.error = error; return; }
      this.step = null; this.note = "…";
      s.resolve(raw);
    } else if (s.kind === "pick") {
      const it = this.matches()[this.at];
      if (!it) return;
      this.step = null; this.note = "…";
      s.resolve(it.value);
    } else if (s.kind === "confirm") {
      this.step = null; this.note = "…";
      s.resolve(true);
    } else if (s.kind === "view") this.close();
  }

  dialogKey(e, cx) {
    const s = this.step;
    if (e.key === "escape") return this.close();
    if (s?.kind === "pick" && (e.key === "down" || e.key === "up")) {
      const n = this.matches().length;
      if (n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      this.scroll.scroll_to_item(this.at);
    } else if (e.key === "enter" && (s?.kind === "confirm" || s?.kind === "view")) this.submit(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  button(id, label, primary, t, onClick, danger = false) {
    const bg = primary ? (danger ? t.ansi1 : t.solid) : t.raised;
    return h_flex().id(id).h(30).px(14).flex_none().items_center().rounded(7).border_1().border_color(primary ? bg : t.border).bg(bg)
      .text_color(primary ? (danger ? t.background : t.solid_foreground) : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
  }

  logLines() {
    const log = shared(LOG);
    const entries = Array.isArray(log) ? log : [];
    if (!entries.length) return ["No git commands have run yet."];
    return entries.flatMap((x) => {
      const d = new Date(x.at), two = (n) => String(n).padStart(2, "0");
      const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
      return [`${when} [${x.code === 0 ? "info" : "error"}] > git ${x.args} [${x.ms}ms]`, ...(x.out ? x.out.replace(/\n$/, "").split("\n") : [])];
    });
  }

  renderDialog() {
    const t = theme(), s = this.step, mono = settings().font_family ?? "JetBrains Mono";
    const viewing = s?.kind === "view";
    const subtitle = s?.kind === "pick" ? s.placeholder : s?.kind === "input" ? s.prompt : null;
    const header = h_flex().gap(12).items_start()
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14.5).font_semibold().truncate().child(s?.title ?? "Source Control"))
        .when(Boolean(subtitle), (e) => e.child(div().text_size(12).text_color(t.dim).child(subtitle))))
      .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("esc"));
    const field = (searching) => h_flex().h(34).px(10).gap(8).items_center().rounded(8).border_1().border_color(s?.error ? t.ansi1 : t.accent).bg(t.background)
      .when(searching, (e) => e.child(svg(icon("search")).size(14).flex_none().text_color(t.dim)))
      .child(Input.new(this.input).flex_1().min_w(0).text_size(13).text_color(t.foreground));
    const footer = (...buttons) => h_flex().pt(2).gap(8).justify_end().children(buttons);
    let body;
    if (!s) body = h_flex().gap(8).items_center().text_color(t.dim).child(div().child(this.note));
    else if (s.kind === "input") {
      body = v_flex().gap(8)
        .child(field(false))
        .when(Boolean(s.error || s.hint), (e) => e.child(div().text_size(11.5).text_color(s.error ? t.ansi1 : t.dim).child(s.error ?? s.hint)))
        .child(footer(this.button("wsg-cancel", "Cancel", false, t, () => this.close()), this.button("wsg-ok", s.ok ?? "OK", true, t, (cx) => this.submit(cx))));
    } else if (s.kind === "pick") {
      const list = this.matches();
      if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
      const empty = !s.items ? "Loading…" : !list.length ? (s.error ?? "No matches") : null;
      body = v_flex().gap(8)
        .child(field(true))
        .child(empty !== null
          ? div().px(10).py(8).text_size(12.5).text_color(s.error ? t.ansi1 : t.dim).child(empty)
          : div().id("wsg-list").max_h(320).overflow_y_scrollbar().track_scroll(this.scroll)
            .child(v_flex().w_full().children(list.map((it, i) => h_flex().id(`wsg-it-${i}`).h(32).flex_none().px(10).gap(9).items_center().rounded(7).cursor_pointer()
              .when(i === this.at, (e) => e.bg(t.selected)).when(i !== this.at, (e) => e.hover((st) => st.bg(t.hover)))
              .on_click((_e, cx) => { this.at = i; this.submit(cx); cx.notify(); })
              .when(Boolean(it.icon), (e) => e.child(svg(icon(it.icon)).size(14).flex_none().text_color(i === this.at ? t.foreground : t.muted)))
              .child(div().flex_none().max_w(280).truncate().text_size(12.8).child(it.label))
              .when(Boolean(it.description), (e) => e.child(div().flex_none().max_w(200).truncate().font_family(mono).text_size(11).text_color(t.dim).child(it.description)))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(it.detail ?? ""))))));
    } else if (s.kind === "confirm") {
      body = v_flex().gap(14)
        .child(div().text_size(12.8).line_height(1.5).text_color(t.muted).child(s.detail ?? ""))
        .child(footer(this.button("wsg-no", "Cancel", false, t, () => this.close()), this.button("wsg-yes", s.label ?? "OK", true, t, (cx) => this.submit(cx), Boolean(s.danger))));
    } else {
      const lines = s.output ? this.logLines() : (s.text ?? "").replace(/\n$/, "").split("\n");
      body = div().id("wsg-view").flex_1().min_h(0).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border).bg(t.background).p(10).font_family(mono).text_size(12)
        .child(v_flex().w_full().children(lines.slice(0, 5000).map((l, i) => {
          const k = s.diff ? (l.startsWith("+++") || l.startsWith("---") ? "f" : l[0]) : s.output && /\[error\]/.test(l) ? "-" : s.output && / > git /.test(l) ? "@" : "";
          return div().id(`wsg-l-${i}`).w_full().truncate()
            .when(k === "+", (e) => e.text_color(t.ansi2)).when(k === "-", (e) => e.text_color(t.ansi1))
            .when(k === "@", (e) => e.text_color(t.accent)).when(k === "f", (e) => e.font_semibold())
            .child(l || " ");
        })));
    }
    // Sized by its content, except the viewer, which fills its fixed size.
    return v_flex().id("wsg-dialog").track_focus(this.handle).on_key_down((e, cx) => this.dialogKey(e, cx))
      .w_full().when(viewing, (e) => e.h_full().min_h(0)).p(18).gap(14).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .child(header).child(body);
  }

  render(_cx) {
    return props()?.mode === "dialog" ? this.renderDialog() : this.renderMenu();
  }
}
