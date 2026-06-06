// Diagnose why a specific STEP file fails to load. Pass the path as argv[2].
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./diagfile.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a) => {
  const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  appendFileSync(out, s + "\n");
};

const path = process.argv[2];
log("FILE:", path);
const bytes = readFileSync(path);
log("size bytes:", bytes.length);
log("first byte values:", [...bytes.slice(0, 4)].join(","));

const text = bytes.toString("latin1");
// Header lines of interest.
for (const key of ["ISO-10303-21", "FILE_SCHEMA", "FILE_DESCRIPTION", "FILE_NAME"]) {
  const idx = text.indexOf(key);
  if (idx >= 0) log(key, "=>", text.slice(idx, text.indexOf(";", idx) + 1).replace(/\s+/g, " ").slice(0, 200));
}

const oc = await getOC();
oc.FS.writeFile("/diag.step", new Uint8Array(bytes));
const reader = new oc.STEPControl_Reader_1();
const status = reader.ReadFile("/diag.step");
const sval = status?.value ?? status;
log("ReadFile status:", sval, "(1=Done 2=Error 3=Fail 4=Void)");

if (sval === 1) {
  const n = reader.TransferRoots();
  log("TransferRoots roots:", String(n));
  const shape = reader.OneShape();
  log("OneShape IsNull:", String(shape.IsNull()));
  let faces = 0;
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  for (; exp.More(); exp.Next()) faces++;
  log("face count:", faces);
}
log("DONE");
