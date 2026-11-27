// @ts-check
// Diff helpers shared by Changes (ws-review) and the Git graph: which words changed
// inside a changed line, and a diff's rows side by side. No host calls, so tests run
// it as is. Edit lib/, then scripts/sync-lib.sh.

/** Words, runs of spaces, and single punctuation marks. */
export function tokens(s) {
  return s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

// Past these, a line pair is shown without word marks (too slow, or too changed to help).
const MAX_TOKENS = 400;
const MAX_CHANGED = 0.7;

/**
 * The parts of `a` and `b` that differ, as segments [{ text, changed }] for each side,
 * or null when marking words wouldn't help (identical, mostly rewritten, or too long).
 * @returns {{ old: { text: string, changed: boolean }[], new: { text: string, changed: boolean }[] } | null}
 */
export function wordDiff(a, b) {
  if (a === b) return null;
  const x = tokens(a), y = tokens(b);
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) return null;
  // Common prefix and suffix first: most edits touch a few words in the middle.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf), ym = y.slice(pre, y.length - suf);
  // Longest common subsequence of the middles.
  const n = xm.length, m = ym.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = xm[i] === ym[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keepX = new Array(n).fill(false), keepY = new Array(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (xm[i] === ym[j]) { keepX[i++] = true; keepY[j++] = true; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  const side = (all, keep) => {
    const flags = [...new Array(pre).fill(true), ...keep, ...new Array(suf).fill(true)];
    const segs = [];
    all.forEach((tok, k) => {
      const changed = !flags[k];
      const last = segs[segs.length - 1];
      if (last && last.changed === changed) last.text += tok; else segs.push({ text: tok, changed });
    });
    return segs;
  };
  const o = side(x, keepX), nw = side(y, keepY);
  const share = (segs, len) => (len ? segs.filter((s) => s.changed).reduce((k, s) => k + s.text.length, 0) / len : 0);
  if (share(o, a.length) > MAX_CHANGED || share(nw, b.length) > MAX_CHANGED) return null;
  return { old: o, new: nw };
}

/**
 * Pairs each run of removed lines with the run of added lines right after it (first with
 * first, ...) and sets `words` on both rows of a pair: their segments, or nothing.
 * `kind(row)`: "-", "+" or anything else; `text(row)`: the line without its marker.
 */
export function markWords(rows, kind = (r) => r.kind, text = (r) => r.text) {
  for (let i = 0; i < rows.length;) {
    if (kind(rows[i]) !== "-") { i++; continue; }
    const minus = [];
    while (i < rows.length && kind(rows[i]) === "-") minus.push(rows[i++]);
    const plus = [];
    while (i < rows.length && kind(rows[i]) === "+") plus.push(rows[i++]);
    for (let k = 0; k < Math.min(minus.length, plus.length); k++) {
      const d = wordDiff(text(minus[k]), text(plus[k]));
      if (d) { minus[k].words = d.old; plus[k].words = d.new; }
    }
  }
  return rows;
}

/**
 * A parsed diff's rows (parseDiff's: { kind, text, oldN, newN }) side by side:
 * [{ head } | { left, right, li, ri }], `li`/`ri` being indexes into `rows` (or -1).
 * Removed lines face the added lines that replace them; context lines face themselves.
 */
export function sideBySide(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.kind === "@") { out.push({ head: r, i }); i++; continue; }
    if (r.kind === " ") { out.push({ left: r, right: r, li: i, ri: i }); i++; continue; }
    if (r.kind !== "-" && r.kind !== "+") { i++; continue; }
    const minus = [], plus = [];
    while (i < rows.length && rows[i].kind === "-") minus.push(i++);
    while (i < rows.length && rows[i].kind === "+") plus.push(i++);
    for (let k = 0; k < Math.max(minus.length, plus.length); k++) {
      const li = minus[k] ?? -1, ri = plus[k] ?? -1;
      out.push({ left: li >= 0 ? rows[li] : null, right: ri >= 0 ? rows[ri] : null, li, ri });
    }
  }
  return out;
}
