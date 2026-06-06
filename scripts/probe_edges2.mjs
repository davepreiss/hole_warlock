// Inspect the demo's edges: classify by curve type and tag the fillet tangent
// edges (straight vertical lines on the rounded corners) to see if they're even
// present in the B-rep edge set (and survive dedup).
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./probe_edges2.out.txt", import.meta.url));
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
const typeName = (gc) => {
  const T = oc.GeomAbs_CurveType;
  const map = {
    [T.GeomAbs_Line.value ?? T.GeomAbs_Line]: "LINE",
    [T.GeomAbs_Circle.value ?? T.GeomAbs_Circle]: "CIRCLE",
    [T.GeomAbs_Ellipse.value ?? T.GeomAbs_Ellipse]: "ELLIPSE",
    [T.GeomAbs_BSplineCurve.value ?? T.GeomAbs_BSplineCurve]: "BSPLINE",
  };
  const t = gc.GetType();
  return map[t?.value ?? t] ?? "OTHER(" + (t?.value ?? t) + ")";
};

let total = 0;
const seen = new Map();
const byType = {};
let verticalLines = 0;
const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
for (; exp.More(); exp.Next()) {
  total++;
  const edge = oc.TopoDS.Edge_1(exp.Current());
  let ad;
  try {
    ad = new oc.BRepAdaptor_Curve_2(edge);
  } catch {
    byType.DEGENERATE = (byType.DEGENERATE ?? 0) + 1;
    continue;
  }
  const tn = typeName(ad);
  byType[tn] = (byType[tn] ?? 0) + 1;
  const a = ad.Value(ad.FirstParameter());
  const b = ad.Value(ad.LastParameter());
  const av = [a.X(), a.Y(), a.Z()];
  const bv = [b.X(), b.Y(), b.Z()];
  // Vertical straight edge (constant x,y; z varies) = fillet tangent candidate.
  if (tn === "LINE" && Math.abs(av[0] - bv[0]) < 1e-3 && Math.abs(av[1] - bv[1]) < 1e-3 && Math.abs(av[2] - bv[2]) > 1) {
    verticalLines++;
  }
  // Dedup signature like extractEdges.
  const sa = `${round3(av[0])},${round3(av[1])},${round3(av[2])}`;
  const sb = `${round3(bv[0])},${round3(bv[1])},${round3(bv[2])}`;
  const sig = sa < sb ? sa + "|" + sb : sb + "|" + sa;
  seen.set(sig, (seen.get(sig) ?? 0) + 1);
}

log("total edges (with duplicates):", total);
log("by curve type:", JSON.stringify(byType));
log("vertical straight lines (fillet tangents incl. box verticals):", verticalLines);
log("unique edges after dedup:", seen.size);
log("DONE");
