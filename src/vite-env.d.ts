/// <reference types="vite/client" />

// opencascade.js 1.1.1 ships no TypeScript types and a hand-written entry that
// imports the .wasm in a webpack-specific way. We bypass that entry and load the
// emscripten glue + wasm URL ourselves (see src/cad/occt.ts), so declare those
// two deep imports here. The kernel object is loosely typed as `any` — a typed
// facade lives in src/cad/occt.ts.
declare module "opencascade.js/dist/opencascade.wasm.js" {
  const initOpenCascade: (opts?: {
    locateFile?: (path: string, prefix: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }) => Promise<any>;
  export default initOpenCascade;
}

declare module "opencascade.js/dist/opencascade.wasm.wasm?url" {
  const url: string;
  export default url;
}
