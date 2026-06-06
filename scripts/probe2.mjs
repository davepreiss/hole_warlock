// Validate the READ + MESH path against samples/box.step (OCCT 7.4 API).
// Goal: confirm reader -> shape -> incremental mesh -> per-face triangulation
// node/triangle extraction, which the browser renderer will mirror.
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const logPath = fileURLToPath(new URL("./probe2.out.txt", import.meta.url));
writeFileSync(logPath, "");
const log = (...a) => appendFileSync(logPath, a.join(" ") + "\n");
const tryStep = (label, fn) => {
  try {
    const r = fn();
    log("OK  ", label, "=>", r === undefined ? "(void)" : String(r).slice(0, 70));
    return r;
  } catch (e) {
    log("FAIL", label, "::", (e && e.message) || String(e));
    return undefined;
  }
};

const oc = await getOC();

// Put the sample file into the emscripten virtual FS (mirrors browser: bytes -> FS).
const bytes = readFileSync(fileURLToPath(new URL("../samples/box.step", import.meta.url)));
oc.FS.writeFile("/in.step", bytes);

const reader = tryStep("new STEPControl_Reader_1()", () => new oc.STEPControl_Reader_1());
const rs = tryStep('ReadFile("/in.step")', () => reader.ReadFile("/in.step"));
log("  read status =", rs && rs.value !== undefined ? rs.value : String(rs));
const nRoots = tryStep("TransferRoots()", () => reader.TransferRoots());
log("  nRoots =", String(nRoots));
const shape = tryStep("OneShape()", () => reader.OneShape());
tryStep("shape.IsNull()", () => shape.IsNull());

// Mesh it.
tryStep("BRepMesh_IncrementalMesh_2(shape,0.1,false,0.5,false)", () =>
  new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false),
);

// Walk faces.
const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
const SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
const exp = new oc.TopExp_Explorer_2(shape, FACE, SHAPE);
let faceCount = 0;
let totalNodes = 0;
let totalTris = 0;
let firstFaceLogged = false;
for (; exp.More(); exp.Next()) {
  const face = oc.TopoDS.Face_1(exp.Current());
  const loc = new oc.TopLoc_Location_1();
  const handle = oc.BRep_Tool.Triangulation(face, loc);
  if (!handle || handle.IsNull()) {
    log(`  face ${faceCount}: no triangulation`);
    faceCount++;
    continue;
  }
  const tri = handle.get();
  const nbNodes = tri.NbNodes();
  const nbTris = tri.NbTriangles();
  totalNodes += nbNodes;
  totalTris += nbTris;
  if (!firstFaceLogged) {
    firstFaceLogged = true;
    // Probe the node/triangle accessor API on the first face.
    const nodes = tryStep("tri.Nodes()", () => tri.Nodes());
    if (nodes) {
      log("    nodes.Lower/Upper =", nodes.Lower(), nodes.Upper());
      const p = tryStep("nodes.Value(Lower)", () => nodes.Value(nodes.Lower()));
      if (p) log("    p.XYZ =", p.X(), p.Y(), p.Z());
    }
    const tris = tryStep("tri.Triangles()", () => tri.Triangles());
    if (tris) {
      log("    tris.Lower/Upper =", tris.Lower(), tris.Upper());
      const t = tryStep("tris.Value(Lower)", () => tris.Value(tris.Lower()));
      if (t) {
        const a = tryStep("t.Value(1)", () => t.Value(1));
        const b = tryStep("t.Value(2)", () => t.Value(2));
        const c = tryStep("t.Value(3)", () => t.Value(3));
        log("    triangle idx =", a, b, c);
      }
    }
    const locId = tryStep("loc.IsIdentity()", () => loc.IsIdentity());
    log("    loc.IsIdentity =", String(locId));
  }
  faceCount++;
}
log(`FACES = ${faceCount}, totalNodes = ${totalNodes}, totalTris = ${totalTris}`);
log("DONE");
