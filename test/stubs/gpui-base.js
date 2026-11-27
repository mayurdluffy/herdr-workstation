// A stand-in for `gpui-base`: elements chain and do nothing; states hold a value.
import { div } from "./gpui-kit.js";
const state = () => ({ value: () => "", set_value() {}, on() {}, focus() {}, blur() {}, release() {}, set_auto_grow() {} });
export const v_flex = div;
export const h_flex = div;
export const Input = { new: div };
export const Textarea = { new: div };
export const Editor = { new: div };
export const TextView = { html: div, markdown: div };
export const InputState = { new: state };
export const TextareaState = { new: state };
export const EditorState = { new: state };
export const ScrollHandle = { new: () => ({ scroll_to_item() {}, release() {} }) };
