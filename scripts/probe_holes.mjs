// Probe surface-analysis API for hole detection against samples/demo.step.
// For each face: surface type; for cylinders: radius, U/V ranges, axis, hole-vs-boss.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./probe_holes.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a) => appendFileSync(out, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
const tryStep = (label, fn) => {
  try {
    return fn();
  } catch (e) {
    log("FAIL", label, "::", (e && e.message) || String(e));
    return undefined;
  }
};

const oc = await getOC();
oc.STEPControl_Controller.Init();
const bytes = readFileSync(fileURLToPath(new URL("../samples/demo.step", import.meta.url)));
oc.FS.writeFile("/h.step", new Uint8Array(bytes));
const reader = new oc.STEPControl_Reader_1();
reader.ReadFile("/h.step");
reader.TransferRoots();
const shape = reader.OneShape();

// Enumerate the surface-type enum + needed symbols.
log("GeomAbs_SurfaceType keys:", JSON.stringify(Object.keys(oc.GeomAbs_SurfaceType || {})));
for (const n of ["BRepAdaptor_Surface_2", "BRepAdaptor_Surface_3", "BRepClass3d_SolidClassifier_2", "TopAbs_State", "gp_Cylinder"]) {
  log("typeof", n, "=", typeof oc[n]);
}

// Build a solid classifier (find a solid first).
let solid = shape;
const se = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
if (se.More()) solid = oc.TopoDS.Solid_1(se.Current());
const classifier = tryStep("classifier", () => new oc.BRepClass3d_SolidClassifier_2(solid));
const OUT = oc.TopAbs_State?.TopAbs_OUT;

const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
const exp = new oc.TopExp_Explorer_2(shape, FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
let fid = 0;
const typeCounts = {};
for (; exp.More(); exp.Next(), fid++) {
  const face = oc.TopoDS.Face_1(exp.Current());
  const sa = new oc.BRepAdaptor_Surface_2(face, true);
  const t = sa.GetType();
  const tval = t?.value ?? t;
  typeCounts[tval] = (typeCounts[tval] || 0) + 1;
  // Cylinder enum value:
  const CYL = oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
  const cylVal = CYL?.value ?? CYL;
  if (tval === cylVal) {
    const cyl = sa.Cylinder();
    const r = cyl.Radius();
    const ax = cyl.Axis();
    const d = ax.Direction();
    const u0 = sa.FirstUParameter(), u1 = sa.LastUParameter();
    const v0 = sa.FirstVParameter(), v1 = sa.LastVParameter();
    // Hole vs boss: test a point just inside the surface (toward axis).
    const sp = sa.Value((u0 + u1) / 2, (v0 + v1) / 2); // gp_Pnt on surface
    const loc = ax.Location();
    // axis point nearest sp:
    const ax2 = [d.X(), d.Y(), d.Z()];
    const rel = [sp.X() - loc.X(), sp.Y() - loc.Y(), sp.Z() - loc.Z()];
    const t1 = rel[0] * ax2[0] + rel[1] * ax2[1] + rel[2] * ax2[2];
    const axp = [loc.X() + ax2[0] * t1, loc.Y() + ax2[1] * t1, loc.Z() + ax2[2] * t1];
    const radial = [sp.X() - axp[0], sp.Y() - axp[1], sp.Z() - axp[2]];
    const rlen = Math.hypot(...radial) || 1;
    const eps = r * 0.2;
    const tp = new oc.gp_Pnt_3(
      sp.X() - (radial[0] / rlen) * eps,
      sp.Y() - (radial[1] / rlen) * eps,
      sp.Z() - (radial[2] / rlen) * eps,
    );
    let state = "n/a";
    if (classifier) {
      classifier.Perform(tp, 1e-6);
      const st = classifier.State();
      state = (st?.value ?? st) === (OUT?.value ?? OUT) ? "HOLE(out)" : "boss/in";
    }
    log(
      `face ${fid}: CYL r=${r.toFixed(2)} dia=${(2 * r).toFixed(2)} ` +
        `Urange=${(u1 - u0).toFixed(2)} Vrange=${(v1 - v0).toFixed(2)} ` +
        `axis=(${d.X().toFixed(2)},${d.Y().toFixed(2)},${d.Z().toFixed(2)}) ${state}`,
    );
  }
}
log("type counts (enum->n):", JSON.stringify(typeCounts));
log("DONE");
