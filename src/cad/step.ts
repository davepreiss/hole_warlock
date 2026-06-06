// Load a STEP file with OCCT and tessellate it into a single mesh buffer, while
// recording which OCCT face each triangle belongs to (the triangle->face map that
// makes face picking possible).
//
// The OCCT API names/arities below were validated against this exact build
// (OCCT 7.4) in scripts/probe2.mjs.
import { getOC, ocMessages, type OC } from "./occt";
import { detectHoles, type Hole } from "./holes";

export interface MeshData {
  /** Flat XYZ positions, length = vertexCount * 3. */
  positions: Float32Array;
  /** Triangle vertex indices into `positions`, length = triangleCount * 3. */
  indices: Uint32Array;
  /** Per-triangle face id, length = triangleCount. Values in [0, faceCount). */
  faceIds: Uint32Array;
  /** Number of distinct faces (TopExp_Explorer order). */
  faceCount: number;
  /** Flat XYZ endpoints of model-edge line segments (pairs), for the black-edge overlay. */
  edgePositions: Float32Array;
  /** Per-segment edge id, length = edgePositions.length / 6. Values in [0, edgeCount). */
  edgeSegmentIds: Uint32Array;
  /** Number of distinct (deduplicated) edges. */
  edgeCount: number;
  /** Full cylinder/cone faces, for drawing view-dependent tangent (limb) lines. */
  roundFaces: RoundFace[];
  /** Detected holes (cylindrical through/blind features). */
  holes: Hole[];
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

interface EdgeData {
  positions: Float32Array;
  segmentIds: Uint32Array;
  edgeCount: number;
}

/**
 * A full (≈360°) cylinder or cone face, reduced to its axis segment + end radii. The
 * viewer uses this to draw the two view-dependent tangent/limb lines (the apparent
 * silhouette of the round surface) — the lines a drafter would show, as opposed to the
 * arbitrary parametric seam, which we drop.
 */
export interface RoundFace {
  /** Unit axis direction. */
  axis: [number, number, number];
  /** Centre of the two end rings (feet on the axis). */
  a: [number, number, number];
  b: [number, number, number];
  /** Radius at each end (equal for a cylinder; differ for a cone). */
  ra: number;
  rb: number;
}

const LINEAR_DEFLECTION = 0.1;
const ANGULAR_DEFLECTION = 0.5;
// Edge polyline sampling (radians / absolute) — smaller = smoother curved edges.
const EDGE_ANGULAR_DEFLECTION = 0.2;
const EDGE_CURVATURE_DEFLECTION = 0.2;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Sample a B-rep edge into a flat XYZ polyline, or null if degenerate. */
function sampleEdge(oc: OC, edge: any): number[] | null {
  try {
    const adaptor = new oc.BRepAdaptor_Curve_2(edge);
    const gc = new oc.GCPnts_TangentialDeflection_2(
      adaptor,
      EDGE_ANGULAR_DEFLECTION,
      EDGE_CURVATURE_DEFLECTION,
      2,
      1.0e-9,
      1.0e-7,
    );
    const np = gc.NbPoints();
    if (np < 2) return null;
    const pts: number[] = [];
    for (let i = 1; i <= np; i++) {
      const p = gc.Value(i);
      pts.push(p.X(), p.Y(), p.Z());
    }
    return pts;
  } catch {
    return null; // degenerate edge
  }
}

/** Direction-independent signature of a sampled edge: sorted endpoints + midpoint. */
function edgeSignature(pts: number[]): string {
  const n = pts.length;
  const a = `${round3(pts[0])},${round3(pts[1])},${round3(pts[2])}`;
  const b = `${round3(pts[n - 3])},${round3(pts[n - 2])},${round3(pts[n - 1])}`;
  const mi = Math.floor(n / 6) * 3;
  const mid = `${round3(pts[mi])},${round3(pts[mi + 1])},${round3(pts[mi + 2])}`;
  return (a < b ? a + "|" + b : b + "|" + a) + "|" + mid;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Signatures of edges that should be suppressed from rendering:
 *
 *  1. Parametric SEAM edges of periodic faces (full cylinders/cones): the u-wrap line
 *     is an artifact of the parameterisation, not a real feature.
 *     Detected via BRep_Tool::IsClosed(edge, face).
 *
 *  2. Co-cylindrical TANGENT edges: some CAD exporters (e.g. SolidWorks AP214) split
 *     a full-360° cylinder into two 180° half-faces joined by a real B-rep edge instead
 *     of using a parametric seam. That shared edge is tangent-continuous (the surface is
 *     smooth across it) and must be suppressed just like a seam, otherwise every hole
 *     looks like it has a spurious vertical line down the middle.
 *     Detection: build an edge→adjacentFaces map; if every adjacent face is a cylinder
 *     with the same axis direction and radius, the edge is a false-seam generator line.
 */
function findSeamSignatures(oc: OC, shape: any): Set<string> {
  const seams = new Set<string>();

  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const cylVal =
    oc.GeomAbs_SurfaceType.GeomAbs_Cylinder?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;

  // edge signature → list of cylindrical surface keys for each adjacent face.
  // A "cyl key" encodes the axis direction + quantized radius so we can tell if two
  // faces belong to the same cylinder.  Non-cylindrical faces contribute null.
  const edgeCylFaces = new Map<string, Array<string | null>>();

  const fexp = new oc.TopExp_Explorer_2(shape, FACE, SHAPE);
  for (; fexp.More(); fexp.Next()) {
    const face = oc.TopoDS.Face_1(fexp.Current());

    // Get surface info for this face (null = not cylindrical).
    let cylKey: string | null = null;
    try {
      const sa = new oc.BRepAdaptor_Surface_2(face, false);
      const tv = sa.GetType()?.value ?? sa.GetType();
      if (tv === cylVal) {
        const cyl = sa.Cylinder();
        const r = round2(cyl.Radius());
        const dd = cyl.Axis().Direction();
        // Sign-normalise so opposite-direction cylinders share the same key.
        let dx = dd.X(), dy = dd.Y(), dz = dd.Z();
        const flip =
          dx < -1e-4 ||
          (Math.abs(dx) < 1e-4 && (dy < -1e-4 || (Math.abs(dy) < 1e-4 && dz < 0)));
        if (flip) { dx = -dx; dy = -dy; dz = -dz; }
        cylKey = `${round2(dx)},${round2(dy)},${round2(dz)}|${r}`;
      }
    } catch { /* skip */ }

    const eexp = new oc.TopExp_Explorer_2(face, EDGE, SHAPE);
    for (; eexp.More(); eexp.Next()) {
      const edge = oc.TopoDS.Edge_1(eexp.Current());

      // Pass 1: parametric seam detection (IsClosed_2).
      let closed = false;
      try { closed = oc.BRep_Tool.IsClosed_2(edge, face); } catch { /* older build */ }
      if (closed) {
        const pts = sampleEdge(oc, edge);
        if (pts) seams.add(edgeSignature(pts));
        continue; // already suppressed
      }

      // Pass 2: co-cylindrical tangent edge detection — accumulate face info per edge.
      const pts = sampleEdge(oc, edge);
      if (!pts) continue;
      const sig = edgeSignature(pts);
      const list = edgeCylFaces.get(sig);
      if (list) list.push(cylKey);
      else edgeCylFaces.set(sig, [cylKey]);
    }
    eexp.delete();
  }
  fexp.delete();

  // An edge is a co-cylindrical tangent edge iff every adjacent face is cylindrical
  // with the same axis+radius (cylKey), meaning the surface is smooth across the edge.
  // (Edges with only one adjacent face are boundary edges — never suppress those.)
  for (const [sig, keys] of edgeCylFaces) {
    if (keys.length < 2) continue;
    if (keys[0] !== null && keys.every((k) => k === keys[0])) {
      seams.add(sig);
    }
  }

  return seams;
}

/**
 * Sample every model edge into line segments (true B-rep edges, not mesh-derived).
 * Each topological edge is shared by two faces and so appears twice in the explorer;
 * we deduplicate by a direction-independent signature (sorted endpoints + midpoint)
 * and assign each unique edge a stable id (first-occurrence order) for selection.
 * Degenerate edges (rejected by the curve adaptor) and parametric seam edges of
 * periodic surfaces (see findSeamSignatures) are skipped — the latter so cylinders/
 * cones don't show a spurious line implying a lack of tangency.
 * Validated in scripts/probe_edges.mjs / probe_seam.mjs.
 */
function extractEdges(oc: OC, shape: any): EdgeData {
  const seamSigs = findSeamSignatures(oc, shape);
  const seg: number[] = [];
  const segmentIds: number[] = [];
  const seen = new Map<string, number>();
  let edgeCount = 0;

  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  for (; exp.More(); exp.Next()) {
    const edge = oc.TopoDS.Edge_1(exp.Current());
    const pts = sampleEdge(oc, edge);
    if (!pts) continue;

    const sig = edgeSignature(pts);
    if (seamSigs.has(sig)) continue; // parametric seam — not a real edge
    if (seen.has(sig)) continue; // duplicate occurrence of a shared edge

    const id = edgeCount++;
    seen.set(sig, id);
    const n = pts.length;
    for (let i = 3; i < n; i += 3) {
      seg.push(pts[i - 3], pts[i - 2], pts[i - 1], pts[i], pts[i + 1], pts[i + 2]);
      segmentIds.push(id);
    }
  }
  exp.delete();
  return {
    positions: new Float32Array(seg),
    segmentIds: new Uint32Array(segmentIds),
    edgeCount,
  };
}

/** Foot of the perpendicular from world point p onto the axis line (loc + t·dir). */
function footOnLine(
  p: [number, number, number],
  loc: [number, number, number],
  dir: [number, number, number],
): [number, number, number] {
  const t = (p[0] - loc[0]) * dir[0] + (p[1] - loc[1]) * dir[1] + (p[2] - loc[2]) * dir[2];
  return [loc[0] + dir[0] * t, loc[1] + dir[1] * t, loc[2] + dir[2] * t];
}

/** Radial distance from p to the axis line (loc + t·dir). */
function radialDistToLine(
  p: [number, number, number],
  loc: [number, number, number],
  dir: [number, number, number],
): number {
  const f = footOnLine(p, loc, dir);
  return Math.hypot(p[0] - f[0], p[1] - f[1], p[2] - f[2]);
}

/**
 * Collect every full (≈360°) cylinder/cone face as a RoundFace (axis segment + end
 * radii). Partial faces (fillets, chamfers, rounds) are skipped — their silhouette is
 * already carried by their real B-rep edges, and limb lines there would just clutter.
 * Surface API mirrors detectHoles (scripts/probe_holes.mjs / probe_features.mjs).
 */
function extractRoundFaces(oc: OC, shape: any): RoundFace[] {
  const out: RoundFace[] = [];
  const cylVal =
    oc.GeomAbs_SurfaceType.GeomAbs_Cylinder?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
  const coneVal =
    oc.GeomAbs_SurfaceType.GeomAbs_Cone?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cone;

  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  for (; exp.More(); exp.Next()) {
    let sa: any;
    try {
      sa = new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(exp.Current()), true);
    } catch {
      continue;
    }
    const t = sa.GetType();
    const tv = t?.value ?? t;
    if (tv !== cylVal && tv !== coneVal) continue;

    const u0 = sa.FirstUParameter();
    const u1 = sa.LastUParameter();
    if (u1 - u0 < 1.9 * Math.PI) continue; // only full round faces (had a seam)
    const v0 = sa.FirstVParameter();
    const v1 = sa.LastVParameter();
    const uMid = (u0 + u1) / 2;

    const ax = (tv === cylVal ? sa.Cylinder() : sa.Cone()).Axis();
    const dd = ax.Direction();
    const ll = ax.Location();
    const dl = Math.hypot(dd.X(), dd.Y(), dd.Z()) || 1;
    const dir: [number, number, number] = [dd.X() / dl, dd.Y() / dl, dd.Z() / dl];
    const loc: [number, number, number] = [ll.X(), ll.Y(), ll.Z()];

    const pa = sa.Value(uMid, v0);
    const pb = sa.Value(uMid, v1);
    const pav: [number, number, number] = [pa.X(), pa.Y(), pa.Z()];
    const pbv: [number, number, number] = [pb.X(), pb.Y(), pb.Z()];
    out.push({
      axis: dir,
      a: footOnLine(pav, loc, dir),
      b: footOnLine(pbv, loc, dir),
      ra: radialDistToLine(pav, loc, dir),
      rb: radialDistToLine(pbv, loc, dir),
    });
  }
  exp.delete();
  return out;
}

// Register the STEP norm/controller exactly once. In Node this happens via OCCT's
// static initializers, but in the browser build that registration does not run, so
// STEPControl_Reader.ReadFile returns IFSelect_RetError ("norm not recognized")
// until we call this explicitly. Idempotent (returns true).
let stepControllerInited = false;
function ensureStepController(oc: OC) {
  if (stepControllerInited) return;
  try {
    oc.STEPControl_Controller.Init();
  } catch {
    /* older builds auto-register; ignore */
  }
  stepControllerInited = true;
}

/** Tessellate `shape` into combined buffers + a triangle->face map. */
function meshShape(oc: OC, shape: any): MeshData {
  // Tessellate in place: (shape, linDefl, isRelative, angDefl, isParallel).
  new oc.BRepMesh_IncrementalMesh_2(shape, LINEAR_DEFLECTION, false, ANGULAR_DEFLECTION, false);

  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const REVERSED = oc.TopAbs_Orientation?.TopAbs_REVERSED;
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  let faceId = 0;
  let vertexOffset = 0;
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const loc = new oc.TopLoc_Location_1();
    const handle = oc.BRep_Tool.Triangulation(face, loc);
    if (handle.IsNull()) {
      loc.delete();
      faceId++;
      continue;
    }
    const tri = handle.get();
    const nbNodes = tri.NbNodes();
    // Orientation only affects winding; with DoubleSide material it's cosmetic.
    // This binding may not expose Orientation() on the face wrapper, so guard it.
    const reversed =
      typeof face.Orientation === "function" && face.Orientation() === REVERSED;

    const trsf = loc.Transformation();
    const isId = loc.IsIdentity();
    const nodes = tri.Nodes();
    const nLower = nodes.Lower();
    for (let i = nLower; i <= nodes.Upper(); i++) {
      let p = nodes.Value(i);
      if (!isId) p = p.Transformed(trsf);
      const x = p.X();
      const y = p.Y();
      const z = p.Z();
      positions.push(x, y, z);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }

    const tris = tri.Triangles();
    for (let i = tris.Lower(); i <= tris.Upper(); i++) {
      const t = tris.Value(i);
      // 1-based node indices local to this face's triangulation.
      const a = t.Value(1) - nLower;
      const b = t.Value(2) - nLower;
      const c = t.Value(3) - nLower;
      // Respect face orientation so triangle winding stays outward-facing.
      if (reversed) {
        indices.push(vertexOffset + a, vertexOffset + c, vertexOffset + b);
      } else {
        indices.push(vertexOffset + a, vertexOffset + b, vertexOffset + c);
      }
      faceIds.push(faceId);
    }

    vertexOffset += nbNodes;
    loc.delete();
    faceId++;
  }
  exp.delete();

  if (positions.length === 0) {
    throw new Error("No triangulated faces produced — is this a valid solid STEP file?");
  }

  const edges = extractEdges(oc, shape);
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    faceIds: new Uint32Array(faceIds),
    faceCount: faceId,
    edgePositions: edges.positions,
    edgeSegmentIds: edges.segmentIds,
    edgeCount: edges.edgeCount,
    roundFaces: extractRoundFaces(oc, shape),
    holes: [],
    bbox: { min, max },
  };
}

/** Read STEP bytes into a shape and tessellate. Throws on read failure. */
export async function loadStepToMesh(bytes: Uint8Array): Promise<MeshData> {
  const oc = await getOC();
  ensureStepController(oc);
  // Canonical opencascade.js examples use a bare relative filename under cwd ("/").
  const path = "model.step";
  const msgStart = ocMessages.length;

  oc.FS.writeFile(path, bytes);

  try {
    const reader = new oc.STEPControl_Reader_1();
    const status = reader.ReadFile(path);
    const done = status?.value !== undefined ? status.value : status;
    if (done !== 1) {
      const occtMsgs = ocMessages.slice(msgStart);
      // eslint-disable-next-line no-console
      console.error("[loadStepToMesh] read failed", { status: done, bytes: bytes.length, occtMsgs });
      throw new Error(
        `OCCT could not read this STEP file (status ${done})` +
          (occtMsgs.length ? `: ${occtMsgs.join(" | ")}` : "."),
      );
    }
    reader.TransferRoots();
    const shape = reader.OneShape();
    if (shape.IsNull()) {
      throw new Error("STEP file produced an empty shape.");
    }
    const mesh = meshShape(oc, shape);
    // eslint-disable-next-line no-console
    console.log(
      `[hole-warlock] faces=${mesh.faceCount} edges=${mesh.edgeCount} ` +
        `edgeSegments=${mesh.edgeSegmentIds.length} tris=${mesh.indices.length / 3}`,
    );
    // DEBUG: list vertical edge-segment (x,y) locations actually in the render buffer
    // (in-browser version of scripts/probe_extract.mjs). Fillet tangents should be here.
    const ep = mesh.edgePositions;
    const verts = new Set<string>();
    for (let i = 0; i + 6 <= ep.length; i += 6) {
      const dx = Math.abs(ep[i] - ep[i + 3]);
      const dy = Math.abs(ep[i + 1] - ep[i + 4]);
      const dz = Math.abs(ep[i + 2] - ep[i + 5]);
      if (dx < 1e-3 && dy < 1e-3 && dz > 1) verts.add(`${ep[i].toFixed(2)},${ep[i + 1].toFixed(2)}`);
    }
    // eslint-disable-next-line no-console
    console.log("[hole-warlock] vertical edge (x,y) locations:", [...verts].sort());
    try {
      mesh.holes = detectHoles(oc, shape);
    } catch {
      mesh.holes = []; // hole analysis is best-effort; never block loading
    }
    return mesh;
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      /* ignore */
    }
  }
}
