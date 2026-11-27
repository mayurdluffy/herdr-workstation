// The pure parts of Changes and the Git graph: status and branch parsing, diffs,
// word marks, side by side, file order and tree, and the graph's lanes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wordDiff, markWords, sideBySide, tokens } from "../lib/diff-words.js";
import { parseStatus, parseBranch, parseDiff, sortFiles, treeRows } from "../mods/ws-review/main.js";
import { parseRefs, locate } from "../mods/ws-git-graph/main.js";
import { layoutLanes } from "../mods/ws-git-graph/lanes.js";

test("tokens split words, spaces and punctuation", () => {
  assert.deepEqual(tokens("foo(bar, 42)"), ["foo", "(", "bar", ",", " ", "42", ")"]);
});

test("wordDiff marks only the changed words", () => {
  const d = wordDiff("const total = price * qty;", "const total = price * quantity;");
  assert.ok(d);
  assert.deepEqual(d.old.filter((s) => s.changed).map((s) => s.text), ["qty"]);
  assert.deepEqual(d.new.filter((s) => s.changed).map((s) => s.text), ["quantity"]);
  assert.equal(d.old.map((s) => s.text).join(""), "const total = price * qty;");
});

test("wordDiff gives up on identical or rewritten lines", () => {
  assert.equal(wordDiff("same", "same"), null);
  assert.equal(wordDiff("alpha beta gamma", "one two three four"), null);
});

test("markWords pairs removed lines with the added lines after them", () => {
  const rows = [{ kind: " ", text: "a" }, { kind: "-", text: "let x = 1;" }, { kind: "-", text: "gone();" }, { kind: "+", text: "let x = 2;" }];
  markWords(rows);
  assert.ok(rows[1].words && rows[3].words);
  assert.equal(rows[2].words, undefined);
});

test("sideBySide faces removals with their replacements", () => {
  const d = parseDiff("@@ -1,3 +1,3 @@\n a\n-b\n-c\n+B\n d\n");
  const sbs = sideBySide(d.rows);
  assert.equal(sbs[0].head.kind, "@");
  assert.deepEqual(sbs.slice(1).map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [["a", "a"], ["b", "B"], ["c", null], ["d", "d"]]);
});

test("parseDiff numbers lines on both sides", () => {
  const d = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+more\n");
  assert.equal(d.header.length, 3);
  assert.deepEqual(d.rows.map((r) => [r.kind, r.oldN ?? null, r.newN ?? null]), [["@", null, null], [" ", 10, 10], ["-", 11, 11], ["+", null, 11], ["+", null, 12]]);
});

test("parseStatus and parseBranch read git status -z -b", () => {
  const out = "## main...origin/main [ahead 2, behind 1]\0 M a.txt\0A  b.txt\0?? c.txt\0UU d.txt\0D  e.txt\0";
  const files = parseStatus(out);
  assert.deepEqual(files.map((f) => [f.path, f.pending, f.accepted, f.fresh, f.conflict, f.deleted]), [
    ["a.txt", true, false, false, false, false],
    ["b.txt", false, true, false, false, false],
    ["c.txt", true, false, true, false, false],
    ["d.txt", true, true, false, true, false],
    ["e.txt", false, true, false, false, true],
  ]);
  assert.deepEqual(parseBranch(out), { branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
  assert.deepEqual(parseBranch("## No commits yet on dev\0"), { branch: "dev", upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseBranch("## feat...origin/feat [gone]\0"), { branch: "feat", upstream: null, ahead: 0, behind: 0 });
});

test("sortFiles and treeRows", () => {
  const files = [{ path: "src/b.js" }, { path: "a.md", fresh: true }, { path: "src/lib/x.js", deleted: true }];
  assert.deepEqual(sortFiles(files, "name").map((f) => f.path), ["a.md", "src/b.js", "src/lib/x.js"]);
  assert.deepEqual(sortFiles(files, "status").map((f) => f.path), ["a.md", "src/b.js", "src/lib/x.js"]);
  const rows = treeRows(files, "path", new Set(), "p");
  assert.deepEqual(rows.map((r) => (r.kind === "dir" ? `${r.name}/` : r.f.path)), ["src/", "lib/", "src/lib/x.js", "src/b.js", "a.md"]);
});

test("parseRefs and locate", () => {
  assert.deepEqual(parseRefs("HEAD -> main, origin/main, origin/HEAD, tag: v1", ["origin"]), [
    { name: "main", kind: "head" }, { name: "origin/main", kind: "remote" }, { name: "v1", kind: "tag" },
  ]);
  const lines = locate(["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +5,2 @@", " a", "+b"]);
  assert.deepEqual(lines.slice(4).map((l) => [l.file, l.line]), [["f", 5], ["f", 6]]);
});

test("layoutLanes gives every commit a lane", () => {
  const commits = [
    { hash: "m", parents: ["a", "b"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: [] },
  ];
  const lanes = layoutLanes(commits);
  assert.equal(lanes.rows.length, 3);
  assert.notEqual(lanes.rows[0].col, lanes.rows[1].col, "the merged branch has its own lane");
});

test("groupRefs folds a remote twin into its local branch, checked-out first", async () => {
  const { groupRefs } = await import("../mods/ws-git-graph/main.js");
  const refs = parseRefs("HEAD -> feat/x, origin/main, main, tag: v1, origin/other", ["origin"]);
  assert.deepEqual(groupRefs(refs).map((r) => [r.name, r.kind, r.remotes]), [
    ["feat/x", "head", []], ["main", "local", ["origin"]], ["origin/other", "remote", []], ["v1", "tag", []],
  ]);
});

test("matches finds commits by every word", async () => {
  const { matches } = await import("../mods/ws-git-graph/main.js");
  const rows = [
    { subject: "fix(graph): lanes", author: "Ann", hash: "abc123", refs: [] },
    { subject: "feat: turns", author: "Bob", hash: "def456", refs: [{ name: "main" }] },
  ];
  assert.deepEqual(matches(rows, "bob main").map((r) => r.hash), ["def456"]);
  assert.deepEqual(matches(rows, "ABC").map((r) => r.hash), ["abc123"]);
  assert.equal(matches(rows, "  ").length, 2);
});

test("refsChanged ignores objects, logs and locks", async () => {
  const { refsChanged } = await import("../mods/ws-git-graph/main.js");
  const dir = "/r/.git";
  assert.equal(refsChanged(["/r/.git/objects/ab/cdef", "/r/.git/index", "/r/.git/refs/heads/main.lock"], dir), false);
  assert.equal(refsChanged(["/r/.git/refs/heads/main"], dir), true);
  assert.equal(refsChanged(["/r/.git/HEAD"], dir), true);
  assert.equal(refsChanged(["/r/.git/worktrees/w/HEAD"], dir), true);
  assert.equal(refsChanged([dir], dir), true);
});

test("fullView: the whole file, with a hunk header where each -U3 hunk starts", async () => {
  const { fullView } = await import("../mods/ws-review/main.js");
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const after = [...lines]; after[1] = "LINE 2"; after.splice(15, 0, "inserted");
  const full = parseDiff(`@@ -1,20 +1,21 @@\n${lines.map((l, i) => {
    if (i === 1) return `-${l}\n+LINE 2`;
    if (i === 15) return `+inserted\n ${l}`;
    return ` ${l}`;
  }).join("\n")}\n`);
  const u3 = parseDiff("@@ -1,5 +1,5 @@\n line 1\n-line 2\n+LINE 2\n line 3\n line 4\n line 5\n@@ -13,6 +13,7 @@\n line 13\n line 14\n line 15\n+inserted\n line 16\n line 17\n line 18\n");
  const rows = fullView(full, u3.hunks);
  assert.equal(rows.filter((r) => r.kind !== "@").length, 22, "every line of the file, the removed one too");
  const heads = rows.map((r, i) => [r, i]).filter(([r]) => r.kind === "@");
  assert.deepEqual(heads.map(([r]) => r.hunk), [0, 1]);
  assert.equal(rows[heads[0][1] + 1].text, "line 1", "first hunk header right before line 1");
  assert.equal(rows[heads[1][1] + 1].text, "line 13", "second hunk header right before its first context line");
});
