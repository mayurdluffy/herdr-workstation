// A stand-in for `gpui-kit`: every element method chains and does nothing.
const element = () => new Proxy(function () {}, { get: (_t, key) => (key === "then" ? undefined : () => element()), apply: () => element() });
export const div = element;
export const svg = element;
export const image = element;
export class View {}
