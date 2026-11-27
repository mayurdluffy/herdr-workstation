// The activity watcher's decisions (badge, alerts) and the comment queue.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stub } from "./stubs/herdr.js";
import { nextAgent, alertFor, needsYou } from "../mods/ws-activity/main.js";
import { addComment, comments, send, updateComments, busy } from "../lib/comments.js";

beforeEach(() => stub.reset());

test("needsYou and nextAgent: a question first, then the longest-finished", () => {
  assert.equal(needsYou("working"), false);
  const list = [
    { address: "t1", status: "done", seq: 5 },
    { address: "t2", status: "working", seq: 1 },
    { address: "t3", status: "blocked", seq: 9 },
    { address: "t4", status: "done", seq: 2 },
  ];
  assert.equal(nextAgent(list).address, "t3");
  assert.equal(nextAgent(list.filter((a) => a.status !== "blocked")).address, "t4");
  assert.equal(nextAgent([{ address: "t9", status: "idle", seq: 1 }]), null);
});

test("alertFor: only real changes, never on first sight", () => {
  assert.equal(alertFor(undefined, "blocked"), null);
  assert.equal(alertFor("working", "blocked"), "blocked");
  assert.equal(alertFor("working", "done"), "done");
  assert.equal(alertFor("idle", "done"), null);
  assert.equal(alertFor("done", "idle"), null);
  assert.equal(alertFor("working", "idle"), "done", "finished on the shown tab while Herdr is behind");
  assert.equal(alertFor("blocked", "idle"), null);
});

test("comments to a busy agent are queued, to a gone one refused", async () => {
  assert.equal(busy("working") && busy("blocked") && !busy("idle"), true);
  stub.agents = [{ address: "t1", status: "working" }];
  const c = addComment({ agent: "t1", source: "file", where: "a.js:1", quote: "x", note: "fix" });
  assert.equal(await send("t1", [c]), "queued");
  assert.equal(comments()[0].queued, true);

  updateComments([c.id], { agent: "t2" });
  assert.match(await send("t2", comments()), /gone/);
  assert.equal(comments().length, 1, "nothing is dropped");
});
