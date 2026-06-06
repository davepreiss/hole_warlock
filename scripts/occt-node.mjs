// Loads the opencascade.js WASM kernel under Node (no browser).
// Used by helper scripts (sample generation, round-trip smoke tests) so we can
// validate the exact OCCT API surface this build exposes before wiring it into
// the browser app.
//
// The opencascade.js 1.1.1 emscripten glue was generated for CommonJS/web and
// references the CJS globals `__dirname` / `require` unconditionally in its
// Node branch. Under ESM those are undefined, so we polyfill them on globalThis
// before importing the glue (bare identifiers resolve to globalThis when not
// lexically bound). We pass `wasmBinary` so the kernel never reads the .wasm
// from disk itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const wasmPath = fileURLToPath(
  new URL("../node_modules/opencascade.js/dist/opencascade.wasm.wasm", import.meta.url),
);

let _oc = null;
export async function getOC() {
  if (_oc) return _oc;
  globalThis.__dirname ??= dirname(fileURLToPath(import.meta.url));
  globalThis.__filename ??= fileURLToPath(import.meta.url);
  globalThis.require ??= createRequire(import.meta.url);

  const { default: factory } = await import("opencascade.js/dist/opencascade.wasm.js");
  const wasmBinary = readFileSync(wasmPath);
  _oc = await factory({ wasmBinary });
  return _oc;
}
