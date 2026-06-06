// Diagnose Nut_Sleeve.STEP: why cylindrical holes appear as multi-face features.
import { readFileSync } from "node:fs";
import { getOC } from "./occt-node.mjs";

const STEP_PATH = "H:/Shared drives/Variable Machines/Engineering/Native CAD Files/External Colaborations/Persues Materials/P0_Assembly/Nut_Sleeve.STEP";

const oc = await getOC();
oc.STEPControl_Controller.Init();
const bytes = readFileSync(STEP_PATH);
oc.FS.writeFile("/diag.step", bytes);

const reader = new oc.STEPControl_Reader_1();
const st = reader.ReadFile("/diag.step");
console.log("Read status:", st?.value ?? st, " roots:", reader.NbRootsForTransfer());
reader.TransferRoots();
const shape = reader.OneShape();
console.log("Shape null:", shape.IsNull());
oc.FS.unlink("/diag.step");

new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);

const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
const SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
const cylVal = oc.GeomAbs_SurfaceType.GeomAbs_Cylinder?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
const coneVal = oc.GeomAbs_SurfaceType.GeomAbs_Cone?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cone;

// Collect all cylindrical faces with their axis/radius/uSpan.
const cylFaces = [];
let faceId = 0;
const exp = new oc.TopExp_Explorer_2(shape, FACE, SHAPE);
for (; exp.More(); exp.Next(), faceId++) {
  let sa;
  try { sa = new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(exp.Current()), true); }
  catch { continue; }
  const tv = sa.GetType()?.value ?? sa.GetType();
  if (tv !== cylVal) continue;

  const cyl = sa.Cylinder();
  const ax = cyl.Axis();
  const dd = ax.Direction();
  const ll = ax.Location();
  const r = cyl.Radius();
  const u0 = sa.FirstUParameter(), u1 = sa.LastUParameter();
  const v0 = sa.FirstVParameter(), v1 = sa.LastVParameter();
  const uSpan = u1 - u0;

  // Quantize axis dir and a point on the axis for grouping.
  const q = (v, p=1000) => Math.round(v*p)/p;
  const dir = [q(dd.X()), q(dd.Y()), q(dd.Z())];
  // Normalize direction sign so +Z preferred over -Z, etc.
  const flipSign = dir[0] < -1e-3 || (Math.abs(dir[0]) < 1e-3 && (dir[1] < -1e-3 || (Math.abs(dir[1]) < 1e-3 && dir[2] < 0)));
  const normDir = flipSign ? dir.map(v => -v) : dir;
  // Foot of perpendicular from origin onto the axis line.
  const dot = ll.X()*dd.X() + ll.Y()*dd.Y() + ll.Z()*dd.Z();
  const foot = [
    q(ll.X() - dd.X()*dot),
    q(ll.Y() - dd.Y()*dot),
    q(ll.Z() - dd.Z()*dot),
  ];
  cylFaces.push({ faceId, r: q(r, 100), dir: normDir, foot, uSpan: q(uSpan, 1000), v0: q(v0,10), v1: q(v1,10), full: uSpan >= 1.9*Math.PI });
}
console.log(`\nTotal cylindrical faces: ${cylFaces.length}`);

// Group by axis line + radius (the same hole criterion detectHoles uses).
const groups = new Map();
for (const f of cylFaces) {
  const key = `${f.dir.join(",")}|${f.foot.join(",")}|${f.r}`;
  const g = groups.get(key) ?? [];
  g.push(f);
  groups.set(key, g);
}

const multi = [...groups.values()].filter(g => g.length > 1);
const single = [...groups.values()].filter(g => g.length === 1);
console.log(`Hole axis-groups: ${groups.size} total  (${single.length} single-face, ${multi.length} multi-face)`);

// Analyse the multi-face groups.
if (multi.length > 0) {
  console.log("\n=== MULTI-FACE HOLE GROUPS ===");
  for (const g of multi) {
    const totalU = g.reduce((s,f) => s+f.uSpan, 0);
    const totalUDeg = (totalU * 180 / Math.PI).toFixed(1);
    const allFull = g.every(f => f.full);
    const anyFull = g.some(f => f.full);
    console.log(`  r=${g[0].r}mm  dir=${g[0].dir.join(",")}  faces=${g.length}  totalArc=${totalUDeg}°  allFull=${allFull}`);
    for (const f of g) {
      console.log(`    faceId=${f.faceId}  uSpan=${(f.uSpan*180/Math.PI).toFixed(1)}°  full=${f.full}  vRange=[${f.v0}, ${f.v1}]`);
    }
  }
}

// Check: partial-arc faces (the core symptom — holes split into arc segments).
const partial = cylFaces.filter(f => !f.full);
console.log(`\nPartial-arc faces (uSpan < 340°): ${partial.length} of ${cylFaces.length}`);
if (partial.length > 0) {
  // Bin by uSpan range to see if there's a pattern (e.g., all ~180°).
  const bins = {};
  for (const f of partial) {
    const bin = `${Math.round(f.uSpan * 180 / Math.PI / 30) * 30}°`;
    bins[bin] = (bins[bin] ?? 0) + 1;
  }
  console.log("  Arc-span distribution:", JSON.stringify(bins));
  console.log("  Sample partial faces:");
  partial.slice(0, 6).forEach(f =>
    console.log(`    faceId=${f.faceId} r=${f.r}mm uSpan=${(f.uSpan*180/Math.PI).toFixed(1)}°`));
}

// Check for seam edges (expected=1 per full cylinder; 0 means truly split into arcs with hard edges).
console.log("\n=== SEAM EDGE CHECK on multi-face group faces ===");
const multiIds = new Set(multi.flatMap(g => g.map(f => f.faceId)));
let fid2 = 0;
const fexp2 = new oc.TopExp_Explorer_2(shape, FACE, SHAPE);
for (; fexp2.More(); fexp2.Next(), fid2++) {
  if (!multiIds.has(fid2)) continue;
  const face = oc.TopoDS.Face_1(fexp2.Current());
  const eexp = new oc.TopExp_Explorer_2(face, EDGE, SHAPE);
  let edgeCount = 0, seamCount = 0;
  for (; eexp.More(); eexp.Next(), edgeCount++) {
    const edge = oc.TopoDS.Edge_1(eexp.Current());
    let closed = false;
    try { closed = oc.BRep_Tool.IsClosed_2(edge, face); } catch {}
    if (closed) seamCount++;
  }
  eexp.delete();
  console.log(`  faceId=${fid2} r=${cylFaces.find(f=>f.faceId===fid2)?.r}mm: ${edgeCount} edges, ${seamCount} seams (seamless + partial arc = split hole)`);
}

// Check the uSpan filter in detectHoles: it passes only groups where
// SUM(uSpan) >= 1.9π AND <= 1.1·2π.  Show which groups fail this.
console.log("\n=== detectHoles uSpan filter check ===");
let pass = 0, failLow = 0, failHigh = 0;
for (const g of groups.values()) {
  const byR = new Map();
  for (const f of g) {
    if (!f.full) { // partial-arc faces — detectHoles groups them by r then checks sum
      const k = f.r.toFixed(2);
      const e = byR.get(k) ?? { r: f.r, uSum: 0 };
      e.uSum += f.uSpan;
      byR.set(k, e);
    } else {
      const k = f.r.toFixed(2);
      const e = byR.get(k) ?? { r: f.r, uSum: 0 };
      e.uSum += f.uSpan;
      byR.set(k, e);
    }
  }
  for (const { r, uSum } of byR.values()) {
    if (uSum >= 1.9 * Math.PI && uSum <= 1.1 * 2 * Math.PI) pass++;
    else if (uSum < 1.9 * Math.PI) {
      failLow++;
      if (failLow <= 6) console.log(`  FAIL-low: r=${r}mm uSum=${(uSum*180/Math.PI).toFixed(1)}° (needs ≥342° to pass)`);
    } else {
      failHigh++;
      if (failHigh <= 3) console.log(`  FAIL-high: r=${r}mm uSum=${(uSum*180/Math.PI).toFixed(1)}°`);
    }
  }
}
console.log(`Pass: ${pass}  Fail-too-small: ${failLow}  Fail-too-large: ${failHigh}`);

console.log("\nDONE");
