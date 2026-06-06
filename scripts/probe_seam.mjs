// Probe: identify the parametric SEAM edge of cylindrical/conical faces so we can
// skip rendering/selecting it. Tests BRep_Tool::IsClosed(edge, face) (true == the
// edge is a seam == it has two pcurves on that face).
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOC } from "./occt-node.mjs";

const out = fileURLToPath(new URL("./probe_seam.out.txt", import.meta.url));
writeFileSync(out, "");
const log = (...a) => appendFileSync(out, a.join(" ") + "\n");

const oc = await getOC();
oc.STEPControl_Controller.Init();

// What IsClosed overloads exist?
const keys = Object.keys(oc.BRep_Tool ?? {});
log("BRep_Tool IsClosed* keys:", JSON.stringify(keys.filter((k) => k.includes("IsClosed"))));

const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
const EDGE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE; // sub-iter uses SHAPE as 'to avoid'
const SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;

function analyze(label, shape) {
  new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
  let faceId = 0;
  let seamTotal = 0;
  const fexp = new oc.TopExp_Explorer_2(shape, FACE, SHAPE);
  for (; fexp.More(); fexp.Next(), faceId++) {
    const face = oc.TopoDS.Face_1(fexp.Current());
    const eexp = new oc.TopExp_Explorer_2(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, SHAPE);
    let seamOnFace = 0;
    for (; eexp.More(); eexp.Next()) {
      const edge = oc.TopoDS.Edge_1(eexp.Current());
      let closed = false;
      try {
        closed = oc.BRep_Tool.IsClosed_2(edge, face);
      } catch (e) {
        log("  IsClosed_2 FAIL:", (e && e.message) || String(e));
      }
      if (closed) {
        seamOnFace++;
        seamTotal++;
        // Geometry of this seam: sample endpoints.
        try {
          const ad = new oc.BRepAdaptor_Curve_2(edge);
          const gc = new oc.GCPnts_TangentialDeflection_2(ad, 0.5, 0.5, 2, 1e-9, 1e-7);
          const np = gc.NbPoints();
          const a = gc.Value(1);
          const b = gc.Value(np);
          log(
            `  face#${faceId} SEAM: (${a.X().toFixed(2)},${a.Y().toFixed(2)},${a.Z().toFixed(2)}) -> ` +
              `(${b.X().toFixed(2)},${b.Y().toFixed(2)},${b.Z().toFixed(2)})`,
          );
        } catch {
          /* ignore */
        }
      }
    }
    eexp.delete();
    if (seamOnFace) log(`  face#${faceId}: ${seamOnFace} seam edge(s)`);
  }
  fexp.delete();
  log(`${label}: ${faceId} faces, ${seamTotal} seam-edge occurrences`);
  log("");
}

// 1) A bare cylinder (one cylindrical side face -> exactly one seam).
analyze("cylinder", new oc.BRepPrimAPI_MakeCylinder_1(8, 20).Shape());

// 2) A cone (full cone -> one seam on the conical face).
analyze("cone", new oc.BRepPrimAPI_MakeCone_1(8, 0, 20).Shape());

// A plain box has no periodic faces, so it must report zero seams (sanity check).
analyze("box", new oc.BRepPrimAPI_MakeBox_1(40, 40, 20).Shape());

log("DONE");
