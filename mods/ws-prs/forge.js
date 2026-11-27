// @ts-check
// Pull requests (GitHub, through `gh`) and merge requests (GitLab, through `glab api`), in one
// shape, so the PRs panel draws and acts on both alike. Reading turns the forges' JSON into:
//   PR      { forge, host, repo, number, title, author, draft, state: "open" | "closed" | "merged",
//             url, head, base, updatedAt, additions, deletions, review, checks, comments }
//   Detail  PR + { body, headSha, mergeable, mergeState, files, timeline, threads, checkList,
//             reviewers, diffRefs }
// `review`: "approved" | "changes" | "required" | null; `checks`: "pass" | "fail" | "pending" | null.
// The normalizers are pure (tests feed them recorded JSON); the rest runs gh / glab.
import { exec, appHome, writeTextFile } from "herdr";

// ---------- where a repository lives ----------

/** A git remote URL → { host, path, forge } (forge: "github" | "gitlab"), or null. */
export function parseRemote(url) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec((url ?? "").trim());
  if (!m) return null;
  const host = m[1].toLowerCase(), path = m[2].replace(/^\/+/, "");
  if (!path.includes("/")) return null;
  const forge = host === "github.com" || host.startsWith("github.") ? "github" : host.includes("gitlab") ? "gitlab" : "github";
  return { host, path, forge };
}

// ---------- shared helpers ----------

const lower = (s) => String(s ?? "").toLowerCase();

/** GitHub's statusCheckRollup / GitLab's pipeline status → "pass" | "fail" | "pending" | null. */
export function rollup(states) {
  if (!states.length) return null;
  if (states.some((s) => s === "fail")) return "fail";
  if (states.some((s) => s === "pending")) return "pending";
  return "pass";
}

/** One GitHub check (CheckRun or StatusContext) → { name, group, status, url, runId }. */
export function ghCheck(c) {
  const conclusion = lower(c.conclusion ?? c.state), status = lower(c.status);
  const done = c.__typename === "StatusContext" ? conclusion !== "pending" && conclusion !== "expected" : status === "completed";
  const st = !done ? "pending"
    : ["success", "neutral"].includes(conclusion) ? "pass"
      : ["skipped", "stale"].includes(conclusion) ? "skip"
        : "fail";
  const url = c.detailsUrl ?? c.targetUrl ?? null;
  const run = /\/actions\/runs\/(\d+)/.exec(url ?? "");
  return { name: c.name ?? c.context ?? "check", group: c.workflowName ?? "", status: st, url, runId: run ? run[1] : null };
}

const ghReview = (d) => ({ APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "required" })[d] ?? null;
const ghState = (s, merged) => (merged || s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "open");

/** A row of `gh pr list --json …` (or `gh search prs`) → PR. */
export function ghPR(p, host, repo) {
  const checks = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup.map(ghCheck).filter((c) => c.status !== "skip") : [];
  return {
    forge: "github", host, repo: repo ?? p.repository?.nameWithOwner ?? "", number: p.number, title: p.title ?? "",
    author: p.author?.login ?? "", draft: Boolean(p.isDraft), state: ghState(p.state, false), url: p.url ?? "",
    head: p.headRefName ?? "", base: p.baseRefName ?? "", updatedAt: Date.parse(p.updatedAt ?? "") || 0,
    additions: p.additions ?? null, deletions: p.deletions ?? null, review: ghReview(p.reviewDecision),
    checks: rollup(checks.map((c) => c.status)), comments: Array.isArray(p.comments) ? p.comments.length : (p.commentsCount ?? null),
  };
}

/** `gh pr view --json …` + review threads (GraphQL) → Detail. */
export function ghDetail(p, threads, host, repo) {
  const base = ghPR(p, host, repo);
  const checkList = (p.statusCheckRollup ?? []).map(ghCheck);
  const timeline = [
    ...(p.comments ?? []).map((c) => ({ kind: "comment", author: c.author?.login ?? "", body: c.body ?? "", at: Date.parse(c.createdAt ?? "") || 0 })),
    ...(p.reviews ?? []).filter((r) => r.body?.trim() || r.state !== "COMMENTED").map((r) => ({
      kind: "review", state: lower(r.state), author: r.author?.login ?? "", body: r.body ?? "", at: Date.parse(r.submittedAt ?? "") || 0,
    })),
  ].sort((a, b) => a.at - b.at);
  return {
    ...base, body: p.body ?? "", headSha: p.headRefOid ?? null, mergeable: lower(p.mergeable), mergeState: lower(p.mergeStateStatus),
    files: (p.files ?? []).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0, status: ({ ADDED: "A", DELETED: "D", RENAMED: "R" })[f.changeType] ?? "M" })),
    timeline, threads: threads ?? [], checkList,
    reviewers: (p.reviewRequests ?? []).map((r) => r.login ?? r.name ?? r.slug).filter(Boolean),
    diffRefs: null, createdAt: Date.parse(p.createdAt ?? "") || 0,
  };
}

/** GraphQL reviewThreads nodes → [{ id, path, line, side, resolved, outdated, comments: [{ id, author, body, at }] }]. */
export function ghThreads(nodes) {
  return (nodes ?? []).map((t) => ({
    id: t.id, path: t.path, line: t.line ?? t.originalLine ?? null, side: t.diffSide === "LEFT" ? "old" : "new",
    resolved: Boolean(t.isResolved), outdated: Boolean(t.isOutdated),
    comments: (t.comments?.nodes ?? []).map((c) => ({ id: c.id, author: c.author?.login ?? "", body: c.body ?? "", at: Date.parse(c.createdAt ?? "") || 0 })),
  }));
}

/** A multi-file unified diff (gh pr diff) → Map(path → that file's diff text). */
export function splitDiff(text) {
  const out = new Map();
  let path = null, lines = [];
  const flush = () => { if (path !== null) out.set(path, lines.join("\n")); };
  for (const line of (text ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      path = m ? m[2] : line.slice(11); lines = [line];
      continue;
    }
    if (path === null) continue;
    if (line.startsWith("+++ b/")) path = line.slice(6);
    lines.push(line);
  }
  flush();
  return out;
}

// GitLab

const glState = (s) => (s === "merged" ? "merged" : s === "closed" || s === "locked" ? "closed" : "open");
const glChecks = (s) => (!s ? null : s === "success" ? "pass" : ["failed", "canceled"].includes(s) ? "fail" : ["skipped", "manual"].includes(s) ? null : "pending");

/** A GitLab merge request (list or single) → PR. `repo`: its project path (lists across projects give references.full). */
export function glPR(m, host, repo) {
  const full = m.references?.full ?? "";
  return {
    forge: "gitlab", host, repo: repo ?? full.replace(/!\d+$/, ""), number: m.iid, title: m.title ?? "",
    author: m.author?.username ?? "", draft: Boolean(m.draft ?? m.work_in_progress), state: glState(m.state), url: m.web_url ?? "",
    head: m.source_branch ?? "", base: m.target_branch ?? "", updatedAt: Date.parse(m.updated_at ?? "") || 0,
    additions: null, deletions: null,
    review: m.approved === true ? "approved" : null,
    checks: glChecks(m.head_pipeline?.status ?? m.pipeline?.status), comments: m.user_notes_count ?? null,
  };
}

/** GitLab diffs (/diffs or /changes .changes) → { files, texts: Map(path → unified diff text) }. */
export function glDiffs(diffs) {
  const files = [], texts = new Map();
  for (const d of diffs ?? []) {
    const path = d.new_path ?? d.old_path;
    const status = d.new_file ? "A" : d.deleted_file ? "D" : d.renamed_file ? "R" : "M";
    const body = d.diff ?? "";
    let add = 0, del = 0;
    for (const l of body.split("\n")) { if (l.startsWith("+")) add++; else if (l.startsWith("-")) del++; }
    files.push({ path, additions: add, deletions: del, status });
    texts.set(path, `diff --git a/${d.old_path} b/${path}\n--- ${d.new_file ? "/dev/null" : `a/${d.old_path}`}\n+++ ${d.deleted_file ? "/dev/null" : `b/${path}`}\n${body}`);
  }
  return { files, texts };
}

/** GitLab discussions → threads (inline ones, with a position) and timeline items (the rest). */
export function glDiscussions(list) {
  const threads = [], timeline = [];
  for (const d of list ?? []) {
    const notes = (d.notes ?? []).filter((n) => !n.system);
    if (!notes.length) continue;
    const first = notes[0], pos = first.position;
    const comments = notes.map((n) => ({ id: n.id, author: n.author?.username ?? "", body: n.body ?? "", at: Date.parse(n.created_at ?? "") || 0 }));
    if (pos && (pos.new_path || pos.old_path)) {
      const old = pos.new_line == null && pos.old_line != null;
      threads.push({ id: d.id, path: old ? pos.old_path : pos.new_path, line: old ? pos.old_line : pos.new_line, side: old ? "old" : "new",
        resolved: Boolean(first.resolved), outdated: false, comments });
    } else for (const c of comments) timeline.push({ kind: "comment", ...c });
  }
  return { threads, timeline: timeline.sort((a, b) => a.at - b.at) };
}

// ---------- running gh and glab ----------

const run = (cmd, args, opts = {}) => exec(cmd, args, { timeout: 60000, ...opts })
  .catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));

/** Runs a command, parses its JSON; throws its error text on failure. */
async function json(cmd, args) {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new Error(explain(cmd, r));
  try { return JSON.parse(r.stdout || "null"); } catch { throw new Error(`${cmd}: unexpected output`); }
}
async function ok(cmd, args) {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new Error(explain(cmd, r));
  return r.stdout;
}
function explain(cmd, r) {
  const text = `${r.stderr}\n${r.stdout}`.trim();
  // Only a program that couldn't start is "not installed" (a 404's "Not Found" is not).
  if (r.code === 127 || /ENOENT|command not found/i.test(r.stderr)) return `${cmd} is not installed (${cmd === "gh" ? "brew install gh" : "brew install glab"}), then ${cmd} auth login.`;
  if (/auth login|not logged|authentication|401/i.test(text)) return `${cmd} isn't signed in: run ${cmd} auth login in a terminal.`;
  return text.split("\n").filter((l) => l.trim()).slice(-4).join("\n").slice(0, 400) || `${cmd} failed`;
}

/** A JSON request body as a file (gh api / glab api --input). */
async function bodyFile(obj) {
  const dir = `${appHome()}/data/ws-prs`;
  await run("mkdir", ["-p", dir]);
  const file = `${dir}/body-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.json`;
  await writeTextFile(file, JSON.stringify(obj), null);
  return file;
}
const drop = (file) => run("rm", ["-f", file]);

const GH_LIST = "number,title,author,isDraft,reviewDecision,statusCheckRollup,updatedAt,headRefName,baseRefName,url,additions,deletions,state";
const GH_SEARCH = "number,title,author,isDraft,updatedAt,url,state,repository,commentsCount";
const GH_VIEW = `${GH_LIST},body,mergeable,mergeStateStatus,changedFiles,files,reviews,comments,headRefOid,reviewRequests,createdAt`;
const THREADS = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine diffSide comments(first:50){nodes{id author{login} body createdAt}}}}}}}`;

const glProject = (repo) => `projects/${encodeURIComponent(repo)}`;
const glApi = (host, args) => ["api", "--hostname", host, ...args];

// ---------- the forge interface ----------

/**
 * PRs of a repository. `state`: "open" | "closed" (closed and merged).
 * @returns {Promise<any[]>}
 */
export async function listRepo(where, state) {
  const { forge, host, path } = where;
  if (forge === "github") {
    const rows = await json("gh", ["pr", "list", "-R", `${host}/${path}`, "--state", state === "open" ? "open" : "closed", "--limit", "50", "--json", GH_LIST]);
    return (rows ?? []).map((p) => ghPR(p, host, path));
  }
  const rows = await json("glab", glApi(host, [`${glProject(path)}/merge_requests?state=${state === "open" ? "opened" : "merged"}&per_page=50&order_by=updated_at`]));
  const more = state === "open" ? [] : await json("glab", glApi(host, [`${glProject(path)}/merge_requests?state=closed&per_page=30&order_by=updated_at`]));
  return [...(rows ?? []), ...(more ?? [])].map((m) => glPR(m, host, path)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** PRs across every repository: waiting on your review ("review") or yours ("mine"). */
export async function listMine(forge, host, scope, state) {
  if (forge === "github") {
    const who = scope === "review" ? "--review-requested=@me" : "--author=@me";
    const rows = await json("gh", ["search", "prs", who, `--state=${state === "open" ? "open" : "closed"}`, "--limit", "50", "--json", GH_SEARCH, ...(host !== "github.com" ? ["--hostname", host] : [])]);
    return (rows ?? []).map((p) => ghPR({ ...p, state: lower(p.state) === "closed" ? "CLOSED" : p.state?.toUpperCase?.() ?? p.state }, host, null));
  }
  const me = await json("glab", glApi(host, ["user"]));
  const who = scope === "review" ? `reviewer_username=${encodeURIComponent(me.username)}` : `author_username=${encodeURIComponent(me.username)}`;
  const rows = await json("glab", glApi(host, [`merge_requests?scope=all&${who}&state=${state === "open" ? "opened" : "merged"}&per_page=50`]));
  return (rows ?? []).map((m) => glPR(m, host, null));
}

/** Everything the PR's page shows, and each file's diff text (Map). */
export async function detail(pr) {
  const { forge, host, repo, number } = pr;
  if (forge === "github") {
    const [owner, name] = repo.split("/");
    const [view, graph, diff] = await Promise.all([
      json("gh", ["pr", "view", String(number), "-R", `${host}/${repo}`, "--json", GH_VIEW]),
      json("gh", ["api", ...(host !== "github.com" ? ["--hostname", host] : []), "graphql", "-f", `query=${THREADS}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${number}`]).catch(() => null),
      ok("gh", ["pr", "diff", String(number), "-R", `${host}/${repo}`]).catch(() => ""),
    ]);
    const nodes = graph?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    return { pr: ghDetail(view, ghThreads(nodes), host, repo), diffs: splitDiff(diff) };
  }
  const base = `${glProject(repo)}/merge_requests/${number}`;
  const [mr, diffs, discussions, approvals] = await Promise.all([
    json("glab", glApi(host, [base])),
    json("glab", glApi(host, [`${base}/diffs?per_page=100`])).catch(async () => (await json("glab", glApi(host, [`${base}/changes`])))?.changes ?? []),
    json("glab", glApi(host, [`${base}/discussions?per_page=100`])).catch(() => []),
    json("glab", glApi(host, [`${base}/approvals`])).catch(() => null),
  ]);
  const pipeline = mr.head_pipeline ?? null;
  const jobs = pipeline?.id ? await json("glab", glApi(host, [`${glProject(repo)}/pipelines/${pipeline.id}/jobs?per_page=100`])).catch(() => []) : [];
  const { files, texts } = glDiffs(diffs);
  const { threads, timeline } = glDiscussions(discussions);
  const approvedBy = (approvals?.approved_by ?? []).map((a) => a.user?.username).filter(Boolean);
  const pr2 = glPR({ ...mr, approved: approvedBy.length > 0 }, host, repo);
  const glJob = (j) => ({ name: j.name, group: j.stage ?? "", status: glChecks(j.status) ?? "skip", url: j.web_url ?? null, runId: String(pipeline?.id ?? "") });
  return {
    pr: {
      ...pr2, body: mr.description ?? "", headSha: mr.sha ?? mr.diff_refs?.head_sha ?? null,
      mergeable: mr.has_conflicts ? "conflicting" : "mergeable", mergeState: lower(mr.detailed_merge_status ?? mr.merge_status),
      files, threads, checkList: (jobs ?? []).map(glJob),
      timeline: [...timeline, ...approvedBy.map((u) => ({ kind: "review", state: "approved", author: u, body: "", at: Date.parse(approvals?.updated_at ?? "") || 0 }))].sort((a, b) => a.at - b.at),
      reviewers: (mr.reviewers ?? []).map((r) => r.username), diffRefs: mr.diff_refs ?? null, createdAt: Date.parse(mr.created_at ?? "") || 0,
      pipelineId: pipeline?.id ?? null,
    },
    diffs: texts,
  };
}

/** A conversation comment. */
export async function comment(pr, body) {
  if (pr.forge === "github") return ok("gh", ["pr", "comment", String(pr.number), "-R", `${pr.host}/${pr.repo}`, "--body", body]);
  const file = await bodyFile({ body });
  try { return await ok("glab", glApi(pr.host, ["-X", "POST", `${glProject(pr.repo)}/merge_requests/${pr.number}/notes`, "-H", "Content-Type: application/json", "--input", file])); }
  finally { await drop(file); }
}

/**
 * A review: `event` "approve" | "changes" | "comment", a body, and line comments
 * [{ path, side: "new" | "old", line, startLine?, body }].
 */
export async function review(pr, event, body, lines) {
  if (pr.forge === "github") {
    const side = (s) => (s === "old" ? "LEFT" : "RIGHT");
    const payload = {
      commit_id: pr.headSha ?? undefined, event: { approve: "APPROVE", changes: "REQUEST_CHANGES", comment: "COMMENT" }[event], body: body || undefined,
      comments: lines.map((c) => ({ path: c.path, body: c.body, line: c.line, side: side(c.side),
        ...(c.startLine && c.startLine !== c.line ? { start_line: c.startLine, start_side: side(c.side) } : {}) })),
    };
    const file = await bodyFile(payload);
    try { return await ok("gh", ["api", ...(pr.host !== "github.com" ? ["--hostname", pr.host] : []), "-X", "POST", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "--input", file]); }
    finally { await drop(file); }
  }
  // GitLab: each line comment is a discussion on the diff; the body a note; approve approves.
  const base = `${glProject(pr.repo)}/merge_requests/${pr.number}`;
  for (const c of lines) {
    const refs = pr.diffRefs ?? {};
    const position = { position_type: "text", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha,
      new_path: c.path, old_path: c.oldPath ?? c.path, ...(c.side === "old" ? { old_line: c.line } : { new_line: c.line, ...(c.oldLine ? { old_line: c.oldLine } : {}) }) };
    const file = await bodyFile({ body: c.body, position });
    try { await ok("glab", glApi(pr.host, ["-X", "POST", `${base}/discussions`, "-H", "Content-Type: application/json", "--input", file])); }
    finally { await drop(file); }
  }
  const note = event === "changes" && !body ? "Changes requested." : body;
  if (note) await comment(pr, event === "changes" ? `**Changes requested**\n\n${note}` : note);
  if (event === "approve") await ok("glab", glApi(pr.host, ["-X", "POST", `${base}/approve`]));
  return "";
}

/** A reply in a review thread. */
export async function reply(pr, thread, body) {
  if (pr.forge === "github") {
    const q = "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";
    return ok("gh", ["api", ...(pr.host !== "github.com" ? ["--hostname", pr.host] : []), "graphql", "-f", `query=${q}`, "-f", `id=${thread.id}`, "-f", `body=${body}`]);
  }
  const file = await bodyFile({ body });
  try { return await ok("glab", glApi(pr.host, ["-X", "POST", `${glProject(pr.repo)}/merge_requests/${pr.number}/discussions/${thread.id}/notes`, "-H", "Content-Type: application/json", "--input", file])); }
  finally { await drop(file); }
}

/** Resolves (or reopens) a review thread. */
export async function resolve(pr, thread, resolved) {
  if (pr.forge === "github") {
    const m = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const q = `mutation($id:ID!){${m}(input:{threadId:$id}){thread{id}}}`;
    return ok("gh", ["api", ...(pr.host !== "github.com" ? ["--hostname", pr.host] : []), "graphql", "-f", `query=${q}`, "-f", `id=${thread.id}`]);
  }
  return ok("glab", glApi(pr.host, ["-X", "PUT", `${glProject(pr.repo)}/merge_requests/${pr.number}/discussions/${thread.id}?resolved=${resolved}`]));
}

/** Merges: `method` "squash" | "merge" | "rebase"; `auto`: when its checks pass (GitHub). */
export async function merge(pr, method, deleteBranch, auto = false) {
  if (pr.forge === "github") {
    return ok("gh", ["pr", "merge", String(pr.number), "-R", `${pr.host}/${pr.repo}`, `--${method}`, ...(deleteBranch ? ["--delete-branch"] : []), ...(auto ? ["--auto"] : [])]);
  }
  const base = `${glProject(pr.repo)}/merge_requests/${pr.number}`;
  if (method === "rebase") await ok("glab", glApi(pr.host, ["-X", "PUT", `${base}/rebase`]));
  const q = [`squash=${method === "squash"}`, `should_remove_source_branch=${deleteBranch}`, ...(auto ? ["merge_when_pipeline_succeeds=true"] : [])].join("&");
  return ok("glab", glApi(pr.host, ["-X", "PUT", `${base}/merge?${q}`]));
}

/** Closes or reopens. */
export async function setOpen(pr, open) {
  if (pr.forge === "github") return ok("gh", ["pr", open ? "reopen" : "close", String(pr.number), "-R", `${pr.host}/${pr.repo}`]);
  return ok("glab", glApi(pr.host, ["-X", "PUT", `${glProject(pr.repo)}/merge_requests/${pr.number}?state_event=${open ? "reopen" : "close"}`]));
}

/** Marks ready for review, or back to draft. */
export async function setDraft(pr, draft) {
  if (pr.forge === "github") return ok("gh", ["pr", "ready", String(pr.number), "-R", `${pr.host}/${pr.repo}`, ...(draft ? ["--undo"] : [])]);
  const title = pr.title.replace(/^(?:\[?(?:draft|wip)\]?:?\s*)+/i, "");
  const file = await bodyFile({ title: draft ? `Draft: ${title}` : title });
  try { return await ok("glab", glApi(pr.host, ["-X", "PUT", `${glProject(pr.repo)}/merge_requests/${pr.number}`, "-H", "Content-Type: application/json", "--input", file])); }
  finally { await drop(file); }
}

/** Re-runs what failed: GitHub's failed workflow runs, GitLab's pipeline. */
export async function rerunFailed(pr) {
  if (pr.forge === "github") {
    const runs = [...new Set(pr.checkList.filter((c) => c.status === "fail" && c.runId).map((c) => c.runId))];
    if (!runs.length) throw new Error("No failed GitHub Actions runs to re-run.");
    for (const id of runs) await ok("gh", ["run", "rerun", id, "--failed", "-R", `${pr.host}/${pr.repo}`]);
    return `${runs.length}`;
  }
  if (!pr.pipelineId) throw new Error("This merge request has no pipeline.");
  return ok("glab", glApi(pr.host, ["-X", "POST", `${glProject(pr.repo)}/pipelines/${pr.pipelineId}/retry`]));
}

/** Checks the PR's branch out in `root` (a clone of its repository). */
export async function checkout(pr, root) {
  if (pr.forge === "github") {
    const r = await run("gh", ["pr", "checkout", String(pr.number), "-R", `${pr.host}/${pr.repo}`], { cwd: root });
    if (r.code !== 0) throw new Error(explain("gh", r));
    return r.stdout;
  }
  const branch = `mr/${pr.number}`;
  for (const args of [["fetch", "origin", `refs/merge-requests/${pr.number}/head:${branch}`, "--force"], ["checkout", branch]]) {
    const r = await run("git", args, { cwd: root });
    if (r.code !== 0) throw new Error(explain("git", r));
  }
  return branch;
}
