// A stand-in for Herdr's `herdr` module. exec runs real programs (so git logic can be
// tested against a scratch repository); shared state lives in memory; the rest records
// calls or returns empty values. Tests set what they need through `stub`.
import { execFile } from "node:child_process";

export const stub = {
  shared: new Map(),
  agents: [],
  panes: [],
  spaces: [],
  window: { platform: "macos", active: true, visible: true },
  calls: [],
  reset() { this.shared.clear(); this.agents = []; this.panes = []; this.spaces = []; this.calls = []; this.window = { platform: "macos", active: true, visible: true }; },
};
const record = (name) => (...args) => { stub.calls.push([name, ...args]); return null; };

export function exec(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, timeout: options.timeout ?? 30000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err && typeof err.code === "string") { reject(err); return; }
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
export const hc = (args) => exec("hc", args);
export const shared = (key) => stub.shared.get(key);
export const setShared = (key, value) => { stub.shared.set(key, value); return null; };
export const agents = () => stub.agents;
export const panes = () => stub.panes;
export const spaces = () => stub.spaces;
export const terminals = () => [];
export const machines = () => [];
export const focused = () => null;
export const layout = () => null;
export const window = () => stub.window;
export const theme = () => ({});
export const settings = () => ({});
export const props = () => ({});
export const updates = () => null;
export const home = () => process.env.HOME ?? "/";
export const appHome = () => `${process.env.HOME ?? ""}/.config/herdr-app`;
export const checking = () => true;
export const readTextFile = async () => null;
export const writeTextFile = async () => null;
export const watchFolder = () => Object.assign(new Promise(() => {}), { cancel() {} });
export const pickFiles = async () => null;
export const pickFolder = async () => null;
export const run = record("run");
export const notify = record("notify");
export const setBadge = record("setBadge");
export const playSound = record("playSound");
export const openOverlay = record("openOverlay");
export const closeOverlay = record("closeOverlay");
export const nextCommand = () => new Promise(() => {});
