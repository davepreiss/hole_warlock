// Validate hole-FEATURE grouping on the new demo: group coaxial cylinders + cones
// by axis line, then classify plain / counterbore / countersink.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./probe_features.out.txt", import.meta.url));
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

let solid = shape;
const se = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
if (se.More()) solid = oc.TopoDS.Solid_1(se.Current());
const classifier = new oc.BRepClass3d_SolidClassifier_2(solid);
const outVal = oc.TopAbs_State.TopAbs_OUT.value ?? oc.TopAbs_State.TopAbs_OUT;

const CYL = oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
const CONE = oc.GeomAbs_SurfaceType.GeomAbs_Cone.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cone;

const sign = (d) => {
  let [x, y, z] = d, e = 1e-9;
  if (x < -e || (Math.abs(x) < e && (y < -e || (Math.abs(y) < e && z < 0)))) return [-x, -y, -z];
  return [x, y, z];
};
const q = (v, p = 100) => Math.round(v * p) / p;

function classifyOut(sa, loc, dir, r, uMid, vMid) {
  const sp = sa.Value(uMid, vMid);
  const rel = [sp.X() - loc[0], sp.Y() - loc[1], sp.Z() - loc[2]];
  const al = rel[0] * dir[0] + rel[1] * dir[1] + rel[2] * dir[2];
  const rad = [sp.X() - (loc[0] + dir[0] * al), sp.Y() - (loc[1] + dir[1] * al), sp.Z() - (loc[2] + dir[2] * al)];
  const rl = Math.hypot(...rad) || 1;
  const eps = (r || 1) * 0.25;
  const tp = new oc.gp_Pnt_3(sp.X() - rad[0] / rl * eps, sp.Y() - rad[1] / rl * eps, sp.Z() - rad[2] / rl * eps);
  classifier.Perform(tp, 1e-6);
  const st = classifier.State();
  return (st.value ?? st) === outVal;
}

const items = [];
const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
let fid = 0;
for (; exp.More(); exp.Next(), fid++) {
  const sa = new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(exp.Current()), true);
  const t = sa.GetType().value ?? sa.GetType();
  const u0 = sa.FirstUParameter(), u1 = sa.LastUParameter(), v0 = sa.FirstVParameter(), v1 = sa.LastVParameter();
  if (t === CYL) {
    const cyl = sa.Cylinder(), ax = cyl.Axis(), d = ax.Direction(), L = ax.Location();
    const dir = sign([d.X(), d.Y(), d.Z()]);
    const lp = [L.X(), L.Y(), L.Z()], dot = lp[0]*dir[0]+lp[1]*dir[1]+lp[2]*dir[2];
    const foot = [lp[0]-dir[0]*dot, lp[1]-dir[1]*dot, lp[2]-dir[2]*dot];
    const isOut = classifyOut(sa, [L.X(),L.Y(),L.Z()], dir, cyl.Radius(), (u0+u1)/2, (v0+v1)/2);
    items.push({ fid, kind: "cyl", r: cyl.Radius(), dia: 2*cyl.Radius(), uSpan: u1-u0, vSpan: v1-v0, dir, foot, isOut });
  } else if (t === CONE) {
    const cone = sa.Cone(), ax = cone.Axis(), d = ax.Direction(), L = ax.Location();
    const dir = sign([d.X(), d.Y(), d.Z()]);
    const lp = [L.X(), L.Y(), L.Z()], dot = lp[0]*dir[0]+lp[1]*dir[1]+lp[2]*dir[2];
    const foot = [lp[0]-dir[0]*dot, lp[1]-dir[1]*dot, lp[2]-dir[2]*dot];
    items.push({ fid, kind: "cone", semiAngleDeg: cone.SemiAngle()*180/Math.PI, refR: cone.RefRadius(), uSpan: u1-u0, vSpan: v1-v0, dir, foot });
  }
}

// Group by axis line.
const groups = new Map();
for (const it of items) {
  const key = [...it.dir.map((x)=>q(x,1000)), ...it.foot.map((x)=>q(x))].join("|");
  (groups.get(key) ?? groups.set(key, []).get(key)).push(it);
}
log("axis groups with cyl/cone:", groups.size);
for (const [key, g] of groups) {
  const cyls = g.filter((x)=>x.kind==="cyl");
  const cones = g.filter((x)=>x.kind==="cone");
  const outCyls = cyls.filter((x)=>x.isOut);
  if (outCyls.length === 0 && cones.length === 0) continue;
  const dias = cyls.map((c)=>`Ø${c.dia.toFixed(2)}${c.isOut?"(out)":"(in)"}/U${c.uSpan.toFixed(2)}`);
  const conesS = cones.map((c)=>`cone semi=${c.semiAngleDeg.toFixed(1)}° refR=${c.refR.toFixed(2)} U${c.uSpan.toFixed(2)}`);
  log(`axis ${key.slice(0,28)} :: cyls[${dias.join(", ")}] cones[${conesS.join(", ")}]`);
}
log("DONE");
