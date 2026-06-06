// Enumerate the real exported symbol names + arities for the OCCT classes we
// need, then attempt a box -> STEP write. Output to scripts/probe.out.txt.
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const logPath = fileURLToPath(new URL("./probe.out.txt", import.meta.url));
writeFileSync(logPath, "");
const log = (...a) => appendFileSync(logPath, a.join(" ") + "\n");

const oc = await getOC();

// What variants actually exist?
const keys = Object.keys(oc);
for (const pat of ["MakeBox", "ProgressRange", "MakeCylinder", "STEPControl_Writer", "STEPControl_Reader"]) {
  const hits = keys.filter((k) => k.includes(pat)).sort();
  log(`matches /${pat}/:`, JSON.stringify(hits));
}

const tryStep = (label, fn) => {
  try {
    const r = fn();
    log("OK  ", label, "=>", r === undefined ? "(void)" : String(r).slice(0, 90));
    return r;
  } catch (e) {
    log("FAIL", label, "::", (e && e.message) || String(e));
    return undefined;
  }
};

// Box from 3 reals -> expect _1 per OCCT header order (dx,dy,dz first).
let box = tryStep("MakeBox_1(60,40,10)", () => new oc.BRepPrimAPI_MakeBox_1(60, 40, 10));
const shape = box && tryStep("box.Shape()", () => box.Shape());

// Progress range: find a usable constructor.
let progress;
if (typeof oc.Message_ProgressRange === "function") {
  progress = tryStep("new Message_ProgressRange()", () => new oc.Message_ProgressRange());
}

const writer = tryStep("new STEPControl_Writer_1()", () => new oc.STEPControl_Writer_1());
const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;

if (writer && shape) {
  // This build: Transfer(shape, mode, compound) — 3 args, no progress range.
  const ok = tryStep("Transfer(shape,mode,true)", () => writer.Transfer(shape, mode, true));
  log("  transfer status raw =", ok && ok.value !== undefined ? ok.value : String(ok));
  const ws = tryStep('Write("/box.step")', () => writer.Write("/box.step"));
  log("  write status raw =", ws && ws.value !== undefined ? ws.value : String(ws));
  const txt = tryStep("FS.readFile", () => oc.FS.readFile("/box.step", { encoding: "utf8" }));
  if (typeof txt === "string") {
    log("STEP length =", txt.length);
    log("HEAD:\n" + txt.split("\n").slice(0, 8).join("\n"));
    writeFileSync(fileURLToPath(new URL("../samples/box.step", import.meta.url)), txt);
    log("wrote samples/box.step");
  }
}
log("DONE");
