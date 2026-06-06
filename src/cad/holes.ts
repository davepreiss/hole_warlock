// Detect hole FEATURES in a solid: group coaxial cylindrical + conical faces by
// their axis line, then classify each as a simple hole, a counterbore (a second,
// larger coaxial cylinder) or a countersink (a coaxial cone at the entry).
//
// Material must be on the outside of the bore (classified OUT toward the axis),
// which rejects bosses; and each bore's angular spans must sum to ~360°, which
// rejects fillets/rounds. API validated in scripts/probe_holes.mjs / probe_features.mjs.
import type { OC } from "./occt";

export type HoleType = "simple" | "counterbore" | "countersink";

export interface Hole {
  /** All faces forming this feature (TopExp indices = MeshData faceIds). */
  faceIds: number[];
  /** Representative face id (the main bore) for selection/highlighting. */
  faceId: number;
  type: HoleType;
  /** Main (smallest) bore diameter, mm. */
  diameter: number;
  /** Axial length of the main bore, mm. */
  depth: number;
  axis: [number, number, number];
  location: [number, number, number];
  /** True if the bore exits the far side (through); false = blind (capped by material). */
  through: boolean;
  /** Counterbore: larger bore diameter + its depth. */
  cboreDiameter?: number;
  cboreDepth?: number;
  /** Countersink: major diameter + included angle (deg). */
  cskDiameter?: number;
  cskAngleDeg?: number;
  /** Top rim circle (entry opening) — used to anchor drawing leaders on a real edge. */
  rim: { center: [number, number, number]; axis: [number, number, number]; radius: number };
  /** Far (opposite) end of the bore along the axis — lets a leader flip to that opening. */
  farEnd: { center: [number, number, number]; radius: number };
}

const TWO_PI = Math.PI * 2;

function signNormalize(d: [number, number, number]): [number, number, number] {
  const [x, y, z] = d;
  const e = 1e-9;
  const flip = x < -e || (Math.abs(x) < e && (y < -e || (Math.abs(y) < e && z < 0)));
  return flip ? [-x, -y, -z] : [x, y, z];
}

const q = (v: number, p = 100) => Math.round(v * p) / p;

function footOnAxis(
  loc: [number, number, number],
  dir: [number, number, number],
): [number, number, number] {
  const dot = loc[0] * dir[0] + loc[1] * dir[1] + loc[2] * dir[2];
  return [loc[0] - dir[0] * dot, loc[1] - dir[1] * dot, loc[2] - dir[2] * dot];
}

function radialDist(
  p: [number, number, number],
  loc: [number, number, number],
  dir: [number, number, number],
): number {
  const rel = [p[0] - loc[0], p[1] - loc[1], p[2] - loc[2]];
  const along = rel[0] * dir[0] + rel[1] * dir[1] + rel[2] * dir[2];
  const rad = [rel[0] - dir[0] * along, rel[1] - dir[1] * along, rel[2] - dir[2] * along];
  return Math.hypot(rad[0], rad[1], rad[2]);
}

type V3 = [number, number, number];

interface Seg {
  faceId: number;
  kind: "cyl" | "cone";
  dir: V3;
  foot: V3;
  uSpan: number;
  vSpan: number;
  r?: number; // cylinder radius
  isOut?: boolean; // cylinder: material outside the wall
  majorR?: number; // cone: largest radius of the face
  semiAngleDeg?: number; // cone half-angle from axis
  // World end-ring centers of the face (along the axis) + their radii.
  endA: V3;
  endB: V3;
  rA: number;
  rB: number;
}

interface PlanarSeg {
  faceId: number;
  normal: V3;  // sign-normalised unit normal
  sample: V3;  // a point on the face surface
}

const topByZ = (a: V3, b: V3): V3 => (a[2] >= b[2] ? a : b);

/** Foot of the perpendicular from p onto the axis line through loc with direction dir. */
function axisCenter(p: V3, loc: V3, dir: V3): V3 {
  const a = (p[0] - loc[0]) * dir[0] + (p[1] - loc[1]) * dir[1] + (p[2] - loc[2]) * dir[2];
  return [loc[0] + dir[0] * a, loc[1] + dir[1] * a, loc[2] + dir[2] * a];
}

export function detectHoles(oc: OC, shape: any): Hole[] {
  let solid = shape;
  const se = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  if (se.More()) solid = oc.TopoDS.Solid_1(se.Current());
  let classifier: any;
  try {
    classifier = new oc.BRepClass3d_SolidClassifier_2(solid);
  } catch {
    classifier = null;
  }
  const outVal = oc.TopAbs_State?.TopAbs_OUT?.value ?? oc.TopAbs_State?.TopAbs_OUT;
  const cylVal = oc.GeomAbs_SurfaceType.GeomAbs_Cylinder?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
  const coneVal = oc.GeomAbs_SurfaceType.GeomAbs_Cone?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cone;
  const planVal = oc.GeomAbs_SurfaceType.GeomAbs_Plane?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Plane;
  const planarFaces: PlanarSeg[] = [];

  const segs: Seg[] = [];
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  let faceId = 0;
  for (; exp.More(); exp.Next(), faceId++) {
    let sa: any;
    try {
      sa = new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(exp.Current()), true);
    } catch {
      continue;
    }
    const t = sa.GetType();
    const tv = t?.value ?? t;
    const u0 = sa.FirstUParameter();
    const u1 = sa.LastUParameter();
    const v0 = sa.FirstVParameter();
    const v1 = sa.LastVParameter();
    const uMid = (u0 + u1) / 2;

    if (tv === cylVal) {
      const cyl = sa.Cylinder();
      const r = cyl.Radius();
      const ax = cyl.Axis();
      const dd = ax.Direction();
      const ll = ax.Location();
      const dir = signNormalize([dd.X(), dd.Y(), dd.Z()]);
      const loc: [number, number, number] = [ll.X(), ll.Y(), ll.Z()];

      let isOut = true;
      if (classifier) {
        const sp = sa.Value(uMid, (v0 + v1) / 2);
        const along =
          (sp.X() - loc[0]) * dir[0] + (sp.Y() - loc[1]) * dir[1] + (sp.Z() - loc[2]) * dir[2];
        const rad = [
          sp.X() - (loc[0] + dir[0] * along),
          sp.Y() - (loc[1] + dir[1] * along),
          sp.Z() - (loc[2] + dir[2] * along),
        ];
        const rl = Math.hypot(rad[0], rad[1], rad[2]) || 1;
        const eps = r * 0.25;
        const tp = new oc.gp_Pnt_3(
          sp.X() - (rad[0] / rl) * eps,
          sp.Y() - (rad[1] / rl) * eps,
          sp.Z() - (rad[2] / rl) * eps,
        );
        classifier.Perform(tp, 1e-6);
        const st = classifier.State();
        isOut = (st?.value ?? st) === outVal;
      }
      const pA = sa.Value(uMid, v0);
      const pB = sa.Value(uMid, v1);
      segs.push({
        faceId,
        kind: "cyl",
        dir,
        foot: footOnAxis(loc, dir),
        uSpan: u1 - u0,
        vSpan: v1 - v0,
        r,
        isOut,
        endA: axisCenter([pA.X(), pA.Y(), pA.Z()], loc, dir),
        endB: axisCenter([pB.X(), pB.Y(), pB.Z()], loc, dir),
        rA: r,
        rB: r,
      });
    } else if (tv === coneVal) {
      const cone = sa.Cone();
      const ax = cone.Axis();
      const dd = ax.Direction();
      const ll = ax.Location();
      const dir = signNormalize([dd.X(), dd.Y(), dd.Z()]);
      const loc: [number, number, number] = [ll.X(), ll.Y(), ll.Z()];
      // Largest radius of the cone face (evaluate at both V extremes).
      const pa = sa.Value(uMid, v0);
      const pb = sa.Value(uMid, v1);
      const pav: V3 = [pa.X(), pa.Y(), pa.Z()];
      const pbv: V3 = [pb.X(), pb.Y(), pb.Z()];
      const ra = radialDist(pav, loc, dir);
      const rb = radialDist(pbv, loc, dir);
      segs.push({
        faceId,
        kind: "cone",
        dir,
        foot: footOnAxis(loc, dir),
        uSpan: u1 - u0,
        vSpan: v1 - v0,
        majorR: Math.max(ra, rb),
        semiAngleDeg: Math.abs((cone.SemiAngle() * 180) / Math.PI),
        endA: axisCenter(pav, loc, dir),
        endB: axisCenter(pbv, loc, dir),
        rA: ra,
        rB: rb,
      });
    } else if (tv === planVal) {
      try {
        const plane = sa.Plane();
        const nn = plane.Axis().Direction();
        const sp = sa.Value(uMid, (v0 + v1) / 2);
        planarFaces.push({
          faceId,
          normal: signNormalize([nn.X(), nn.Y(), nn.Z()]),
          sample: [sp.X(), sp.Y(), sp.Z()],
        });
      } catch { /* skip degenerate / unbounded planes */ }
    }
  }

  // Group by axis line (direction + foot point).
  const groups = new Map<string, Seg[]>();
  const segByFace = new Map<number, Seg>();
  for (const s of segs) {
    segByFace.set(s.faceId, s);
    const key = [...s.dir.map((x) => q(x, 1000)), ...s.foot.map((x) => q(x))].join("|");
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }

  // The top (max-Z) entry ring across a set of faces, with the radius at that end.
  const rimFromFaces = (faceIds: number[]): { center: V3; radius: number } | null => {
    let best: { c: V3; r: number } | null = null;
    for (const fid of faceIds) {
      const s = segByFace.get(fid);
      if (!s) continue;
      const top = topByZ(s.endA, s.endB);
      const r = top === s.endA ? s.rA : s.rB;
      if (!best || top[2] > best.c[2]) best = { c: top, r };
    }
    return best ? { center: best.c, radius: best.r } : null;
  };

  const holes: Hole[] = [];
  for (const g of groups.values()) {
    // Distinct bore levels: OUT cylinders grouped by radius, each spanning ~360°.
    const byR = new Map<string, { r: number; uSum: number; vMax: number; faceIds: number[] }>();
    for (const s of g) {
      if (s.kind !== "cyl" || !s.isOut) continue;
      const k = q(s.r!).toString();
      const e = byR.get(k);
      if (e) {
        e.uSum += s.uSpan;
        e.vMax = Math.max(e.vMax, s.vSpan);
        e.faceIds.push(s.faceId);
      } else {
        byR.set(k, { r: s.r!, uSum: s.uSpan, vMax: s.vSpan, faceIds: [s.faceId] });
      }
    }
    const bores = [...byR.values()].filter((b) => b.uSum >= 1.9 * Math.PI && b.uSum <= 1.1 * TWO_PI);
    if (bores.length === 0) continue;
    bores.sort((a, b) => a.r - b.r);

    // Full cones in this group (an entry countersink).
    const coneSegs = g.filter((s) => s.kind === "cone" && s.uSpan >= 1.9 * Math.PI);

    const main = bores[0];
    const faceIds = [...bores.flatMap((b) => b.faceIds), ...coneSegs.map((c) => c.faceId)];
    const dir = g[0].dir;
    const foot = g[0].foot;

    // Rim: top opening of the widest relevant feature (cbore ring / csk mouth / bore).
    let rimFaces = main.faceIds;
    if (bores.length >= 2) rimFaces = bores[bores.length - 1].faceIds;
    else if (coneSegs.length >= 1) rimFaces = coneSegs.map((c) => c.faceId);
    const rim = rimFromFaces(rimFaces) ?? { center: foot, radius: main.r };

    // Far end: the main-bore end ring farthest from the rim along the axis (the opposite
    // opening for a through hole / the bottom for a blind one).
    let bottom: V3 = rim.center;
    let bestD = -1;
    for (const fid of main.faceIds) {
      const s = segByFace.get(fid);
      if (!s) continue;
      for (const end of [s.endA, s.endB]) {
        const d = Math.hypot(
          end[0] - rim.center[0],
          end[1] - rim.center[1],
          end[2] - rim.center[2],
        );
        if (d > bestD) {
          bestD = d;
          bottom = end;
        }
      }
    }

    // Through vs blind: probe a point just past that far end. Inside the solid (material
    // beyond) ⇒ blind; outside (opens to air) ⇒ through.
    let through = true;
    if (classifier && bestD > 0) {
      const dv = [bottom[0] - rim.center[0], bottom[1] - rim.center[1], bottom[2] - rim.center[2]];
      const dl = Math.hypot(dv[0], dv[1], dv[2]) || 1;
      const eps = Math.max(0.2, main.r * 0.5);
      const tp = new oc.gp_Pnt_3(
        bottom[0] + (dv[0] / dl) * eps,
        bottom[1] + (dv[1] / dl) * eps,
        bottom[2] + (dv[2] / dl) * eps,
      );
      classifier.Perform(tp, 1e-6);
      const st = classifier.State();
      through = (st?.value ?? st) === outVal;
    }

    const hole: Hole = {
      faceIds,
      faceId: main.faceIds[0],
      type: "simple",
      diameter: 2 * main.r,
      depth: main.vMax,
      through,
      axis: dir,
      location: foot,
      rim: { center: rim.center, axis: dir, radius: rim.radius },
      farEnd: { center: bottom, radius: main.r },
    };

    if (bores.length >= 2) {
      const cbore = bores[bores.length - 1];
      hole.type = "counterbore";
      hole.cboreDiameter = 2 * cbore.r;
      hole.cboreDepth = cbore.vMax;
    } else if (coneSegs.length >= 1) {
      const cone = coneSegs[0];
      hole.type = "countersink";
      hole.cskDiameter = 2 * (cone.majorR ?? main.r);
      hole.cskAngleDeg = 2 * (cone.semiAngleDeg ?? 45);
    }
    holes.push(hole);

    // For counterbores, find the flat annular seat (the planar face perpendicular to the
    // axis where the bolt head bears) and include it in faceIds so it gets the same color
    // highlight as the cylindrical bore faces in the model viewer.
    if (hole.type === "counterbore") {
      const ad = hole.axis;
      const rimCen = hole.rim.center;
      const rimAxial = rimCen[0]*ad[0] + rimCen[1]*ad[1] + rimCen[2]*ad[2];
      const farAxial = hole.farEnd.center[0]*ad[0] + hole.farEnd.center[1]*ad[1] + hole.farEnd.center[2]*ad[2];
      const dep = hole.cboreDepth!;
      const cboreR = (hole.cboreDiameter ?? 0) / 2;
      // Axial window: anywhere inside the hole's extents (with a small pad).
      const minAx = Math.min(rimAxial, farAxial) - 0.5;
      const maxAx = Math.max(rimAxial, farAxial) + 0.5;
      const faceSet = new Set(hole.faceIds);
      for (const pf of planarFaces) {
        if (faceSet.has(pf.faceId)) continue;
        // Must be perpendicular to the hole axis.
        const dot = Math.abs(pf.normal[0]*ad[0] + pf.normal[1]*ad[1] + pf.normal[2]*ad[2]);
        if (dot < 0.95) continue;
        // Sample point must be inside the hole's axial span.
        const sAx = pf.sample[0]*ad[0] + pf.sample[1]*ad[1] + pf.sample[2]*ad[2];
        if (sAx < minAx || sAx > maxAx) continue;
        // Sample must sit at approximately cboreDepth from the rim (tolerant to vMax imprecision).
        if (Math.abs(Math.abs(sAx - rimAxial) - dep) > dep * 0.25 + 1.0) continue;
        // Sample must be within the counterbore radius of the axis.
        if (radialDist(pf.sample, hole.location, ad) > cboreR * 1.1 + 1.0) continue;
        hole.faceIds.push(pf.faceId);
        break; // at most one flat seat per counterbore
      }
    }
  }

  const order = { counterbore: 0, countersink: 1, simple: 2 };
  holes.sort((a, b) => order[a.type] - order[b.type] || a.diameter - b.diameter || a.faceId - b.faceId);
  return holes;
}
