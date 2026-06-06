// M0 gate (headless portion): prove the embed/extract round-trip and that an
// annotated file is still a valid STEP whose geometry OCCT re-reads intact.
//
// The browser-only parts (rendering, click-to-pick) are verified manually in the
// app; everything else is checked here. Run with: node scripts/roundtrip.ts
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  emptyMetadata,
  embedMetadata,
  extractMetadata,
  type Metadata,
} from "../src/cad/metadata.ts";
import { getOC } from "./occt-node.mjs";

const logPath = fileURLToPath(new URL("./roundtrip.out.txt", import.meta.url));
writeFileSync(logPath, "");
const log = (...a: unknown[]) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  appendFileSync(logPath, line + "\n");
  console.log(line);
};

let failures = 0;
const check = (label: string, cond: boolean) => {
  log(cond ? "PASS" : "FAIL", label);
  if (!cond) failures++;
};

const samplePath = fileURLToPath(new URL("../samples/box.step", import.meta.url));
const original = readFileSync(samplePath, "utf8");

// 1. Build metadata and embed it.
const meta: Metadata = emptyMetadata();
meta.part.material = "6061-T6 Aluminum";
meta.part.finish = "Clear anodize, Type II";
meta.annotations.push({ id: "a-2", faceId: 2, text: "M6x1 tapped, 12 deep" });
const annotated = embedMetadata(original, meta);
writeFileSync(fileURLToPath(new URL("../samples/box.annotated.step", import.meta.url)), annotated);

// 2. Structural checks: still a STEP file.
check("starts with ISO-10303-21", annotated.startsWith("ISO-10303-21;"));
check("has HEADER", annotated.includes("HEADER;"));
check("has DATA section", annotated.includes("DATA;"));
check("contains our comment block", annotated.includes("HOLE-WARLOCK-V1"));
check("ends STEP cleanly", annotated.trimEnd().endsWith("END-ISO-10303-21;"));

// 3. Our reader recovers the metadata exactly.
const recovered = extractMetadata(annotated);
check("metadata recovered", recovered !== null);
check("material preserved", recovered?.part.material === "6061-T6 Aluminum");
check("finish preserved", recovered?.part.finish === "Clear anodize, Type II");
check("annotation preserved", recovered?.annotations[0]?.text === "M6x1 tapped, 12 deep");
check("annotation faceId preserved", recovered?.annotations[0]?.faceId === 2);

// 4. Idempotency: re-embedding replaces (does not duplicate) the block.
const twice = embedMetadata(annotated, meta);
const occurrences = twice.split("HOLE-WARLOCK-V1").length - 1;
check("re-embed does not duplicate block", occurrences === 1);

// 5. Geometry still valid: OCCT re-reads the annotated file with the same faces.
const oc = await getOC();
oc.FS.writeFile("/rt.step", new TextEncoder().encode(annotated));
const reader = new oc.STEPControl_Reader_1();
const status = reader.ReadFile("/rt.step");
check("OCCT read status == 1", (status?.value ?? status) === 1);
reader.TransferRoots();
const shape = reader.OneShape();
check("shape not null", !shape.IsNull());

let faceCount = 0;
const exp = new oc.TopExp_Explorer_2(
  shape,
  oc.TopAbs_ShapeEnum.TopAbs_FACE,
  oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
);
for (; exp.More(); exp.Next()) faceCount++;
check("annotated file still has 6 faces (geometry intact)", faceCount === 6);

log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
