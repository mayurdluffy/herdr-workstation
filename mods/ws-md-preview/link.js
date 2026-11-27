// @ts-check
// Ctrl/Cmd-click a local Markdown path in a terminal: preview it beside that pane.
import { run } from "herdr";

/** @type {import("herdr").HandleLink} */
export function handleLink({ link, source }) {
  if (link.kind !== "file" || !link.path || source.machine) return "pass";
  run("pane.split", { direction: "right", mod: "ws-md-preview", ...(source.pane ? { pane: source.pane } : {}), props: { file: link.path } });
  return "handled";
}
