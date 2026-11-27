// Maps the host modules Herdr provides ("herdr", "gpui-kit", "gpui-base") to stubs,
// so `node --test` can load mods and lib files. Used by `npm test`.
import { registerHooks } from "node:module";

const STUBS = { herdr: "./stubs/herdr.js", "gpui-kit": "./stubs/gpui-kit.js", "gpui-base": "./stubs/gpui-base.js" };
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  },
});
