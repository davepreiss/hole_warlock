// three.js viewer with two modes:
//  - MODEL: shaded part, colored hole groups, click/Shift-click selection, NavCube.
//  - DRAWING: black-and-white "drawing" render (white faces, black edges) with the
//    applied annotations shown as draggable labels connected to their features by
//    ASME-style leader arrows. Leaders track the geometry as the camera orbits.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { MeshData, RoundFace } from "../cad/step";
import type { Target, Annotation, Datum, GdtAnnotation } from "../cad/metadata";
import { NavCube } from "./NavCube";

const COLOR_FACE_BASE = new THREE.Color("#b8c0c8");
const COLOR_EDGE_BASE = new THREE.Color("#111418");
const COLOR_ANNOTATED = new THREE.Color("#f5a623");
const COLOR_SELECTED = new THREE.Color("#2f7bf6");
const BG_MODEL = new THREE.Color("#1e2227");
const BG_DRAWING = new THREE.Color("#ffffff");

/** Imperative API the parent uses to grab a raster of the current drawing view. */
export interface ViewerHandle {
  captureDrawing: (scale?: number) => Promise<{ url: string; w: number; h: number } | null>;
  setSheetZoomCallback: (cb: ((delta: number) => void) | null) => void;
  /** Reset camera roll back to Z-up (the initial orientation). */
  resetRoll: () => void;
}

/** ASME-style leader arrowhead polygon points (screen px), scaled by line weight. */
function arrowPoints(ax: number, ay: number, fromx: number, fromy: number, lineWeight: number): string {
  const dx = ax - fromx;
  const dy = ay - fromy;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  const s = lineWeight / 1.2;
  const len = 11 * s;
  const wid = 3.5 * s;
  const bx = ax - ux * len;
  const by = ay - uy * len;
  const px = -uy;
  const py = ux;
  return `${ax},${ay} ${bx + px * wid},${by + py * wid} ${bx - px * wid},${by - py * wid}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
}

// Scratch vectors reused by the per-frame limb-line update (single-threaded).
const _viewDir = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _perp = new THREE.Vector3();

/**
 * Rewrite a LineSegments buffer with the two silhouette (limb) lines of each full
 * cylinder/cone for the current view — the lines where the round surface is tangent to
 * the view direction. The perpendicular offset is normalize(axis × viewDir); when the
 * camera looks straight down the axis there is no visible limb, so the four vertices
 * collapse to a point (zero-length, invisible).
 */
function writeLimbLines(limbs: THREE.LineSegments, faces: RoundFace[], camera: THREE.Camera) {
  camera.getWorldDirection(_viewDir);
  const attr = limbs.geometry.getAttribute("position") as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  let o = 0;
  for (const f of faces) {
    _ax.set(f.axis[0], f.axis[1], f.axis[2]);
    _perp.crossVectors(_ax, _viewDir);
    const len = _perp.length();
    if (len < 1e-4) {
      for (let s = 0; s < 4; s++) {
        arr[o++] = f.a[0];
        arr[o++] = f.a[1];
        arr[o++] = f.a[2];
      }
      continue;
    }
    const px = _perp.x / len;
    const py = _perp.y / len;
    const pz = _perp.z / len;
    // line 1: a + ra·p -> b + rb·p
    arr[o++] = f.a[0] + px * f.ra;
    arr[o++] = f.a[1] + py * f.ra;
    arr[o++] = f.a[2] + pz * f.ra;
    arr[o++] = f.b[0] + px * f.rb;
    arr[o++] = f.b[1] + py * f.rb;
    arr[o++] = f.b[2] + pz * f.rb;
    // line 2: a - ra·p -> b - rb·p
    arr[o++] = f.a[0] - px * f.ra;
    arr[o++] = f.a[1] - py * f.ra;
    arr[o++] = f.a[2] - pz * f.ra;
    arr[o++] = f.b[0] - px * f.rb;
    arr[o++] = f.b[1] - py * f.rb;
    arr[o++] = f.b[2] - pz * f.rb;
  }
  attr.needsUpdate = true;
}

interface Props {
  mesh: MeshData | null;
  selected: Target[];
  annotatedFaces: Set<number>;
  annotatedEdges: Set<number>;
  highlightFaces: Map<number, string>;
  onPick: (target: Target | null, additive: boolean) => void;
  // Drawing mode:
  drawingMode: boolean;
  xray: boolean;
  /** Drawing line weight (px): drives the fat edge lines + the leader arrowhead size. */
  lineWeight: number;
  annotations: Annotation[];
  /** Per-annotation label offset (screen px) from its projected feature anchor. */
  labelOffsets: Record<string, { dx: number; dy: number }>;
  onMoveLabel: (id: string, dx: number, dy: number) => void;
  /** Both axial end circles for annotations that target a hole — leader anchors on one. */
  rims: Record<
    string,
    { axis: [number, number, number]; ends: { center: [number, number, number]; radius: number }[] }
  >;
  /** Angle (radians) of the leader anchor around the current end ring. */
  anchorAngles: Record<string, number>;
  onMoveAnchor: (id: string, angle: number) => void;
  /** Which axial end (0 = entry, 1 = far) the leader anchors to. */
  anchorEnds: Record<string, number>;
  /** Toggle the anchor to the opposite axial end of the hole. */
  onFlipAnchor: (id: string) => void;
  /** GD&T datum labels to render in drawing mode. */
  datums: Datum[];
  /** GD&T feature control frames to render in drawing mode. */
  gdtAnnotations: GdtAnnotation[];
}

export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(props, ref) {
  const {
    mesh,
    selected,
    annotatedFaces,
    annotatedEdges,
    highlightFaces,
    drawingMode,
    xray,
    lineWeight,
    annotations,
    datums,
  } = props;
  const mountRef = useRef<HTMLDivElement>(null);

  // Persistent three.js objects.
  const rendererRef = useRef<THREE.WebGLRenderer | undefined>(undefined);
  const sceneRef = useRef<THREE.Scene | undefined>(undefined);
  const cameraRef = useRef<THREE.OrthographicCamera | undefined>(undefined);
  const controlsRef = useRef<OrbitControls | undefined>(undefined);
  const viewHalfRef = useRef(100);
  const viewSizeRef = useRef({ w: 1, h: 1 }); // CSS px of the canvas, for export capture
  const navCubeRef = useRef<NavCube | undefined>(undefined);
  const meshRef = useRef<THREE.Mesh | undefined>(undefined);
  const edgesRef = useRef<THREE.LineSegments | undefined>(undefined);
  // Fat (variable-width) copy of the edges used in the Drawing view so the drawing's
  // line weight is adjustable (WebGL's 1px lines can't vary). Thin `edgesRef` stays the
  // model-view object (it carries selection/highlight colors + is what picking hits).
  const fatEdgesRef = useRef<LineSegments2 | undefined>(undefined);
  // View-dependent tangent (limb) lines of full cylinders/cones: the two silhouette
  // lines where the round surface turns away from the camera. Recomputed each frame
  // from the view direction, non-selectable, shown only in x-ray.
  const limbsRef = useRef<THREE.LineSegments | undefined>(undefined);
  const roundFacesRef = useRef<RoundFace[]>([]);
  // Silhouette/contour outline (inverted-hull) for rounded features that have no B-rep
  // edge. A scene object, so it renders on the normal render path — visible in the
  // white Drawing view.
  const outlineRef = useRef<THREE.Mesh | undefined>(undefined);

  // Per-vertex maps + per-feature centroids (for selection + leader anchors).
  const vertexFaceIdRef = useRef<Uint32Array | undefined>(undefined);
  const edgeVertexIdRef = useRef<Uint32Array | undefined>(undefined);
  const edgeSegmentIdsRef = useRef<Uint32Array | undefined>(undefined);
  const faceCentroidRef = useRef<Map<number, THREE.Vector3>>(new Map());
  const edgeCentroidRef = useRef<Map<number, THREE.Vector3>>(new Map());
  const pickThresholdRef = useRef(0.1);

  // Drawing overlay DOM.
  const overlayRef = useRef<HTMLDivElement | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement | undefined>(undefined);
  const labelMapRef = useRef<
    Map<
      string,
      {
        wrap: HTMLDivElement;
        underline: SVGLineElement;
        line: SVGLineElement;
        head: SVGPolygonElement;
        handle: SVGCircleElement;
      }
    >
  >(new Map());
  const liveOffsetsRef = useRef<Record<string, { dx: number; dy: number }>>({});
  const defaultsRef = useRef<Record<string, { dx: number; dy: number }>>({});
  // SVG elements for GD&T datum flags, keyed by id.
  const datumMapRef = useRef<Map<string, { stem: SVGLineElement; triangle: SVGPolygonElement; box: SVGGElement }>>(new Map());
  const liveAnglesRef = useRef<Record<string, number>>({});
  // Ctrl+left-drag rolls the camera around the line-of-sight (the missing third axis).
  const rollDragRef = useRef<{ startX: number; startUp: THREE.Vector3 } | null>(null);
  const dragRef = useRef<
    | { mode: "label"; id: string; sx: number; sy: number; dx: number; dy: number }
    | { mode: "anchor"; id: string; sx: number; sy: number }
    | null
  >(null);
  const rimsRef = useRef(props.rims);
  rimsRef.current = props.rims;

  // Latest props for the rAF loop / handlers.
  const onPickRef = useRef(props.onPick);
  onPickRef.current = props.onPick;
  const onMoveLabelRef = useRef(props.onMoveLabel);
  onMoveLabelRef.current = props.onMoveLabel;
  const onMoveAnchorRef = useRef(props.onMoveAnchor);
  onMoveAnchorRef.current = props.onMoveAnchor;
  const onFlipAnchorRef = useRef(props.onFlipAnchor);
  onFlipAnchorRef.current = props.onFlipAnchor;
  const liveEndsRef = useRef<Record<string, number>>({});
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const datumsRef = useRef(datums);
  datumsRef.current = datums;
  const drawingModeRef = useRef(drawingMode);
  drawingModeRef.current = drawingMode;
  // Callback from App to handle sheet-level zoom (Shift+wheel).
  const sheetZoomCbRef = useRef<((delta: number) => void) | null>(null);
  const lineWeightRef = useRef(lineWeight);
  lineWeightRef.current = lineWeight;

  // Sync incoming offsets/angles into the live maps.
  useEffect(() => {
    liveOffsetsRef.current = { ...liveOffsetsRef.current, ...props.labelOffsets };
  }, [props.labelOffsets]);
  useEffect(() => {
    liveAnglesRef.current = { ...liveAnglesRef.current, ...props.anchorAngles };
  }, [props.anchorAngles]);
  useEffect(() => {
    liveEndsRef.current = { ...liveEndsRef.current, ...props.anchorEnds };
  }, [props.anchorEnds]);

  /** Two orthonormal vectors spanning the plane perpendicular to `axis`. */
  function rimBasis(axis: [number, number, number]) {
    const a = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
    const ref = Math.abs(a.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(a, ref).normalize();
    const v = new THREE.Vector3().crossVectors(a, u).normalize();
    return { u, v };
  }
  /** The currently-anchored end ring of a hole annotation (entry vs far). */
  function rimEnd(id: string): { center: [number, number, number]; radius: number } | null {
    const rim = rimsRef.current[id];
    if (!rim || !rim.ends.length) return null;
    const ei = liveEndsRef.current[id] ?? 0;
    return rim.ends[ei] ?? rim.ends[0];
  }
  function rimPoint(id: string): THREE.Vector3 | null {
    const rim = rimsRef.current[id];
    const end = rimEnd(id);
    if (!rim || !end) return null;
    const { u, v } = rimBasis(rim.axis);
    const ang = liveAnglesRef.current[id] ?? 0;
    return new THREE.Vector3(...end.center)
      .addScaledVector(u, Math.cos(ang) * end.radius)
      .addScaledVector(v, Math.sin(ang) * end.radius);
  }
  /** Leader anchor: a point on the hole rim when available, else the feature centroid. */
  function annAnchor(a: Annotation): THREE.Vector3 | null {
    const rp = rimPoint(a.id);
    if (rp) return rp;
    const acc = new THREE.Vector3();
    let n = 0;
    for (const t of a.targets) {
      const c = t.kind === "face" ? faceCentroidRef.current.get(t.id) : edgeCentroidRef.current.get(t.id);
      if (c) {
        acc.add(c);
        n++;
      }
    }
    return n > 0 ? acc.multiplyScalar(1 / n) : null;
  }

  // Rasterize the current Drawing view (WebGL part + vector leaders/labels) to a PNG.
  async function captureDrawing(scale = 2): Promise<{ url: string; w: number; h: number } | null> {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!renderer || !camera || !drawingModeRef.current) return null;
    const W = viewSizeRef.current.w;
    const H = viewSizeRef.current.h;

    const svgEls: string[] = [];
    for (const a of annotationsRef.current) {
      const entry = labelMapRef.current.get(a.id);
      const anchor = annAnchor(a);
      if (!entry || !anchor) continue;
      const ndc = anchor.clone().project(camera);
      const ax = (ndc.x * 0.5 + 0.5) * W;
      const ay = (-ndc.y * 0.5 + 0.5) * H;
      const off = liveOffsetsRef.current[a.id] ?? defaultsRef.current[a.id] ?? { dx: 80, dy: -50 };
      const lx = ax + off.dx;
      const ly = ay + off.dy;
      const lw = lineWeightRef.current;
      const cs = getComputedStyle(entry.wrap);
      const fs = parseFloat(cs.fontSize) || 12;
      const lh = fs * 1.35;
      const fam = cs.fontFamily || "sans-serif";
      const lines = a.text.toUpperCase().split("\n");
      const textH = lines.length * lh;
      const textW = entry.wrap.offsetWidth;
      // Underline across the label bottom.
      const ulY = ly + textH + 2;
      svgEls.push(
        `<line x1="${lx}" y1="${ulY}" x2="${lx + textW}" y2="${ulY}" stroke="#111" stroke-width="${lw}"/>`,
      );
      // Diagonal from the nearer underline end to the arrowhead.
      const conX2 = Math.abs(ax - lx) < Math.abs(ax - (lx + textW)) ? lx : lx + textW;
      svgEls.push(
        `<line x1="${conX2}" y1="${ulY}" x2="${ax}" y2="${ay}" stroke="#111" stroke-width="${lw}"/>`,
      );
      svgEls.push(`<polygon points="${arrowPoints(ax, ay, conX2, ulY, lw)}" fill="#111"/>`);
      const tspans = lines
        .map((ln, i) => `<tspan x="${lx}" y="${ly + fs + i * lh}">${escapeXml(ln)}</tspan>`)
        .join("");
      svgEls.push(
        `<text fill="#111" font-size="${fs}" font-family="${escapeXml(fam)}">${tspans}</text>`,
      );
    }
    // Datum flags.
    const lw = lineWeightRef.current;
    for (const d of datumsRef.current) {
      const c = d.target.kind === "face"
        ? faceCentroidRef.current.get(d.target.id)
        : edgeCentroidRef.current.get(d.target.id);
      if (!c) continue;
      const ndc = c.clone().project(camera);
      const ax = (ndc.x * 0.5 + 0.5) * W;
      const ay = (-ndc.y * 0.5 + 0.5) * H;
      const stemLen = 18; const apexY = ay - stemLen;
      const tw = 8; const th = 7; const bsz = 14;
      svgEls.push(`<line x1="${ax}" y1="${ay}" x2="${ax}" y2="${apexY}" stroke="#111" stroke-width="${lw}"/>`);
      svgEls.push(`<polygon points="${ax},${apexY} ${ax - tw},${apexY + th} ${ax + tw},${apexY + th}" fill="#111"/>`);
      const bx = ax - bsz / 2; const by = apexY - bsz - 1;
      svgEls.push(`<rect x="${bx}" y="${by}" width="${bsz}" height="${bsz}" fill="white" stroke="#111" stroke-width="${lw}"/>`);
      svgEls.push(`<text x="${ax}" y="${by + 10}" text-anchor="middle" font-size="9" font-family="Helvetica,Arial,sans-serif" font-weight="bold" fill="#111">${escapeXml(d.label)}</text>`);
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgEls.join("")}</svg>`;

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(W * scale));
    out.height = Math.max(1, Math.round(H * scale));
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(renderer.domElement, 0, 0, out.width, out.height);
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, out.width, out.height);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    return { url: out.toDataURL("image/png"), w: W, h: H };
  }
  useImperativeHandle(
    ref,
    () => ({
      captureDrawing,
      setSheetZoomCallback: (cb) => { sheetZoomCbRef.current = cb; },
      resetRoll: () => {
        const cam = cameraRef.current;
        const ctrl = controlsRef.current;
        if (!cam || !ctrl) return;
        cam.up.set(0, 0, 1);
        ctrl.update();
      },
    }),
    [],
  );

  // ---- One-time scene + overlay setup ----
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = BG_MODEL;

    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.01, 1_000_000);
    camera.up.set(0, 0, 1);
    camera.position.set(150, -150, 120);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Left = rotate, right = pan (screen-space), wheel = zoom — in both views.
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    // Suppress the browser context menu so right-drag pans cleanly.
    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    // Shift+wheel zooms the whole sheet (delegated to App via callback); plain wheel
    // zooms the 3D part via OrbitControls as normal. Pan (right-drag) is unaffected.
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey && sheetZoomCbRef.current) {
        e.preventDefault();
        e.stopPropagation();
        sheetZoomCbRef.current(e.deltaY);
      }
      // else: let OrbitControls handle the event (its listener is already on domElement).
    };
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(1, 1, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);

    const navCube = new NavCube(camera, controls);

    // Drawing overlay (labels + leader SVG) above the canvas.
    const overlay = document.createElement("div");
    overlay.className = "draw-overlay";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "draw-svg");
    overlay.appendChild(svg);
    mount.appendChild(overlay);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    navCubeRef.current = navCube;
    overlayRef.current = overlay;
    svgRef.current = svg;

    const sizeRef = { w: 1, h: 1 };
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      sizeRef.w = w;
      sizeRef.h = h;
      viewSizeRef.current = { w, h };
      renderer.setSize(w, h, false);
      // LineMaterial needs the drawing-buffer size to keep pixel line widths correct.
      if (fatEdgesRef.current) {
        (fatEdgesRef.current.material as LineMaterial).resolution.set(
          renderer.domElement.width,
          renderer.domElement.height,
        );
      }
      const aspect = w / h || 1;
      const halfH = viewHalfRef.current;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.left = -halfH * aspect;
      camera.right = halfH * aspect;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // Click-to-pick (skip in drawing mode), ignoring drags.
    const down = new THREE.Vector2();
    const onPointerDown = (e: PointerEvent) => {
      // Ctrl+left-drag rolls the camera — only in drawing mode, so that model-mode
      // Ctrl+click (multi-select) is not intercepted.
      if (e.ctrlKey && e.button === 0 && drawingModeRef.current) {
        controls.enabled = false;
        rollDragRef.current = { startX: e.clientX, startUp: camera.up.clone() };
        return;
      }
      down.set(e.clientX, e.clientY);
    };
    const onPointerUp = (e: PointerEvent) => {
      // If a roll drag is in progress, let onWinUp handle the cleanup.
      if (rollDragRef.current) return;
      if (drawingModeRef.current) return;
      if (e.button !== 0) return; // left-click picks; right-drag is pan
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (navCube.handleClick(e.clientX, e.clientY, rect)) return;
      const m = meshRef.current;
      if (!m) return;
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      // Edge-pick tolerance in SCREEN pixels (converted to world via the ortho frustum),
      // so it doesn't scale with part size — otherwise a small hole's rim edge would
      // swallow the whole face and you could never click the face itself.
      const worldPerPx =
        (camera.top - camera.bottom) / Math.max(1e-6, camera.zoom) / Math.max(1, rect.height);
      const thr = worldPerPx * 5;
      ray.params.Line.threshold = thr;
      const edges = edgesRef.current;
      const edgeHit = edges ? ray.intersectObject(edges, false)[0] : undefined;
      const faceHit = ray.intersectObject(m, false)[0];
      if (
        edgeHit &&
        edgeSegmentIdsRef.current &&
        (!faceHit || edgeHit.distance <= faceHit.distance + thr)
      ) {
        const seg = Math.floor((edgeHit.index ?? 0) / 2);
        onPickRef.current({ kind: "edge", id: edgeSegmentIdsRef.current[seg] }, additive);
        return;
      }
      if (faceHit && vertexFaceIdRef.current) {
        const tri = faceHit.faceIndex ?? 0;
        const idxAttr = (m.geometry as THREE.BufferGeometry).index!;
        const vId = idxAttr.getX(tri * 3);
        onPickRef.current({ kind: "face", id: vertexFaceIdRef.current[vId] }, additive);
        return;
      }
      onPickRef.current(null, additive);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    // Dragging: roll (Ctrl+left), labels (free), or the arrow anchor (constrained to rim).
    const onWinMove = (e: PointerEvent) => {
      if (rollDragRef.current) {
        // Horizontal drag distance → roll angle. 300 px = half turn.
        const dx = e.clientX - rollDragRef.current.startX;
        const rollRad = (dx / 300) * Math.PI;
        const viewDir = new THREE.Vector3()
          .subVectors(camera.position, controls.target)
          .normalize();
        camera.up
          .copy(rollDragRef.current.startUp)
          .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(viewDir, rollRad));
        controls.update();
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "label") {
        liveOffsetsRef.current[d.id] = { dx: d.dx + (e.clientX - d.sx), dy: d.dy + (e.clientY - d.sy) };
        return;
      }
      const rim = rimsRef.current[d.id];
      const end = rimEnd(d.id);
      if (!rim || !end) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { u, v } = rimBasis(rim.axis);
      const center = new THREE.Vector3(...end.center);
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < 72; i++) {
        const ang = (i / 72) * Math.PI * 2;
        const p = center
          .clone()
          .addScaledVector(u, Math.cos(ang) * end.radius)
          .addScaledVector(v, Math.sin(ang) * end.radius)
          .project(camera);
        const sx = (p.x * 0.5 + 0.5) * sizeRef.w;
        const sy = (-p.y * 0.5 + 0.5) * sizeRef.h;
        const dist = (sx - mx) ** 2 + (sy - my) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = ang;
        }
      }
      liveAnglesRef.current[d.id] = best;
    };
    const onWinUp = (e: PointerEvent) => {
      if (rollDragRef.current) {
        controls.enabled = true;
        rollDragRef.current = null;
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "label") {
        const o = liveOffsetsRef.current[d.id];
        onMoveLabelRef.current(d.id, o.dx, o.dy);
      } else {
        const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4;
        if (moved) {
          // A real drag commits the dragged angle on the current end ring.
          onMoveAnchorRef.current(d.id, liveAnglesRef.current[d.id] ?? 0);
        } else {
          // A click (no drag) flips the anchor axially to the hole's opposite end.
          liveEndsRef.current[d.id] = ((liveEndsRef.current[d.id] ?? 0) + 1) % 2;
          onFlipAnchorRef.current(d.id);
        }
      }
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onWinMove);
    window.addEventListener("pointerup", onWinUp);

    const arrow = (ax: number, ay: number, fromx: number, fromy: number): string =>
      arrowPoints(ax, ay, fromx, fromy, lineWeightRef.current);

    let raf = 0;
    const animate = () => {
      controls.update();
      // Tangent/limb lines are view-dependent: refresh them while shown (x-ray).
      const limbs = limbsRef.current;
      if (limbs && limbs.visible && roundFacesRef.current.length) {
        writeLimbLines(limbs, roundFacesRef.current, camera);
      }
      renderer.render(scene, camera);
      // NavCube only in the shaded model view (not the white drawing/B&W views).
      if (!drawingModeRef.current) {
        navCube.update();
        navCube.render(renderer, sizeRef.w, sizeRef.h);
      }
      // Update drawing labels/leaders.
      const overlayEl = overlayRef.current!;
      if (drawingModeRef.current && meshRef.current) {
        overlayEl.style.display = "block";
        const w = sizeRef.w;
        const h = sizeRef.h;
        for (const a of annotationsRef.current) {
          const entry = labelMapRef.current.get(a.id);
          const anchor = annAnchor(a);
          if (!entry || !anchor) continue;
          const ndc = anchor.clone().project(camera);
          const ax = (ndc.x * 0.5 + 0.5) * w;
          const ay = (-ndc.y * 0.5 + 0.5) * h;
          const off = liveOffsetsRef.current[a.id] ?? defaultsRef.current[a.id] ?? { dx: 80, dy: -50 };
          const lx = ax + off.dx;
          const ly = ay + off.dy;
          entry.wrap.style.left = `${lx}px`;
          entry.wrap.style.top = `${ly}px`;
          // Underline leader: a horizontal line across the full label bottom, then a
          // diagonal from whichever end is closer to the anchor down to the arrowhead.
          const bw = entry.wrap.offsetWidth;
          const bh = entry.wrap.offsetHeight;
          const ulY = ly + bh + 2; // just below the text
          const ulX0 = lx;
          const ulX1 = lx + bw;
          entry.underline.setAttribute("x1", `${ulX0}`);
          entry.underline.setAttribute("y1", `${ulY}`);
          entry.underline.setAttribute("x2", `${ulX1}`);
          entry.underline.setAttribute("y2", `${ulY}`);
          // Pick whichever end of the underline is horizontally closer to the anchor.
          const conX = Math.abs(ax - ulX0) < Math.abs(ax - ulX1) ? ulX0 : ulX1;
          const conY = ulY;
          entry.line.setAttribute("x1", `${conX}`);
          entry.line.setAttribute("y1", `${conY}`);
          entry.line.setAttribute("x2", `${ax}`);
          entry.line.setAttribute("y2", `${ay}`);
          entry.head.setAttribute("points", arrow(ax, ay, conX, conY));
          entry.handle.setAttribute("cx", `${ax}`);
          entry.handle.setAttribute("cy", `${ay}`);
          // The rim handle is only grabbable for hole annotations.
          entry.handle.style.display = rimsRef.current[a.id] ? "block" : "none";
        }

        // Update datum flags.
        for (const d of datumsRef.current) {
          const el = datumMapRef.current.get(d.id);
          if (!el) continue;
          const c = d.target.kind === "face"
            ? faceCentroidRef.current.get(d.target.id)
            : edgeCentroidRef.current.get(d.target.id);
          if (!c) continue;
          const ndc = c.clone().project(camera);
          const ax = (ndc.x * 0.5 + 0.5) * w;
          const ay = (-ndc.y * 0.5 + 0.5) * h;
          // Stem: short line up from anchor to triangle apex.
          const stemLen = 18;
          const apexY = ay - stemLen;
          el.stem.setAttribute("x1", `${ax}`); el.stem.setAttribute("y1", `${ay}`);
          el.stem.setAttribute("x2", `${ax}`); el.stem.setAttribute("y2", `${apexY}`);
          // Triangle: apex at top, base below.
          const tw = 8; const th = 7;
          el.triangle.setAttribute("points",
            `${ax},${apexY} ${ax - tw},${apexY + th} ${ax + tw},${apexY + th}`);
          // Square box above triangle.
          const bsz = 14;
          el.box.setAttribute("transform", `translate(${ax - bsz / 2},${apexY - bsz - 1})`);
        }

      } else {
        overlayEl.style.display = "none";
      }
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onWinMove);
      window.removeEventListener("pointerup", onWinUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      navCube.dispose();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      mount.removeChild(overlay);
    };
  }, []);

  // ---- Rebuild geometry when the mesh changes ----
  useEffect(() => {
    const scene = sceneRef.current!;
    const camera = cameraRef.current!;
    const controls = controlsRef.current!;

    if (meshRef.current) {
      scene.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = undefined;
      vertexFaceIdRef.current = undefined;
    }
    if (edgesRef.current) {
      scene.remove(edgesRef.current);
      edgesRef.current.geometry.dispose();
      (edgesRef.current.material as THREE.Material).dispose();
      edgesRef.current = undefined;
      edgeVertexIdRef.current = undefined;
      edgeSegmentIdsRef.current = undefined;
    }
    if (fatEdgesRef.current) {
      scene.remove(fatEdgesRef.current);
      fatEdgesRef.current.geometry.dispose();
      (fatEdgesRef.current.material as THREE.Material).dispose();
      fatEdgesRef.current = undefined;
    }
    if (limbsRef.current) {
      scene.remove(limbsRef.current);
      limbsRef.current.geometry.dispose();
      (limbsRef.current.material as THREE.Material).dispose();
      limbsRef.current = undefined;
    }
    roundFacesRef.current = [];
    if (outlineRef.current) {
      scene.remove(outlineRef.current);
      (outlineRef.current.material as THREE.Material).dispose();
      outlineRef.current = undefined;
    }
    faceCentroidRef.current = new Map();
    edgeCentroidRef.current = new Map();
    if (!mesh) return;

    // --- Faces ---
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geom.computeVertexNormals();

    const vertexCount = mesh.positions.length / 3;
    const vfi = new Uint32Array(vertexCount);
    const fAcc = new Map<number, { v: THREE.Vector3; n: number }>();
    for (let t = 0; t < mesh.faceIds.length; t++) {
      const f = mesh.faceIds[t];
      for (let k = 0; k < 3; k++) {
        const vId = mesh.indices[t * 3 + k];
        vfi[vId] = f;
        const e = fAcc.get(f) ?? { v: new THREE.Vector3(), n: 0 };
        e.v.x += mesh.positions[vId * 3];
        e.v.y += mesh.positions[vId * 3 + 1];
        e.v.z += mesh.positions[vId * 3 + 2];
        e.n++;
        fAcc.set(f, e);
      }
    }
    for (const [f, e] of fAcc) faceCentroidRef.current.set(f, e.v.multiplyScalar(1 / e.n));
    vertexFaceIdRef.current = vfi;
    geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.1,
      roughness: 0.75,
      side: THREE.DoubleSide,
      // Small offset so faces don't z-fight coplanar edges; edge renderOrder does the
      // heavy lifting. Too large would let hidden edges poke through.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const m = new THREE.Mesh(geom, material);
    scene.add(m);
    meshRef.current = m;

    // Inverted-hull silhouette: a slightly inflated copy of the faces rendered BackSide
    // and dark, so it peeks out only at the apparent contour of rounded features (which
    // have no B-rep edge). Visible only in the white views; toggled in applyDrawingStyle.
    const ext = Math.max(
      mesh.bbox.max[0] - mesh.bbox.min[0],
      mesh.bbox.max[1] - mesh.bbox.min[1],
      mesh.bbox.max[2] - mesh.bbox.min[2],
      1,
    );
    const outlineMat = new THREE.ShaderMaterial({
      // Small extrusion so the dark rim hugs the real edge (a larger value pushes the
      // rim outward => a visible second line beside the B-rep edge + a white gap at the
      // fillet base where the normal direction breaks).
      uniforms: { width: { value: ext * 0.0018 } },
      vertexShader: `
        uniform float width;
        void main() {
          vec3 p = position + normalize(normal) * width;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `void main() { gl_FragColor = vec4(0.067, 0.067, 0.067, 1.0); }`,
      side: THREE.BackSide,
      // No depth write + draw before the faces: the faces then paint over the hull's
      // interior, leaving only the true silhouette rim (avoids it smearing over faces).
      depthWrite: false,
    });
    const outline = new THREE.Mesh(geom, outlineMat);
    outline.renderOrder = -1;
    outline.visible = drawingModeRef.current;
    scene.add(outline);
    outlineRef.current = outline;

    // --- Edges ---
    if (mesh.edgePositions.length > 0) {
      const edgeVertexCount = mesh.edgePositions.length / 3;
      const evi = new Uint32Array(edgeVertexCount);
      const eAcc = new Map<number, { v: THREE.Vector3; n: number }>();
      for (let v = 0; v < edgeVertexCount; v++) {
        const eid = mesh.edgeSegmentIds[Math.floor(v / 2)];
        evi[v] = eid;
        const e = eAcc.get(eid) ?? { v: new THREE.Vector3(), n: 0 };
        e.v.x += mesh.edgePositions[v * 3];
        e.v.y += mesh.edgePositions[v * 3 + 1];
        e.v.z += mesh.edgePositions[v * 3 + 2];
        e.n++;
        eAcc.set(eid, e);
      }
      for (const [eid, e] of eAcc) edgeCentroidRef.current.set(eid, e.v.multiplyScalar(1 / e.n));
      edgeVertexIdRef.current = evi;
      edgeSegmentIdsRef.current = mesh.edgeSegmentIds;

      const edgeGeom = new THREE.BufferGeometry();
      edgeGeom.setAttribute("position", new THREE.BufferAttribute(mesh.edgePositions, 3));
      edgeGeom.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(edgeVertexCount * 3), 3),
      );
      const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true });
      const lines = new THREE.LineSegments(edgeGeom, edgeMat);
      // Draw edges AFTER faces so coplanar/tangent edges (fillet blends) always win
      // the depth test instead of being overwritten by the white face.
      lines.renderOrder = 1;
      scene.add(lines);
      edgesRef.current = lines;

      // Fat (variable-width) copy for the Drawing view. Same segments, uniform black;
      // width = line weight (px). Shown only in drawing mode (see applyDrawingStyle).
      const fatGeom = new LineSegmentsGeometry();
      fatGeom.setPositions(mesh.edgePositions as unknown as number[]);
      const dom = rendererRef.current!.domElement;
      const fatMat = new LineMaterial({
        color: 0x111111,
        linewidth: lineWeightRef.current,
        worldUnits: false, // linewidth in screen pixels
        transparent: true,
      });
      fatMat.resolution.set(dom.width, dom.height);
      const fatLines = new LineSegments2(fatGeom, fatMat);
      fatLines.renderOrder = 1;
      fatLines.frustumCulled = false;
      fatLines.visible = drawingModeRef.current;
      scene.add(fatLines);
      fatEdgesRef.current = fatLines;
    }

    // --- Tangent (limb) lines of full cylinders/cones (x-ray only) ---
    // Two silhouette lines per round face, recomputed each frame from the view (see the
    // animate loop). Non-selectable; depthTest off so they read through x-ray faces.
    roundFacesRef.current = mesh.roundFaces;
    if (mesh.roundFaces.length > 0) {
      const limbGeom = new THREE.BufferGeometry();
      // 2 segments (4 vertices) per round face.
      const buf = new THREE.BufferAttribute(new Float32Array(mesh.roundFaces.length * 12), 3);
      buf.setUsage(THREE.DynamicDrawUsage);
      limbGeom.setAttribute("position", buf);
      const limbMat = new THREE.LineBasicMaterial({
        color: 0x8a929c,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
      const limbs = new THREE.LineSegments(limbGeom, limbMat);
      limbs.renderOrder = 3;
      limbs.frustumCulled = false; // positions are rewritten each frame
      limbs.visible = false; // toggled on only in x-ray (see the x-ray effect)
      scene.add(limbs);
      limbsRef.current = limbs;
      writeLimbLines(limbs, mesh.roundFaces, camera); // seed before first paint
    }

    // Frame the part.
    const { min, max } = mesh.bbox;
    const center = new THREE.Vector3(
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    );
    const radius = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
    pickThresholdRef.current = radius * 0.012;
    controls.target.copy(center);
    const dist = radius * 4;
    camera.position.copy(center).add(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(dist));
    camera.near = 0.01;
    camera.far = dist + radius * 10;
    camera.zoom = 1;
    viewHalfRef.current = radius * 0.75;
    const aspect =
      (rendererRef.current?.domElement.width ?? 1) / (rendererRef.current?.domElement.height ?? 1) || 1;
    camera.top = viewHalfRef.current;
    camera.bottom = -viewHalfRef.current;
    camera.left = -viewHalfRef.current * aspect;
    camera.right = viewHalfRef.current * aspect;
    camera.updateProjectionMatrix();
    controls.update();
    applyDrawingStyle(drawingModeRef.current);
  }, [mesh]);

  // ---- Drawing (flat white) vs shaded model styling ----
  function applyDrawingStyle(drawing: boolean) {
    const scene = sceneRef.current;
    const m = meshRef.current;
    const edges = edgesRef.current;
    if (!scene) return;
    scene.background = drawing ? BG_DRAWING : BG_MODEL;
    if (outlineRef.current) outlineRef.current.visible = drawing && !xray;
    if (m) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.vertexColors = !drawing;
      mat.color.set(0xffffff);
      mat.emissive.set(drawing ? 0xffffff : 0x000000);
      // Depth/occlusion must be IDENTICAL to model mode — drawing is just model mode
      // recolored white. The old drawing-only bump to units 4 was a large constant
      // depth bias that, on thin (plate/sheet) parts, shoved front faces behind the
      // back wall so back features showed through ("see-through"). Keep the modest
      // offset the material was built with (factor 1, units 1) in both modes.
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 1;
      mat.polygonOffsetUnits = 1;
      mat.needsUpdate = true;
    }
    if (edges) {
      const em = edges.material as THREE.LineBasicMaterial;
      em.vertexColors = !drawing;
      em.color.set(drawing ? 0x111111 : 0xffffff);
      em.depthTest = true;
      em.needsUpdate = true;
      edges.renderOrder = 1;
      // Drawing view uses the fat (variable-weight) edges; model view uses the thin,
      // per-vertex-colored edges (selection/highlight + picking).
      edges.visible = !drawing;
    }
    if (fatEdgesRef.current) fatEdgesRef.current.visible = drawing;
  }
  useEffect(() => {
    applyDrawingStyle(drawingMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingMode]);

  // ---- X-ray: faces transparent + non-occluding so every edge shows ----
  useEffect(() => {
    const m = meshRef.current;
    if (m) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.transparent = xray;
      mat.opacity = xray ? 0.12 : 1;
      // Always write depth: in x-ray this lets the faint faces still occlude the
      // inverted hull's interior, so only its silhouette rim shows (not a filled blob).
      mat.depthWrite = true;
      mat.needsUpdate = true;
    }
    // X-ray shows every edge regardless of occlusion. Since faces now write depth,
    // edges must ignore depth there or the hidden ones would be culled.
    const edges = edgesRef.current;
    if (edges) {
      const em = edges.material as THREE.LineBasicMaterial;
      em.depthTest = !xray;
      em.needsUpdate = true;
    }
    if (fatEdgesRef.current) {
      const fm = fatEdgesRef.current.material as LineMaterial;
      fm.depthTest = !xray;
      fm.needsUpdate = true;
    }
    // Cylinder/cone tangent (limb) lines are shown only in x-ray.
    if (limbsRef.current) limbsRef.current.visible = xray;
    // Contour is visible in both drawing sub-modes. In x-ray the faces are transparent,
    // so the hull must draw AFTER them (transparent pass + higher renderOrder) and
    // depth-test against them to be trimmed to its rim; in normal drawing it draws first
    // and is simply painted over by the opaque faces.
    const o = outlineRef.current;
    if (o) {
      // Hide the hull in x-ray mode. The transparent face mesh has no per-triangle
      // depth sort, so the dark hull interior bleeds through at varying zoom levels.
      // Limb lines already cover rounded-edge silhouettes in x-ray mode.
      o.visible = drawingMode && !xray;
      const om = o.material as THREE.ShaderMaterial;
      om.transparent = false;
      om.needsUpdate = true;
      o.renderOrder = -1;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xray, mesh, drawingMode]);

  // ---- Drawing line weight: fat edge width (arrowheads scale via lineWeightRef) ----
  useEffect(() => {
    if (fatEdgesRef.current) {
      (fatEdgesRef.current.material as LineMaterial).linewidth = lineWeight;
    }
  }, [lineWeight, mesh]);

  /**
   * Batch-compute default label placements for a set of new annotations so that:
   *  - Every label is at the same distance from the part's screen bbox edge.
   *  - Labels are spread angularly so they don't stack when holes are close together.
   *
   * Algorithm:
   *  1. Project the 8 bbox corners → screen AABB, find its centre + half-extents.
   *  2. For each annotation, project its anchor → natural angle from the centre.
   *  3. Sort by angle; apply iterative minimum-separation spreading
   *     (push pairs that are too close apart, then re-centre the group).
   *  4. For each spread angle, compute the distance to the bbox edge in that direction
   *     and add a uniform margin — every label lands at the same gap from the bbox.
   *  5. Return offset (dx, dy) = label position − anchor screen position.
   */
  function computeBatchPlacements(
    items: Array<{ id: string; anchorWorld: THREE.Vector3 }>,
  ): Record<string, { dx: number; dy: number }> {
    const camera = cameraRef.current;
    const bbox = mesh?.bbox;
    const { w, h } = viewSizeRef.current;
    const MARGIN = 48;   // px gap between bbox edge and the label
    const MIN_SEP_DEG = 24; // minimum angular separation between labels (degrees)
    const MIN_SEP = (MIN_SEP_DEG * Math.PI) / 180;

    // Fallback if camera/bbox not ready yet.
    if (!camera || !bbox || items.length === 0) {
      const result: Record<string, { dx: number; dy: number }> = {};
      items.forEach(({ id }, i) => {
        const ang = (i / Math.max(1, items.length)) * Math.PI * 2;
        result[id] = { dx: Math.cos(ang) * 110, dy: Math.sin(ang) * 90 };
      });
      return result;
    }

    // 1. Project bbox corners → screen AABB.
    const { min, max } = bbox;
    let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity;
    for (let ix = 0; ix < 2; ix++) for (let iy = 0; iy < 2; iy++) for (let iz = 0; iz < 2; iz++) {
      const p = new THREE.Vector3(
        ix ? max[0] : min[0], iy ? max[1] : min[1], iz ? max[2] : min[2],
      ).project(camera);
      const sx = (p.x * 0.5 + 0.5) * w;
      const sy = (-p.y * 0.5 + 0.5) * h;
      sxMin = Math.min(sxMin, sx); sxMax = Math.max(sxMax, sx);
      syMin = Math.min(syMin, sy); syMax = Math.max(syMax, sy);
    }
    const PAD = 6;
    sxMin -= PAD; sxMax += PAD; syMin -= PAD; syMax += PAD;
    const cx = (sxMin + sxMax) / 2;
    const cy = (syMin + syMax) / 2;
    const hw = (sxMax - sxMin) / 2;
    const hh = (syMax - syMin) / 2;

    // 2. Project each anchor to screen and compute its natural angle.
    const entries = items.map(({ id, anchorWorld }) => {
      const ndc = anchorWorld.clone().project(camera);
      const ax = (ndc.x * 0.5 + 0.5) * w;
      const ay = (-ndc.y * 0.5 + 0.5) * h;
      return { id, ax, ay, angle: Math.atan2(ay - cy, ax - cx) };
    });

    // 3. Sort by angle, then spread to enforce minimum separation.
    entries.sort((a, b) => a.angle - b.angle);
    const spread = entries.map((e) => e.angle);
    const n = spread.length;

    if (n * MIN_SEP >= 2 * Math.PI) {
      // Not enough room to space naturally — distribute evenly around the full circle.
      for (let i = 0; i < n; i++) spread[i] = spread[0] + (i / n) * 2 * Math.PI;
    } else {
      // Forward pass: ensure each angle is at least MIN_SEP past the previous.
      for (let i = 1; i < n; i++) {
        if (spread[i] - spread[i - 1] < MIN_SEP) spread[i] = spread[i - 1] + MIN_SEP;
      }
      // Re-centre: the forward pass may have shifted the group; nudge everything
      // back so the group stays centred around the original mean angle.
      const origMean = entries.reduce((s, e) => s + e.angle, 0) / n;
      const newMean = spread.reduce((s, a) => s + a, 0) / n;
      const drift = newMean - origMean;
      for (let i = 0; i < n; i++) spread[i] -= drift;
    }

    // 4. Place each label at bbox-edge + MARGIN along its spread angle.
    const result: Record<string, { dx: number; dy: number }> = {};
    entries.forEach(({ id, ax, ay }, i) => {
      const angle = spread[i];
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      // Distance from centre to bbox edge in direction (cosA, sinA).
      const tX = Math.abs(cosA) > 1e-9 ? hw / Math.abs(cosA) : Infinity;
      const tY = Math.abs(sinA) > 1e-9 ? hh / Math.abs(sinA) : Infinity;
      const R = Math.min(tX, tY) + MARGIN;
      result[id] = { dx: cx + cosA * R - ax, dy: cy + sinA * R - ay };
    });
    return result;
  }

  // ---- Build/refresh drawing labels when annotations change ----
  useEffect(() => {
    const overlay = overlayRef.current;
    const svg = svgRef.current;
    if (!overlay || !svg) return;
    // Clear old.
    labelMapRef.current.forEach((e) => {
      e.wrap.remove();
      e.underline.remove();
      e.line.remove();
      e.head.remove();
      e.handle.remove();
    });
    labelMapRef.current.clear();

    // Batch-compute placements for all annotations that don't yet have a saved default.
    const needsPlacement = annotations.filter((a) => !defaultsRef.current[a.id]);
    if (needsPlacement.length > 0) {
      const items = needsPlacement.flatMap((a) => {
        const anchor = annAnchor(a);
        return anchor ? [{ id: a.id, anchorWorld: anchor }] : [];
      });
      const placements = computeBatchPlacements(items);
      Object.assign(defaultsRef.current, placements);
    }

    annotations.forEach((a) => {
      // The leader is an underline style (like the reference PDF): a horizontal line
      // spanning the full label width sits at the bottom of the text, and a diagonal
      // line goes from one end of that underline to the arrowhead at the feature anchor.
      const underline = document.createElementNS("http://www.w3.org/2000/svg", "line");
      underline.setAttribute("class", "draw-leader");
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "draw-leader");
      const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      head.setAttribute("class", "draw-arrow");
      const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      handle.setAttribute("class", "draw-arrow-handle");
      handle.setAttribute("r", "9");
      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        dragRef.current = { mode: "anchor", id: a.id, sx: e.clientX, sy: e.clientY };
      });
      svg.appendChild(underline);
      svg.appendChild(line);
      svg.appendChild(head);
      svg.appendChild(handle);

      const wrap = document.createElement("div");
      wrap.className = "draw-label";
      wrap.textContent = a.text;
      wrap.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const off = liveOffsetsRef.current[a.id] ?? defaultsRef.current[a.id] ?? { dx: 80, dy: -50 };
        dragRef.current = { mode: "label", id: a.id, sx: e.clientX, sy: e.clientY, dx: off.dx, dy: off.dy };
      });
      overlay.appendChild(wrap);

      // Default was computed in the batch above; nothing extra needed here.
      labelMapRef.current.set(a.id, { wrap, underline, line, head, handle });
    });
  }, [annotations]);

  // ---- Datum flags (SVG triangular flag + stem + label box) ----
  useEffect(() => {
    const svg = svgRef.current;
    const overlay = overlayRef.current;
    if (!svg || !overlay) return;
    datumMapRef.current.forEach((e) => {
      e.stem.remove(); e.triangle.remove(); e.box.remove();
    });
    datumMapRef.current.clear();
    const lw = lineWeightRef.current;
    datums.forEach((d) => {
      const stem = document.createElementNS("http://www.w3.org/2000/svg", "line");
      stem.setAttribute("class", "draw-leader");
      const triangle = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      triangle.setAttribute("fill", "#111");
      const box = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("width", "14"); rect.setAttribute("height", "14");
      rect.setAttribute("fill", "none"); rect.setAttribute("stroke", "#111");
      rect.setAttribute("stroke-width", String(lw));
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", "7"); text.setAttribute("y", "10.5");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-size", "9");
      text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
      text.setAttribute("font-weight", "bold");
      text.setAttribute("fill", "#111");
      text.textContent = d.label;
      box.appendChild(rect); box.appendChild(text);
      svg.appendChild(stem); svg.appendChild(triangle); svg.appendChild(box);
      datumMapRef.current.set(d.id, { stem, triangle, box });
    });
  }, [datums]);


  // ---- Recolor (model mode only matters; harmless in drawing) ----
  useEffect(() => {
    const selFaces = new Set(selected.filter((t) => t.kind === "face").map((t) => t.id));
    const selEdges = new Set(selected.filter((t) => t.kind === "edge").map((t) => t.id));
    const highlight = new Map<number, THREE.Color>();
    highlightFaces.forEach((hex, fid) => highlight.set(fid, new THREE.Color(hex)));

    const m = meshRef.current;
    const vfi = vertexFaceIdRef.current;
    if (m && vfi) {
      const colorAttr = (m.geometry as THREE.BufferGeometry).getAttribute("color") as THREE.BufferAttribute;
      for (let v = 0; v < vfi.length; v++) {
        const f = vfi[v];
        const c = selFaces.has(f)
          ? COLOR_SELECTED
          : highlight.get(f) ?? (annotatedFaces.has(f) ? COLOR_ANNOTATED : COLOR_FACE_BASE);
        colorAttr.setXYZ(v, c.r, c.g, c.b);
      }
      colorAttr.needsUpdate = true;
    }
    const edges = edgesRef.current;
    const evi = edgeVertexIdRef.current;
    if (edges && evi) {
      const colorAttr = (edges.geometry as THREE.BufferGeometry).getAttribute("color") as THREE.BufferAttribute;
      for (let v = 0; v < evi.length; v++) {
        const eid = evi[v];
        const c = selEdges.has(eid)
          ? COLOR_SELECTED
          : annotatedEdges.has(eid)
            ? COLOR_ANNOTATED
            : COLOR_EDGE_BASE;
        colorAttr.setXYZ(v, c.r, c.g, c.b);
      }
      colorAttr.needsUpdate = true;
    }
  }, [mesh, selected, annotatedFaces, annotatedEdges, highlightFaces]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%", position: "relative" }} />;
});
