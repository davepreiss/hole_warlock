// Check: is STEPControl_Controller.Init() callable, and does OCCT print anything
// while reading box.step (baseline for the browser message capture)?
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const out = fileURLToPath(new URL("./probe3.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a) => appendFileSync(out, a.map(String).join(" ") + "\n");

globalThis.__dirname ??= dirname(fileURLToPath(import.meta.url));
globalThis.__filename ??= fileURLToPath(import.meta.url);
globalThis.require ??= createRequire(import.meta.url);

const { default: factory } = await import("opencascade.js/dist/opencascade.wasm.js");
const wasmBinary = readFileSync(
  fileURLToPath(new URL("../node_modules/opencascade.js/dist/opencascade.wasm.wasm", import.meta.url)),
);

const msgs = [];
const oc = await factory({
  wasmBinary,
  print: (s) => msgs.push("OUT " + s),
  printErr: (s) => msgs.push("ERR " + s),
});

log("typeof STEPControl_Controller =", typeof oc.STEPControl_Controller);
log("typeof STEPControl_Controller.Init =", typeof oc.STEPControl_Controller?.Init);
try {
  const r = oc.STEPControl_Controller.Init();
  log("Init() returned:", String(r));
} catch (e) {
  log("Init() threw:", e?.message || String(e));
}

const bytes = readFileSync(fileURLToPath(new URL("../samples/box.step", import.meta.url)));
oc.FS.writeFile("model.step", new Uint8Array(bytes));
const reader = new oc.STEPControl_Reader_1();
const status = reader.ReadFile("model.step");
log("ReadFile('model.step') status =", status?.value ?? status);

log("OCCT messages during read:", msgs.length);
for (const m of msgs.slice(0, 20)) log("  ", m);
log("DONE");
