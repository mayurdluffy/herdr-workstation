// @ts-check
// How a space and its tabs look, shared by ws-spaces (the sidebar) and ws-picker (Go to…):
// each space's blob, a tab's title and icon, its state. Edit lib/, then scripts/sync-lib.sh.
import { div, svg, image } from "gpui-kit";
import { shared } from "herdr";

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// Keep the whole leading emoji in the avatar (same rule in spaces and picker).
// Newer pictographs such as 🖥 may be drawn as emoji without VS16. A trailing
// selector, modifier or joiner can signal that we matched only part of a glyph.
export const EMOJI = /^(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|(?=[\u{1F000}-\u{1FFFF}])\p{Extended_Pictographic}|\p{Extended_Pictographic}(?=\uFE0F)|\p{Emoji_Modifier_Base}(?=\p{Emoji_Modifier}))\uFE0F?[\p{Emoji_Modifier}\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)(?![\p{Grapheme_Extend}\p{Emoji_Modifier}\u200D])/u;
export function spaceAvatar(name) {
  return EMOJI.exec(name)?.[0] ?? ([...name][0]?.toUpperCase() ?? "?");
}

// A space's color: its stored theme name or #rrggbb (shared "space.colors").
export function spaceFill(t, id) {
  const color = (/** @type {any} */ (shared("space.colors")) ?? {})[id] ?? "ansi6";
  return color.startsWith("#") ? color : (MARK[color] ?? t[color]);
}

// WS: each space's blob: a shape, kept by space id in shared "ws.space.shapes" and handed
// out like its color (the one fewest spaces have), drawn in its color with white eyes on top.
export const SHAPES = ["ball", "squircle", "tilt", "peak", "cloud", "pebble", "drop", "capsule"];
export const SHAPES_KEY = "ws.space.shapes";
export function blob(shape, color, size) {
  const icon = (part) => `mods/ws-spaces/icons/blob-${shape}${part}.svg`;
  return div().relative().size(size).flex_none()
    .child(svg(icon("")).size(size).text_color(color))
    .child(svg(icon("-eyes")).absolute().left(0).top(0).size(size).text_color("#ffffff"));
}

// WS: from the shipped agents mod: a tab's title (the agent's live title unless someone
// named the tab), the agent's icon, its state and how long it has been in it.
export const clean = (s) => (s ?? "").replace(/^(?:\[ [!.] \] |[✋⏳]\uFE0F?(?=\s)|(?!(?:\p{Emoji}\uFE0F|[#*]\u20E3))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "").trim();

export function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

export function tabTitle(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  if ((tab.name === prog || !tab.named) && telling) return live;
  // An automatic tab number says nothing: the program says more.
  return !tab.named && /^\d+$/.test(tab.name) && prog ? prog : tab.name;
}

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// compact: a ! for blocked where there's no room for "Needs you".
export function statusMark(t, status, compact = false) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done ?? t.dim);
  // Idle: a ring.
  return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
}

// A space's face: its emoji if its name starts with one, else its blob.
export function spaceFace(t, w, size) {
  if (EMOJI.test(w.name)) return div().size(size).flex_none().flex().items_center().justify_center().text_size(Math.round(size * 0.72)).child(spaceAvatar(w.name));
  return blob((/** @type {any} */ (shared(SHAPES_KEY)))?.[w.id] ?? SHAPES[0], spaceFill(t, w.id), size);
}
