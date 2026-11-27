// The PRs panel's reading of GitHub (gh) and GitLab (glab api) JSON, and where its
// threads and line comments land in a diff. Fixtures follow the forges' real shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemote, ghPR, ghDetail, ghThreads, ghCheck, splitDiff, glPR, glDiffs, glDiscussions, rollup } from "../mods/ws-prs/forge.js";
import { placeThreads, lineTarget, ago } from "../mods/ws-prs/main.js";

test("parseRemote: GitHub, GitLab, ssh and https", () => {
  assert.deepEqual(parseRemote("https://github.com/mayurdluffy/herdr-workstation.git"), { host: "github.com", path: "mayurdluffy/herdr-workstation", forge: "github" });
  assert.deepEqual(parseRemote("git@github.com:cli/cli.git"), { host: "github.com", path: "cli/cli", forge: "github" });
  assert.deepEqual(parseRemote("git@gitlab.com:group/sub/project.git"), { host: "gitlab.com", path: "group/sub/project", forge: "gitlab" });
  assert.deepEqual(parseRemote("ssh://git@gitlab.example.com:2222/team/app"), { host: "gitlab.example.com", path: "team/app", forge: "gitlab" });
  assert.equal(parseRemote(""), null);
  assert.equal(parseRemote("/some/local/path"), null);
});

test("GitHub list row and checks", () => {
  const row = {
    number: 15178, title: "Report failures", author: { login: "babakks" }, isDraft: false, reviewDecision: "CHANGES_REQUESTED",
    state: "OPEN", url: "https://github.com/cli/cli/pull/15178", headRefName: "fix", baseRefName: "trunk", updatedAt: "2026-11-27T12:00:00Z",
    additions: 257, deletions: 34,
    statusCheckRollup: [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/cli/cli/actions/runs/1/job/2", workflowName: "CI" },
      { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://github.com/cli/cli/actions/runs/3/job/4", workflowName: "CI" },
      { __typename: "CheckRun", name: "label", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci.example.com/1" },
    ],
  };
  const pr = ghPR(row, "github.com", "cli/cli");
  assert.equal(pr.review, "changes");
  assert.equal(pr.checks, "pending", "a running check makes the rollup pending");
  assert.equal(pr.state, "open");
  assert.deepEqual(ghCheck(row.statusCheckRollup[0]), { name: "lint", group: "CI", status: "pass", url: row.statusCheckRollup[0].detailsUrl, runId: "1" });
  assert.equal(ghCheck({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "FAILURE" }).status, "fail");
  assert.equal(ghCheck(row.statusCheckRollup[3]).status, "pass");
  assert.equal(rollup([]), null);
  assert.equal(rollup(["pass", "fail", "pending"]), "fail");
});

test("GitHub detail: files, a timeline in time order, threads", () => {
  const view = {
    number: 7, title: "T", author: { login: "a" }, state: "MERGED", body: "desc", headRefOid: "abc", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    files: [{ path: "a.js", additions: 2, deletions: 1, changeType: "MODIFIED" }, { path: "b.js", additions: 5, deletions: 0, changeType: "ADDED" }],
    comments: [{ author: { login: "c" }, body: "later", createdAt: "2026-11-02T00:00:00Z" }],
    reviews: [
      { author: { login: "r" }, state: "APPROVED", body: "", submittedAt: "2026-11-01T00:00:00Z" },
      { author: { login: "q" }, state: "COMMENTED", body: "", submittedAt: "2026-11-01T01:00:00Z" },
    ],
    reviewRequests: [{ login: "tidy" }], statusCheckRollup: [],
  };
  const threads = ghThreads([{ id: "T1", path: "a.js", line: 3, diffSide: "RIGHT", isResolved: false, isOutdated: false,
    comments: { nodes: [{ id: "C1", author: { login: "r" }, body: "why?", createdAt: "2026-11-01T00:00:00Z" }] } },
  { id: "T2", path: "a.js", line: null, originalLine: 9, diffSide: "LEFT", isResolved: true, isOutdated: true, comments: { nodes: [] } }]);
  const d = ghDetail(view, threads, "github.com", "o/r");
  assert.equal(d.state, "merged");
  assert.deepEqual(d.files.map((f) => f.status), ["M", "A"]);
  assert.deepEqual(d.timeline.map((x) => x.author), ["r", "c"], "an empty COMMENTED review is left out; the rest in time order");
  assert.deepEqual(d.reviewers, ["tidy"]);
  assert.deepEqual(threads.map((t) => [t.line, t.side, t.resolved]), [[3, "new", false], [9, "old", true]]);
});

test("splitDiff: one text per file", () => {
  const text = "diff --git a/x.js b/x.js\nindex 1..2\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/dir/y.md b/dir/y.md\n--- a/dir/y.md\n+++ b/dir/y.md\n@@ -0,0 +1 @@\n+new\n";
  const m = splitDiff(text);
  assert.deepEqual([...m.keys()], ["x.js", "dir/y.md"]);
  assert.match(m.get("x.js"), /^diff --git[\s\S]*\+b$/);
});

test("GitLab: merge request, diffs and discussions", () => {
  const pr = glPR({ iid: 12, title: "Draft: thing", author: { username: "dev" }, draft: true, state: "opened", web_url: "u", source_branch: "f", target_branch: "main",
    updated_at: "2026-11-01T00:00:00Z", head_pipeline: { status: "failed" }, user_notes_count: 3 }, "gitlab.com", "g/p");
  assert.deepEqual([pr.number, pr.draft, pr.state, pr.checks, pr.comments, pr.forge], [12, true, "open", "fail", 3, "gitlab"]);
  assert.equal(glPR({ iid: 1, state: "merged", references: { full: "g/p!1" } }, "gitlab.com", null).repo, "g/p");

  const { files, texts } = glDiffs([
    { old_path: "a.rb", new_path: "a.rb", diff: "@@ -1,2 +1,2 @@\n-x\n+y\n z\n", new_file: false, deleted_file: false, renamed_file: false },
    { old_path: "n.rb", new_path: "n.rb", diff: "@@ -0,0 +1 @@\n+n\n", new_file: true },
  ]);
  assert.deepEqual(files, [{ path: "a.rb", additions: 1, deletions: 1, status: "M" }, { path: "n.rb", additions: 1, deletions: 0, status: "A" }]);
  assert.match(texts.get("n.rb"), /^diff --git a\/n.rb b\/n.rb\n--- \/dev\/null\n\+\+\+ b\/n.rb\n@@/);

  const { threads, timeline } = glDiscussions([
    { id: "d1", notes: [{ id: 1, body: "inline", author: { username: "r" }, created_at: "2026-11-01T00:00:00Z", resolved: false,
      position: { new_path: "a.rb", old_path: "a.rb", new_line: 1, old_line: null } }] },
    { id: "d2", notes: [{ id: 2, body: "on old", author: { username: "r" }, created_at: "2026-11-01T00:00:00Z", resolved: true,
      position: { new_path: "a.rb", old_path: "a.rb", new_line: null, old_line: 1 } }] },
    { id: "d3", notes: [{ id: 3, body: "general", author: { username: "s" }, created_at: "2026-11-02T00:00:00Z" }] },
    { id: "d4", notes: [{ id: 4, body: "assigned to @x", system: true, author: { username: "s" } }] },
  ]);
  assert.deepEqual(threads.map((t) => [t.id, t.line, t.side, t.resolved]), [["d1", 1, "new", false], ["d2", 1, "old", true]]);
  assert.deepEqual(timeline.map((x) => x.body), ["general"], "system notes are left out");
});

test("placeThreads: threads and waiting comments under their lines", () => {
  const text = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
  const threads = [{ id: "n", path: "a", line: 2, side: "new" }, { id: "o", path: "a", line: 2, side: "old" }, { id: "gone", path: "a", line: 99, side: "new" }];
  const pending = [{ path: "a", line: 3, side: "new", body: "p" }];
  const { out, loose } = placeThreads(text, threads, pending);
  const seq = out.map((x) => (x.kind === "thread" ? `T:${x.t.id}` : x.kind === "pending" ? "P" : `${x.kind}${x.text ?? ""}`));
  assert.deepEqual(seq, ["@@@ -1,3 +1,3 @@", " one", "-two", "T:o", "+TWO", "T:n", " three", "P"]);
  assert.deepEqual(loose.map((t) => t.id), ["gone"]);
});

test("lineTarget: which side and lines a selection comments on", () => {
  const r = (kind, oldN, newN) => ({ kind, oldN, newN, text: "" });
  assert.deepEqual(lineTarget([r("-", 4, 4), r("-", 5, 4)]), { side: "old", line: 5, startLine: 4, oldLine: null });
  assert.deepEqual(lineTarget([r("-", 4, 4), r("+", undefined, 4), r(" ", 5, 5)]), { side: "new", line: 5, startLine: 4, oldLine: 5 });
  assert.equal(lineTarget([{ kind: "@", text: "@@" }]), null);
});

test("ago", () => {
  const now = Date.parse("2026-11-28T12:00:00Z");
  assert.equal(ago(now - 30000, now), "now");
  assert.equal(ago(now - 5 * 60000, now), "5m");
  assert.equal(ago(now - 3 * 3600000, now), "3h");
  assert.equal(ago(now - 2 * 86400000, now), "2d");
});
