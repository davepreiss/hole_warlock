// Browser loader for the opencascade.js WASM kernel.
//
// We import the emscripten glue and the .wasm asset URL directly (Vite resolves
// `?url` to a served asset) and point the kernel's locateFile at it. This avoids
// the package's bundled entry, which resolves the wasm in a webpack-specific way.
//
// The kernel is a ~63 MB WASM download, so this is lazy: getOC() is only called
// when the user first loads a STEP file, and the result is cached.
import initOpenCascade from "opencascade.js/dist/opencascade.wasm.js";
import wasmUrl from "opencascade.js/dist/opencascade.wasm.wasm?url";

// The OCCT API surface is large and untyped in this build; treat as `any`.
// All call sites are concentrated in src/cad/step.ts and were validated against
// OCCT 7.4 via scripts/probe*.mjs.
export type OC = any;

/** Rolling buffer of the kernel's stdout/stderr (OCCT diagnostics). */
export const ocMessages: string[] = [];

let _oc: Promise<OC> | null = null;

/** Load (once) and return the OpenCASCADE kernel. */
export function getOC(): Promise<OC> {
  if (!_oc) {
    _oc = initOpenCascade({
      locateFile: (path: string) => (path.endsWith(".wasm") ? wasmUrl : path),
      print: (s: string) => {
        ocMessages.push(s);
        // eslint-disable-next-line no-console
        console.log("[occt]", s);
      },
      printErr: (s: string) => {
        ocMessages.push(s);
        // eslint-disable-next-line no-console
        console.warn("[occt:err]", s);
      },
    } as any);
  }
  return _oc;
}
