// Validate edge-extraction API for the black-edge overlay (and future edge picking).
// Tries: (1) BRep_Tool.Polygon3D after meshing, (2) BRepAdaptor_Curve + GCPnts.
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./probe_edges.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a) => appendFileSync(out, a.join(" ") + "\n");
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
oc.STEPControl_Controller.Init();

const keys = Object.keys(oc);
for (const pat of ["Polygon3D", "BRepAdaptor_Curve", "GCPnts_TangentialDeflection", "GCPnts_UniformDeflection"]) {
  log(`/${pat}/:`, JSON.stringify(keys.filter((k) => k.includes(pat)).sort().slice(0, 8)));
}

const box = new oc.BRepPrimAPI_MakeBox_1(60, 40, 10);
const shape = box.Shape();
new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);

// Approach 1: Polygon3D after meshing.
let edgeCount = 0;
let poly3dNonNull = 0;
const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
let firstEdge = null;
for (; exp.More(); exp.Next()) {
  const edge = oc.TopoDS.Edge_1(exp.Current());
  if (!firstEdge) firstEdge = edge;
  const loc = new oc.TopLoc_Location_1();
  const h = oc.BRep_Tool.Polygon3D(edge, loc);
  if (h && !h.IsNull()) {
    poly3dNonNull++;
    if (poly3dNonNull === 1) {
      const p = h.get();
      const nodes = tryStep("polygon3d.Nodes()", () => p.Nodes());
      if (nodes) log("   nb nodes:", p.NbNodes?.() ?? "(n/a)", "lower/upper:", nodes.Lower(), nodes.Upper());
    }
  }
  edgeCount++;
}
log("edge occurrences:", edgeCount, "with Polygon3D:", poly3dNonNull);

// Approach 2: BRepAdaptor_Curve + GCPnts_TangentialDeflection on the first edge.
if (firstEdge) {
  const ad = tryStep("new BRepAdaptor_Curve_2(edge)", () => new oc.BRepAdaptor_Curve_2(firstEdge));
  if (ad) {
    tryStep("ad.FirstParameter()", () => ad.FirstParameter());
    tryStep("ad.LastParameter()", () => ad.LastParameter());
    const gc = tryStep("GCPnts_TangentialDeflection_2(ad,0.3,0.3,2,1e-9,1e-7)", () =>
      new oc.GCPnts_TangentialDeflection_2(ad, 0.3, 0.3, 2, 1.0e-9, 1.0e-7),
    );
    if (gc) {
      const n = tryStep("gc.NbPoints()", () => gc.NbPoints());
      if (n) {
        const v = tryStep("gc.Value(1)", () => gc.Value(1));
        if (v) log("   pt1:", v.X(), v.Y(), v.Z());
      }
    }
  }

  // Full pass: build segment endpoints for every edge occurrence.
  let segs = 0;
  const e2 = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; e2.More(); e2.Next()) {
    const edge = oc.TopoDS.Edge_1(e2.Current());
    const ad = new oc.BRepAdaptor_Curve_2(edge);
    const gc = new oc.GCPnts_TangentialDeflection_2(ad, 0.3, 0.3, 2, 1.0e-9, 1.0e-7);
    const np = gc.NbPoints();
    segs += Math.max(0, np - 1);
  }
  log("total edge segments for box:", segs);
}
log("DONE");
