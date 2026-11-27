// @ts-check
// Lane layout for a commit graph, like VS Code's Git Graph. Pure: no Herdr calls.
//
// commits: newest first, each { hash, parents: string[] }.
// Returns:
//   rows:  [{ col, color }]: where each commit's dot sits, and its lane color
//   edges: [{ x1, y1, x2, y2, color }]: lines between rows (y in rows; y2 may be
//          rows.length for a parent older than the list, which runs off the bottom)
//   width: the most lanes open at once
// A branch keeps its color down its first-parent line; a fork or merge gets a new one.

export function layoutLanes(commits) {
  /** @type {({ hash: string, color: number } | null)[]} */
  let lanes = [];
  /** @type {Record<number, { x: number, color: number }[]>} where each open lane's line starts */
  let sources = {};
  let nextColor = 0, width = 0;
  const rows = [], edges = [];
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };

  for (let i = 0; i < commits.length; i++) {
    const { hash, parents } = commits[i];
    const waiting = [];
    lanes.forEach((l, j) => { if (l && l.hash === hash) waiting.push(j); });
    const col = waiting.length ? waiting[0] : free();
    const color = waiting.length ? /** @type {{color:number}} */ (lanes[col]).color : nextColor++;

    // Lines arriving at this row: each open lane runs down, and bends into this
    // commit if it was waiting for it.
    lanes.forEach((l, j) => {
      if (!l) return;
      const x2 = l.hash === hash ? col : j;
      for (const s of sources[j] ?? [{ x: j, color: l.color }]) edges.push({ x1: s.x, y1: i - 1, x2, y2: i, color: s.color });
    });
    for (const j of waiting) lanes[j] = null;
    rows.push({ col, color });

    // Lines leaving this row. Lanes passing by keep going straight down.
    /** @type {Record<number, { x: number, color: number }[]>} */
    const next = {};
    lanes.forEach((l, j) => { if (l) next[j] = [{ x: j, color: l.color }]; });
    parents.forEach((p, k) => {
      const existing = lanes.findIndex((l) => l && l.hash === p);
      if (k === 0 && existing > col) {
        // The first parent is claimed by a lane to the right: keep this (left) lane
        // straight and bend that one into it, so main-line history stays leftmost.
        lanes[col] = { hash: p, color };
        lanes[existing] = null;
        next[col] = [{ x: col, color }, ...(next[existing] ?? [])];
        delete next[existing];
        return;
      }
      if (existing >= 0) {
        // Another child already leads to this parent: join its lane.
        (next[existing] ??= []).push({ x: col, color: k === 0 ? color : /** @type {{color:number}} */ (lanes[existing]).color });
        return;
      }
      const lane = k === 0 ? col : free();
      const c = k === 0 ? color : nextColor++;
      lanes[lane] = { hash: p, color: c };
      next[lane] = [{ x: col, color: c }];
    });
    sources = next;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, col + 1, lanes.length);
  }
  // Parents older than the list: their lines run off the bottom.
  const n = commits.length;
  lanes.forEach((l, j) => {
    if (!l) return;
    for (const s of sources[j] ?? []) edges.push({ x1: s.x, y1: n - 1, x2: j, y2: n, color: s.color });
  });
  return { rows, edges, width };
}

/** The graph as one SVG, `rowH` px per row and `lane` px per lane, to draw behind the rows. */
export function graphSvg(layout, { rowH, lane, pad, palette, head }) {
  const x = (c) => pad + c * lane + lane / 2;
  const y = (r) => r * rowH + rowH / 2;
  const w = Math.max(1, pad * 2 + layout.width * lane), h = Math.max(1, layout.rows.length * rowH);
  const color = (i) => palette[i % palette.length];
  const parts = [];
  for (const e of layout.edges) {
    const x1 = x(e.x1), y1 = y(e.y1), x2 = x(e.x2), y2 = e.y2 >= layout.rows.length ? h : y(e.y2);
    const d = x1 === x2
      ? `M${x1} ${y1}L${x2} ${y2}`
      // Bend near the row where the line changes lane, as Git Graph does.
      : `M${x1} ${y1}C${x1} ${y1 + rowH * 0.75} ${x2} ${y1 + rowH * 0.25} ${x2} ${y1 + rowH}${y2 > y1 + rowH ? `L${x2} ${y2}` : ""}`;
    parts.push(`<path d="${d}" stroke="${color(e.color)}" stroke-width="2" fill="none"/>`);
  }
  layout.rows.forEach((r, i) => {
    const c = color(r.color);
    parts.push(i === head
      ? `<circle cx="${x(r.col)}" cy="${y(i)}" r="4.5" fill="${palette.background}" stroke="${c}" stroke-width="2"/>`
      : `<circle cx="${x(r.col)}" cy="${y(i)}" r="4" fill="${c}"/>`);
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`, width: w, height: h };
}
