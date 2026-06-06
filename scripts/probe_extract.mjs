// Replicate the app's extractEdges() EXACTLY and check whether the fillet tangent
// edges survive into the rendered segment list.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./probe_extract.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a) => appendFileSync(out, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");

const oc = await getOC();
oc.STEPControl_Controller.Init();
const bytes = readFileSync(fileURLToPath(new URL("../samples/demo.step", import.meta.url)));
oc.FS.writeFile("/d.step", new Uint8Array(bytes));
const reader = new oc.STEPControl_Reader_1();
reader.ReadFile("/d.step");
reader.TransferRoots();
const shape = reader.OneShape();

const round3 = (v) => Math.round(v * 1000) / 1000;
const seg = [];
const segmentIds = [];
const seen = new Map();
let edgeCount = 0;
const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE.constructor ? oc.TopAbs_ShapeEnum.TopAbs_EDGE : oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
for (; exp.More(); exp.Next()) {
  const edge = oc.TopoDS.Edge_1(exp.Current());
  const pts = [];
  try {
    const adaptor = new oc.BRepAdaptor_Curve_2(edge);
    const gc = new oc.GCPnts_TangentialDeflection_2(adaptor, 0.2, 0.2, 2, 1.0e-9, 1.0e-7);
    const np = gc.NbPoints();
    if (np < 2) continue;
    for (let i = 1; i <= np; i++) {
      const p = gc.Value(i);
      pts.push(p.X(), p.Y(), p.Z());
    }
  } catch {
    continue;
  }
  const n = pts.length;
  const a = `${round3(pts[0])},${round3(pts[1])},${round3(pts[2])}`;
  const b = `${round3(pts[n - 3])},${round3(pts[n - 2])},${round3(pts[n - 1])}`;
  const mi = Math.floor(n / 6) * 3;
  const mid = `${round3(pts[mi])},${round3(pts[mi + 1])},${round3(pts[mi + 2])}`;
  const sig = (a < b ? a + "|" + b : b + "|" + a) + "|" + mid;
  if (seen.has(sig)) continue;
  const id = edgeCount++;
  seen.set(sig, id);
  for (let i = 3; i < n; i += 3) {
    seg.push(pts[i - 3], pts[i - 2], pts[i - 1], pts[i], pts[i + 1], pts[i + 2]);
    segmentIds.push(id);
  }
}

log("unique edges (edgeCount):", edgeCount);
log("total segments:", segmentIds.length);

// Find vertical line segments (constant x,y; z spans), report their (x,y).
const verticals = new Set();
for (let s = 0; s < segmentIds.length; s++) {
  const i = s * 6;
  const ax = seg[i], ay = seg[i + 1], az = seg[i + 2];
  const bx = seg[i + 3], by = seg[i + 4], bz = seg[i + 5];
  if (Math.abs(ax - bx) < 1e-3 && Math.abs(ay - by) < 1e-3 && Math.abs(az - bz) > 1) {
    verticals.add(`${round3(ax)},${round3(ay)}`);
  }
}
log("vertical edge (x,y) locations:", JSON.stringify([...verticals].sort()));

// Expected fillet tangent verticals for a 78x54 plate, R6 corners:
const expected = ["6,0", "0,6", "72,0", "78,6", "0,48", "6,54", "72,54", "78,48"];
const missing = expected.filter((e) => !verticals.has(e));
log("expected fillet tangents present?", missing.length === 0 ? "ALL PRESENT" : "MISSING: " + JSON.stringify(missing));
log("DONE");
