// @ts-check
// The comment tray: one list, kept in shared state, read and written by every
// workstation mod. A comment belongs to the agent it will be sent to.
import { shared, setShared, agents, focused, exec } from "herdr";

const KEY = "ws.comments";

/**
 * `queued`: waiting for its agent to stop working (ws-activity sends it then).
 * @typedef {{ id: string, agent: string, source: string, where: string, quote: string, note: string, at: number, queued?: boolean }} Comment
 */

/** @returns {Comment[]} */
export function comments() {
  const list = shared(KEY);
  return Array.isArray(list) ? list : [];
}

/** @param {Comment[]} list */
function save(list) {
  setShared(KEY, list);
}

/** @param {Omit<Comment, "id" | "at">} c */
export function addComment(c) {
  const item = { ...c, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now() };
  save([...comments(), item]);
  return item;
}

export function removeComments(ids) {
  const drop = new Set(ids);
  save(comments().filter((c) => !drop.has(c.id)));
}

/** Changes some comments in place. @param {string[]} ids @param {Partial<Comment>} patch */
export function updateComments(ids, patch) {
  const pick = new Set(ids);
  save(comments().map((c) => (pick.has(c.id) ? { ...c, ...patch } : c)));
}

/** The agent's status, or null when its terminal is gone. */
export function agentStatus(address) {
  return agents().find((a) => a.address === address)?.status ?? null;
}

/** Working, or waiting on a question (a permission prompt): typing now would land in the middle. */
export const busy = (status) => status === "working" || status === "blocked";

/** The agent a comment made now goes to: the focused agent, else the agent in the focused tab. */
export function currentAgent() {
  const f = focused();
  const list = agents();
  return list.find((a) => a.address === f?.terminal)
    ?? list.filter((a) => a.tab === f?.tab).sort((a, b) => b.seq - a.seq)[0]
    ?? list.find((a) => a.focused)
    ?? null;
}

export function agentLabel(address) {
  const a = agents().find((x) => x.address === address);
  if (!a) return `${address} (gone)`;
  return `${a.program?.name ?? a.app ?? "agent"} · ${a.space_name} › ${a.tab_name} · ${a.address}`;
}

const quoteBlock = (text) => text.replace(/\s+$/, "").split("\n").map((l) => `> ${l}`).join("\n");

/** One message holding the comments, in the order they were made. @param {Comment[]} list */
export function format(list) {
  const head = list.length === 1 ? "Review comment:" : `Review comments (${list.length}):`;
  const body = list.map((c, i) => {
    const parts = [`${i + 1}. ${c.where}`];
    if (c.quote.trim()) parts.push(quoteBlock(c.quote));
    if (c.note.trim()) parts.push(c.note.trim());
    return parts.join("\n");
  });
  return `${head}\n\n${body.join("\n\n")}\n`;
}

/**
 * Sends comments to their agent as its next message. While the agent is busy they are
 * queued instead (unless `now`), and go when it stops. Resolves with null (sent),
 * "queued", or an error message.
 */
export async function send(agent, list, { now = false } = {}) {
  if (!list.length) return null;
  const status = agentStatus(agent);
  if (status === null) return "that agent is gone: Move the comments to another agent";
  if (!now && busy(status)) {
    updateComments(list.map((c) => c.id), { queued: true });
    return "queued";
  }
  const r = await exec("hc", ["send", agent, format(list)]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (r.code !== 0) return (r.stderr || r.stdout).trim() || "hc send failed";
  removeComments(list.map((c) => c.id));
  return null;
}
