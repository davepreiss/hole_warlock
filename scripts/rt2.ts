// Reproduce save/reopen against a real file. argv[2] = path to a .step file.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emptyMetadata, embedMetadata, extractMetadata } from "../src/cad/metadata.ts";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./rt2.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a: unknown[]) =>
  appendFileSync(out, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");

const path = process.argv[2];
const raw = readFileSync(path);
log("file:", path, "bytes:", raw.length);

// Non-ASCII byte audit (UTF-8 round-trip hazard in the browser save path).
let nonAscii = 0;
let firstNonAsciiAt = -1;
for (let i = 0; i < raw.length; i++) {
  if (raw[i] > 127) {
    nonAscii++;
    if (firstNonAsciiAt < 0) firstNonAsciiAt = i;
  }
}
log("non-ASCII bytes:", nonAscii, "firstAt:", firstNonAsciiAt);

// Simulate the *current* browser path: decode utf-8, embed, re-encode utf-8.
const asUtf8 = new TextDecoder("utf-8").decode(raw);
const meta = emptyMetadata();
meta.annotations.push({ id: "a-tap", faceId: 7, text: "M6x1 tapped, 12 deep" });
const annotatedUtf8 = embedMetadata(asUtf8, meta);
const reUtf8 = new TextEncoder().encode(annotatedUtf8);
log("utf8 path: orig", raw.length, "-> annotated bytes", reUtf8.length,
    "(delta vs +block ~)", reUtf8.length - raw.length);

// Simulate a byte-exact (latin1) path.
const asLatin1 = new TextDecoder("latin1").decode(raw);
const annotatedLatin1 = embedMetadata(asLatin1, meta);
const reLatin1 = new Uint8Array(annotatedLatin1.length);
for (let i = 0; i < annotatedLatin1.length; i++) reLatin1[i] = annotatedLatin1.charCodeAt(i) & 0xff;
log("latin1 path: annotated bytes", reLatin1.length);

// Does extract recover from each?
log("extract(utf8) ok:", extractMetadata(annotatedUtf8)?.annotations[0]?.text);
log("extract(latin1) ok:", extractMetadata(annotatedLatin1)?.annotations[0]?.text);

// Re-read both through OCCT; compare face counts to the original.
const oc = await getOC();
oc.STEPControl_Controller.Init();
function faceCount(bytes: Uint8Array, name: string): number {
  oc.FS.writeFile(name, bytes);
  const r = new oc.STEPControl_Reader_1();
  const st = r.ReadFile(name);
  const sval = (st as any)?.value ?? st;
  if (sval !== 1) {
    log("  OCCT read FAILED for", name, "status", sval);
    return -1;
  }
  r.TransferRoots();
  const shape = r.OneShape();
  let n = 0;
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) n++;
  return n;
}
log("faces original:", faceCount(new Uint8Array(raw), "orig.step"));
log("faces utf8-annotated:", faceCount(reUtf8, "utf8.step"));
log("faces latin1-annotated:", faceCount(reLatin1, "latin1.step"));
log("DONE");
