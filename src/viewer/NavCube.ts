// A small orientation cube ("NavCube") drawn in a corner of the main viewport.
// It mirrors the main camera's orientation as the user orbits, and clicking it
// animates the main camera to look down a world direction:
//   - click a face   -> straight-on view (±X / ±Y / ±Z)
//   - click an edge  -> 45° view between two faces
//   - click a corner -> isometric view
//
// The cube is a chamfered cube (flat unlit facets + rendered black edges) whose
// corner chamfers are ~2x the edge chamfers. World is Z-up.
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export const NAVCUBE_PX = 112;
export const NAVCUBE_MARGIN = 10;

// How deep the edge bevels and corner facets cut. The corner cut is ~2x the edge
// cut, so corner chamfers read about twice as large (see scripts/check-navcube.mjs).
const EDGE_CHAMFER = 0.12;
const CORNER_CHAMFER = 0.22;
// A hit coordinate beyond ZONE marks that axis "active": 1 active = face, 2 = edge,
// 3 = corner. Sits inside the octagon face extent (1 - EDGE_CHAMFER).
const ZONE = 0.72;

/**
 * A chamfered cube with independent edge and corner chamfers: 6 octagonal faces,
 * 12 flat edge bevels, 8 triangular corner facets. Built as the convex hull of the
 * vertices that keep one coordinate at ±1 while the other two take {a, a-cc} in
 * both orders (chamfering each square face's corners).
 */
function chamferedCubeGeometry(): THREE.BufferGeometry {
  const a = 1 - EDGE_CHAMFER;
  const b = a - CORNER_CHAMFER;
  const pts: THREE.Vector3[] = [];
  for (const s of [-1, 1]) {
    for (const [u, w] of [
      [a, b],
      [b, a],
    ]) {
      for (const su of [-1, 1]) {
        for (const sw of [-1, 1]) {
          pts.push(new THREE.Vector3(s, su * u, sw * w)); // ±X face
          pts.push(new THREE.Vector3(su * u, s, sw * w)); // ±Y face
          pts.push(new THREE.Vector3(su * u, sw * w, s)); // ±Z face
        }
      }
    }
  }
  return new ConvexGeometry(pts);
}

function labelTexture(text: string): THREE.Texture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  // Transparent background (no tile/border — only the glyphs are drawn), so nothing
  // but the text appears on the face. A soft light glow keeps it legible on gray.
  // Fixed font so every label is the same letter size (longest word "FRONT"/"RIGHT" fits).
  ctx.font = "bold 70px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(255,255,255,0.85)";
  ctx.shadowBlur = 7;
  ctx.fillStyle = "#23282f";
  ctx.fillText(text, s / 2, s / 2);
  ctx.fillText(text, s / 2, s / 2); // second pass to strengthen the glow
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  return tex;
}

/** A flat label plane on the face with outward normal `n` and up direction `up`. */
function makeFaceLabel(text: string, n: THREE.Vector3, up: THREE.Vector3): THREE.Mesh {
  const size = (1 - EDGE_CHAMFER) * 1.5;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: labelTexture(text), transparent: true }),
  );
  // Orient: local +Z -> outward normal, local +Y -> up (keeps text upright, unmirrored).
  const xAxis = new THREE.Vector3().crossVectors(up, n);
  const basis = new THREE.Matrix4().makeBasis(xAxis, up, n);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.copy(n).multiplyScalar(1.002);
  return mesh;
}

export class NavCube {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private cube: THREE.Mesh;
  private readonly camDist = 3.4;

  private tween:
    | { from: THREE.Vector3; to: THREE.Vector3; fromUp: THREE.Vector3; toUp: THREE.Vector3; t: number }
    | null = null;
  private lastTime = performance.now();

  constructor(
    private mainCamera: THREE.Camera,
    private controls: OrbitControls,
  ) {
    this.camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 100);

    const geom = chamferedCubeGeometry();
    // Flat, unlit material (no shading).
    this.cube = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xd7dce2 }));
    this.scene.add(this.cube);

    // Softened gray edges along the chamfer boundaries (thinner via reduced opacity;
    // WebGL line width is fixed at 1px on most platforms, so opacity approximates it).
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom, 12),
      new THREE.LineBasicMaterial({ color: 0x9aa2ac, transparent: true, opacity: 0.8, linewidth: 0.75 }),
    );
    this.cube.add(edges);

    // Readable labels on all six faces (sides upright relative to +Z "top").
    const X = new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    this.cube.add(makeFaceLabel("TOP", Z, Y));
    this.cube.add(makeFaceLabel("BOT", Z.clone().negate(), Y));
    this.cube.add(makeFaceLabel("FRONT", Y.clone().negate(), Z));
    this.cube.add(makeFaceLabel("BACK", Y, Z));
    this.cube.add(makeFaceLabel("RIGHT", X, Z));
    this.cube.add(makeFaceLabel("LEFT", X.clone().negate(), Z));
  }

  /** Sync the cube camera to the main camera's view direction; advance any tween. */
  update() {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / 0.35);
      const e = easeInOut(this.tween.t);
      const dist = this.mainCamera.position.distanceTo(this.controls.target);
      const dir = new THREE.Vector3().lerpVectors(this.tween.from, this.tween.to, e).normalize();
      this.mainCamera.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.mainCamera.up.lerpVectors(this.tween.fromUp, this.tween.toUp, e).normalize();
      this.controls.update();
      if (this.tween.t >= 1) this.tween = null;
    }

    const viewDir = new THREE.Vector3()
      .subVectors(this.mainCamera.position, this.controls.target)
      .normalize();
    this.camera.position.copy(viewDir).multiplyScalar(this.camDist);
    this.camera.up.copy(this.mainCamera.up);
    this.camera.lookAt(0, 0, 0);
  }

  /**
   * Render into the top-right corner of a renderer sized (w, h) device-independent px.
   * Assumes the main scene has already been rendered (which cleared the buffers).
   */
  render(renderer: THREE.WebGLRenderer, w: number, h: number) {
    const dpr = renderer.getPixelRatio();
    const size = NAVCUBE_PX * dpr;
    const x = (w - NAVCUBE_PX - NAVCUBE_MARGIN) * dpr;
    const y = (h - NAVCUBE_PX - NAVCUBE_MARGIN) * dpr; // gl viewport origin is bottom-left
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setViewport(x, y, size, size);
    renderer.setScissor(x, y, size, size);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w * dpr, h * dpr);
    renderer.autoClear = prevAutoClear;
  }

  /**
   * If (clientX, clientY) is inside the cube's corner region, raycast it and start
   * a camera tween to the picked face/edge/corner. Returns true if consumed.
   */
  handleClick(clientX: number, clientY: number, rect: DOMRect): boolean {
    const regionLeft = rect.right - NAVCUBE_PX - NAVCUBE_MARGIN;
    const regionTop = rect.top + NAVCUBE_MARGIN;
    const inside =
      clientX >= regionLeft &&
      clientX <= rect.right - NAVCUBE_MARGIN &&
      clientY >= regionTop &&
      clientY <= regionTop + NAVCUBE_PX;
    if (!inside) return false;

    const lx = (clientX - regionLeft) / NAVCUBE_PX;
    const ly = (clientY - regionTop) / NAVCUBE_PX;
    const ndc = new THREE.Vector2(lx * 2 - 1, -(ly * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.cube, false)[0];
    if (!hit) return true; // inside region but missed the cube — still consume

    const p = hit.point;
    const axis = (v: number) => (v > ZONE ? 1 : v < -ZONE ? -1 : 0);
    const dir = new THREE.Vector3(axis(p.x), axis(p.y), axis(p.z));
    if (dir.lengthSq() === 0) return true;
    this.orientTo(dir);
    return true;
  }

  private orientTo(dir: THREE.Vector3) {
    const to = dir.clone().normalize();
    const from = new THREE.Vector3()
      .subVectors(this.mainCamera.position, this.controls.target)
      .normalize();
    const up = Math.abs(to.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    this.tween = { from, to, fromUp: this.mainCamera.up.clone(), toUp: up, t: 0 };
  }

  dispose() {
    this.cube.geometry.dispose();
    (this.cube.material as THREE.Material).dispose();
    this.cube.children.forEach((ch) => {
      const mesh = ch as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat?.map?.dispose();
      mat?.dispose();
    });
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
