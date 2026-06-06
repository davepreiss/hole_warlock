// Build the demo part: a 120 x 80 x 12 plate with radiused corners, a chamfered
// top perimeter, a spread of tap-drill / clearance holes, plus one counterbore and
// one countersink (so hole-feature detection has something to find).
// Writes public/demo.step + samples/demo.step. Doubles as an API probe (logs).
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./make-demo.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a) => appendFileSync(out, a.join(" ") + "\n");
const step = (label, fn) => {
  try {
    const r = fn();
    log("OK  ", label);
    return r;
  } catch (e) {
    log("FAIL", label, "::", (e && e.message) || String(e));
    throw e;
  }
};

const oc = await getOC();
oc.STEPControl_Controller.Init();

const keys = Object.keys(oc);
log("MakeCone variants:", JSON.stringify(keys.filter((k) => k.startsWith("BRepPrimAPI_MakeCone")).sort()));

// 2x3 grid: 15 mm center-to-edge margin, 24 mm uniform spacing.
const W = 78, D = 54, H = 12;
const pnt = (x, y, z) => new oc.gp_Pnt_3(x, y, z);
const dirZ = () => new oc.gp_Dir_4(0, 0, 1);
const ax2 = (x, y, z) => new oc.gp_Ax2_3(pnt(x, y, z), dirZ());
const cut = (a, b) => new oc.BRepAlgoAPI_Cut_3(a, b).Shape();

function endpoints(edge) {
  const ad = new oc.BRepAdaptor_Curve_2(edge);
  const a = ad.Value(ad.FirstParameter());
  const b = ad.Value(ad.LastParameter());
  return [[a.X(), a.Y(), a.Z()], [b.X(), b.Y(), b.Z()]];
}
function forEachEdge(shape, cb) {
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) cb(oc.TopoDS.Edge_1(exp.Current()));
}

try {
  let shape = step("MakeBox", () => new oc.BRepPrimAPI_MakeBox_1(W, D, H).Shape());

  const EPS = 1e-6;
  shape = step("fillet vertical edges", () => {
    const mk = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    forEachEdge(shape, (edge) => {
      const [a, b] = endpoints(edge);
      if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS && Math.abs(a[2] - b[2]) > EPS)
        mk.Add_2(6, edge);
    });
    return mk.Shape();
  });

  shape = step("chamfer top perimeter", () => {
    const mk = new oc.BRepFilletAPI_MakeChamfer(shape);
    forEachEdge(shape, (edge) => {
      const [a, b] = endpoints(edge);
      if (Math.abs(a[2] - H) < EPS && Math.abs(b[2] - H) < EPS) mk.Add_2(2.5, edge);
    });
    return mk.Shape();
  });

  // Plain through holes: [x, y, diameter].
  // Top-left: a 2x2 pattern of 4x Ø2.5 (M3) at 5 mm spacing (demonstrates multiples).
  const holes = [
    [12.5, 12.5, 2.5], [17.5, 12.5, 2.5], [12.5, 17.5, 2.5], [17.5, 17.5, 2.5], // 4x M3
    [39, 15, 5.2], // M6 tap drill
    [63, 15, 4.5], // M4 clearance
    [63, 39, 7.5], // oddball -> low confidence
  ];
  for (const [x, y, dia] of holes) {
    shape = step(`hole d=${dia} @ (${x},${y})`, () =>
      cut(shape, new oc.BRepPrimAPI_MakeCylinder_3(ax2(x, y, -1), dia / 2, H + 2).Shape()),
    );
  }

  // Counterbore @ (15,39): Ø5.5 through, Ø9.5 c'bore 5.4 deep from the top.
  shape = step("counterbore", () => {
    let s = cut(shape, new oc.BRepPrimAPI_MakeCylinder_3(ax2(15, 39, -1), 2.75, H + 2).Shape());
    s = cut(s, new oc.BRepPrimAPI_MakeCylinder_3(ax2(15, 39, H - 5.4), 4.75, 5.4 + 1).Shape());
    return s;
  });

  // Countersink @ (39,39): Ø5.5 through, 90° csk opening to Ø10 at the top.
  // Cone slope 45° (90° included): base r=2.75 at z=H-2.25 up to r=6.0 at z=H+1.
  shape = step("countersink", () => {
    let s = cut(shape, new oc.BRepPrimAPI_MakeCylinder_3(ax2(39, 39, -1), 2.75, H + 2).Shape());
    const cone = new oc.BRepPrimAPI_MakeCone_3(ax2(39, 39, H - 2.25), 2.75, 6.0, 3.25).Shape();
    s = cut(s, cone);
    return s;
  });

  step("mesh", () => new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false));
  step("write STEP", () => {
    const writer = new oc.STEPControl_Writer_1();
    writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
    writer.Write("/demo.step");
  });
  const text = oc.FS.readFile("/demo.step", { encoding: "utf8" });
  writeFileSync(fileURLToPath(new URL("../public/demo.step", import.meta.url)), text);
  writeFileSync(fileURLToPath(new URL("../samples/demo.step", import.meta.url)), text);
  log("WROTE demo.step bytes:", text.length);
  log("DONE OK");
} catch (e) {
  log("ABORTED:", (e && e.message) || String(e));
  process.exitCode = 1;
}
