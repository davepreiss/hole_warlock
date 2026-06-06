// Two-parameter chamfered cube: each face stays at ±1 but its square (half-extent
// a = 1-e) has its corners chamfered by cc. Off-axis coords take {a, b=a-cc} in both
// orders. Measure facet counts + corner-vs-edge size, tune e/cc.
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

const e = +(process.argv[2] ?? 0.12); // edge chamfer
const cc = +(process.argv[3] ?? 0.3); // extra corner cut
const a = 1 - e;
const b = a - cc;
console.log({ e, cc, a, b });

const pts = [];
for (const s of [-1, 1]) {
  for (const u of [a, b]) {
    for (const w of [a, b]) {
      if (u === w) continue; // only the (a,b)/(b,a) pairs form the octagon corners
      for (const su of [-1, 1]) {
        for (const sw of [-1, 1]) {
          pts.push(new THREE.Vector3(s, su * u, sw * w)); // +-X face
          pts.push(new THREE.Vector3(su * u, s, sw * w)); // +-Y face
          pts.push(new THREE.Vector3(su * u, sw * w, s)); // +-Z face
        }
      }
    }
  }
}
const geom = new ConvexGeometry(pts);
const pos = geom.getAttribute("position");

const groups = new Map();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
for (let i = 0; i < pos.count; i += 3) {
  vA.fromBufferAttribute(pos, i);
  vB.fromBufferAttribute(pos, i + 1);
  vC.fromBufferAttribute(pos, i + 2);
  ab.subVectors(vB, vA);
  ac.subVectors(vC, vA);
  n.crossVectors(ab, ac).normalize();
  const key = [n.x, n.y, n.z].map((v) => Math.round(v * 100) / 100).join(",");
  const grp = groups.get(key) || { verts: [] };
  grp.verts.push(vA.clone(), vB.clone(), vC.clone());
  groups.set(key, grp);
}
const classify = (key) => {
  const c = key.split(",").map(Number);
  const big = c.filter((v) => Math.abs(v) > 0.99).length;
  if (big === 1) return "face";
  if (c.every((v) => Math.abs(Math.abs(v) - 0.577) < 0.08)) return "corner";
  return "edge";
};
// Characteristic extent of a facet = max pairwise vertex distance.
const extent = (verts) => {
  let mx = 0;
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++) mx = Math.max(mx, verts[i].distanceTo(verts[j]));
  return mx;
};
const byKind = { face: [], edge: [], corner: [] };
for (const [key, grp] of groups) byKind[classify(key)].push(grp.verts);
const avg = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0);
console.log("facets:", groups.size, "counts:", {
  face: byKind.face.length, edge: byKind.edge.length, corner: byKind.corner.length,
});
console.log("cut depth — edge:", e.toFixed(3), " corner:", cc.toFixed(3), " corner/edge:", (cc / e).toFixed(2));

// Validate the picking zones: classify each facet's centroid with ZONE.
const ZONE = 0.72;
const active = (v) => (Math.abs(v) > ZONE ? 1 : 0);
let ok = true;
for (const [key, grp] of groups) {
  const cen = grp.verts.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(grp.verts.length);
  const n = active(cen.x) + active(cen.y) + active(cen.z);
  const want = { face: 1, edge: 2, corner: 3 }[classify(key)];
  if (n !== want) {
    ok = false;
    console.log("  ZONE MISCLASSIFY", classify(key), key, "active axes:", n, "want", want);
  }
}
console.log("picking zones ok at ZONE=" + ZONE + ":", ok);
