// Placeholder until its build step lands.
import { View, div } from "gpui-kit";
import { theme } from "herdr";
export default class Soon extends View { render() { const t = theme(); return div().size_full().p(16).text_color(t.dim).child("Coming in the next build step."); } }
