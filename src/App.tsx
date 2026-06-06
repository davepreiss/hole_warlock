import { useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import { Viewer, type ViewerHandle } from "./viewer/Viewer";
import { loadStepToMesh, type MeshData } from "./cad/step";
import type { Hole } from "./cad/holes";
import { describeHole, defaultCallout, dia, diaU, confidentTap, type UnitSystem, type HoleCategory, type HoleDesc } from "./cad/taps";
import {
  emptyMetadata,
  extractMetadata,
  embedMetadata,
  hasTarget,
  type Metadata,
  type Annotation,
  type Target,
  type PartMeta,
} from "./cad/metadata";

interface Loaded {
  fileName: string;
  /** Original STEP text — geometry preserved verbatim; we only re-embed our block. */
  stepText: string;
  mesh: MeshData;
  meta: Metadata;
  /**
   * File System Access handle to the source file, when the file was opened via the
   * picker in a supporting browser (Chrome/Edge). Lets us overwrite in place.
   */
  handle?: FileSystemFileHandle;
}



// DEBUG: auto-load the demo part on startup. Set to false to disable.
const AUTOLOAD_DEMO = true;

// Product / project name shown in the header and the drawing title block.
const APP_NAME = "Hole Warlock";
const DEFAULT_NOTE = "";

// ---- Shared drawing-sheet layout (ANSI B, points). Used by BOTH the live preview
// (as a scaled SVG) and the PDF export, so the two stay identical. ----
const SHEET = { W: 1224, H: 792, mo: 14, mf: 30, tbW: 300, tbH: 76, pad: 8 };
const TB_X = SHEET.W - SHEET.mf - SHEET.tbW;
const TB_Y = SHEET.H - SHEET.mf - SHEET.tbH;
// Drawing area (where the part view goes), as fractions of the sheet.
const DRAW_AREA = {
  x: SHEET.mf + SHEET.pad,
  y: SHEET.mf + SHEET.pad,
  w: SHEET.W - SHEET.mf - SHEET.pad - (SHEET.mf + SHEET.pad),
  h: TB_Y - SHEET.pad - (SHEET.mf + SHEET.pad),
};
const DRAW_PCT = {
  left: `${(DRAW_AREA.x / SHEET.W) * 100}%`,
  top: `${(DRAW_AREA.y / SHEET.H) * 100}%`,
  width: `${(DRAW_AREA.w / SHEET.W) * 100}%`,
  height: `${(DRAW_AREA.h / SHEET.H) * 100}%`,
};

const _measCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
function measureW(text: string, fontPx: number, bold = false): number {
  const ctx = _measCanvas?.getContext("2d");
  if (!ctx) return text.length * fontPx * 0.5;
  ctx.font = `${bold ? "bold " : ""}${fontPx}px Helvetica, Arial, sans-serif`;
  return ctx.measureText(text).width;
}
function wrapText(text: string, maxW: number, fontPx: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (measureW(test, fontPx) > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Build the sheet chrome (border, zones, title block, material/finish, note) as SVG
 *  inner markup in 1224×792 coordinates — mirrors the PDF in onExportPdf exactly. */
function buildSheetChromeSvg(part: PartMeta, noteText: string): string {
  const { W, H, mo, mf, tbW, tbH } = SHEET;
  const E: string[] = [];
  const rect = (x: number, y: number, w: number, h: number, sw: number) =>
    E.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#111" stroke-width="${sw}"/>`);
  const ln = (x1: number, y1: number, x2: number, y2: number, sw = 0.75) =>
    E.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="${sw}"/>`);
  const tx = (
    s: string,
    x: number,
    y: number,
    size: number,
    o: { bold?: boolean; anchor?: string; gray?: number } = {},
  ) => {
    const g = o.gray ?? 30;
    E.push(
      `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" ` +
        `font-weight="${o.bold ? "bold" : "normal"}" text-anchor="${o.anchor ?? "start"}" ` +
        `fill="rgb(${g},${g},${g})">${esc(s)}</text>`,
    );
  };

  rect(mo, mo, W - 2 * mo, H - 2 * mo, 0.75);
  rect(mf, mf, W - 2 * mf, H - 2 * mf, 1);
  const cols = 8;
  const rows = 4;
  const cw = (W - 2 * mf) / cols;
  const rh = (H - 2 * mf) / rows;
  for (let i = 0; i < cols; i++) {
    const cx = mf + i * cw + cw / 2;
    tx(String(cols - i), cx, mo + (mf - mo) / 2 + 3, 7, { anchor: "middle", gray: 90 });
    tx(String(cols - i), cx, H - mo - (mf - mo) / 2 + 4, 7, { anchor: "middle", gray: 90 });
    if (i > 0) {
      const x = mf + i * cw;
      ln(x, mo, x, mf, 0.5);
      ln(x, H - mf, x, H - mo, 0.5);
    }
  }
  ["D", "C", "B", "A"].forEach((L, j) => {
    const cy = mf + j * rh + rh / 2 + 3;
    tx(L, mo + (mf - mo) / 2, cy, 7, { anchor: "middle", gray: 90 });
    tx(L, W - mo - (mf - mo) / 2, cy, 7, { anchor: "middle", gray: 90 });
    if (j > 0) {
      const y = mf + j * rh;
      ln(mo, y, mf, y, 0.5);
      ln(W - mf, y, W - mo, y, 0.5);
    }
  });

  // Title block.
  const hasRev = !!part.rev?.trim();
  rect(TB_X, TB_Y, tbW, tbH, 0.9);
  const r1 = TB_Y + 26;
  const r2 = TB_Y + 50;
  ln(TB_X, r1, TB_X + tbW, r1);
  ln(TB_X, r2, TB_X + tbW, r2);
  tx("TITLE:", TB_X + 6, TB_Y + 9, 6.5, { bold: true, gray: 110 });
  tx((part.name || "").toUpperCase(), TB_X + tbW / 2, TB_Y + 21, 11, { bold: true, anchor: "middle", gray: 20 });
  const sizeW = 40;
  const revW = hasRev ? 44 : 0;
  ln(TB_X + sizeW, r1, TB_X + sizeW, r2);
  if (hasRev) ln(TB_X + tbW - revW, r1, TB_X + tbW - revW, r2);
  tx("SIZE", TB_X + 6, r1 + 9, 6, { bold: true, gray: 110 });
  tx("B", TB_X + sizeW / 2, r1 + 20, 12, { bold: true, anchor: "middle", gray: 20 });
  tx("PART NUMBER:", TB_X + sizeW + 6, r1 + 9, 6, { bold: true, gray: 110 });
  tx(part.number || "", TB_X + sizeW + (tbW - sizeW - revW) / 2, r1 + 20, 10, { bold: true, anchor: "middle", gray: 20 });
  if (hasRev) {
    tx("REV:", TB_X + tbW - revW + 6, r1 + 9, 6, { bold: true, gray: 110 });
    tx(part.rev!.trim(), TB_X + tbW - revW / 2, r1 + 20, 10, { bold: true, anchor: "middle", gray: 20 });
  }
  ln(TB_X + tbW / 2, r2, TB_X + tbW / 2, TB_Y + tbH);
  tx("SCALE:", TB_X + 6, r2 + 14, 6.5, { bold: true, gray: 110 });
  tx("NTS", TB_X + 44, r2 + 14, 8, { gray: 30 });
  tx("SHEET 1 OF 1", TB_X + tbW / 2 + 8, r2 + 14, 7, { bold: true, gray: 40 });

  // Material / finish.
  const hasMat = !!part.material?.trim();
  const hasFin = !!part.finish?.trim();
  if (hasMat || hasFin) {
    const pW = 150;
    const pX = TB_X - pW;
    rect(pX, TB_Y, pW, tbH, 0.9);
    if (hasMat && hasFin) ln(pX, TB_Y + tbH / 2, pX + pW, TB_Y + tbH / 2);
    if (hasMat) {
      tx("MATERIAL:", pX + 5, TB_Y + 12, 6, { bold: true, gray: 110 });
      tx(part.material!.trim().toUpperCase(), pX + 5, TB_Y + 26, 8, { gray: 25 });
    }
    const fy = hasMat ? TB_Y + tbH / 2 : TB_Y;
    if (hasFin) {
      tx("FINISH:", pX + 5, fy + 12, 6, { bold: true, gray: 110 });
      tx(part.finish!.trim().toUpperCase(), pX + 5, fy + 26, 8, { gray: 25 });
    }
  }

  // Note + X.X pill.
  if (noteText) {
    const nx = mf + 12;
    let ny = mf + 20;
    tx("NOTES:", nx, ny, 8.5, { bold: true, gray: 25 });
    ny += 14;
    wrapText(noteText, 380, 7.5).forEach((line, li) => {
      tx(line, nx, ny + li * 10, 7.5, { gray: 45 });
      const c = line.indexOf("X.X");
      if (c >= 0) {
        const px = nx + measureW(line.slice(0, c), 7.5);
        const tw = measureW("X.X", 7.5);
        E.push(
          `<rect x="${px - 2.4}" y="${ny + li * 10 - 6.8}" width="${tw + 4.8}" height="9.5" rx="4.75" ry="4.75" fill="none" stroke="#111" stroke-width="0.6"/>`,
        );
      }
    });
  }
  return E.join("");
}

// Per-group color. A muted, professional categorical palette — Tableau 10
// (Maureen Stone), with its pink/coral removed — ordered for separation between
// successive groups. (Okabe–Ito is the colorblind-safe alternative.)
const HOLE_COLORS = [
  "#4e79a7", // steel blue
  "#f28e2b", // orange
  "#59a14f", // green
  "#b8443c", // brick red
  "#76b7b2", // teal
  "#edc948", // gold
  "#9c755f", // brown
  "#6b7785", // slate
];
const holeColor = (i: number) => HOLE_COLORS[i % HOLE_COLORS.length];

/** Feather-style eye / eye-off icon for the per-annotation hide toggle. */
function EyeIcon({ off }: { off: boolean }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return off ? (
    <svg {...common} aria-hidden>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg {...common} aria-hidden>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.28 0 .32.21.7.82.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

export default function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Multi-selection of faces/edges. Plain click replaces; Shift/Ctrl/Cmd toggles.
  const [selected, setSelected] = useState<Target[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [partOpen, setPartOpen] = useState(true);
  const [holesOpen, setHolesOpen] = useState(true);
  const [tableOpen, setTableOpen] = useState(true);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const [gdtOpen, setGdtOpen] = useState(true);
  // GD&T inline-form state.
  const [datumDraft, setDatumDraft] = useState("");
  // Engineer (model) vs manufacturer (drawing) view.
  const [viewMode, setViewMode] = useState<"model" | "drawing">("model");
  const switchView = (mode: "model" | "drawing") => {
    setViewMode(mode);
    if (mode === "model") setSheetScale(1);
  };
  // DEBUG: X-ray (transparent, non-occluding faces) to inspect every edge.
  const [xray, setXray] = useState(false);
  // Per-annotation drawing-label offset (screen px) from its feature anchor.
  const [labelOffsets, setLabelOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  // Per-annotation angle (radians) of its leader anchor around a hole rim.
  const [anchorAngles, setAnchorAngles] = useState<Record<string, number>>({});
  // Per-annotation which axial end of the hole the leader anchors to (0 = entry, 1 = far).
  const [anchorEnds, setAnchorEnds] = useState<Record<string, number>>({});
  // Drawing aesthetics (bottom panel): annotation label size (px) and leader weight.
  const [fontSize, setFontSize] = useState(12);
  const [lineWeight, setLineWeight] = useState(1.2);
  // Include the hole/callout table in the exported drawing PDF.
  const viewerRef = useRef<ViewerHandle>(null);
  // Register the sheet-zoom callback whenever the viewer mounts / mode changes.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    if (viewMode === "drawing") {
      v.setSheetZoomCallback((delta) =>
        setSheetScale((s) => Math.min(4, Math.max(0.3, s * (delta < 0 ? 1.1 : 1 / 1.1)))),
      );
    } else {
      v.setSheetZoomCallback(null);
    }
    return () => v.setSheetZoomCallback(null);
  }, [viewMode, viewerRef.current]); // eslint-disable-line react-hooks/exhaustive-deps
  // Letterbox the drawing sheet: measure the viewport, fit the ANSI-B aspect inside it.
  // sheetScale lets the user zoom the whole sheet (scroll outside the drawing area).
  const viewportRef = useRef<HTMLDivElement>(null);
  const [sheetFit, setSheetFit] = useState<{ w: number; h: number } | null>(null);
  const [sheetScale, setSheetScale] = useState(1);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const compute = () => {
      const k = Math.min((el.clientWidth - 32) / SHEET.W, (el.clientHeight - 32) / SHEET.H);
      setSheetFit(k > 0 ? { w: SHEET.W * k, h: SHEET.H * k } : null);
    };
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    compute();
    return () => ro.disconnect();
  }, []);
  // Multi-selected annotation ids (drives the row highlight + batch delete).
  const [selectedAnnotations, setSelectedAnnotations] = useState<Set<string>>(new Set());
  // Per-group editable callout text (keyed by group key). Absent => generated default.
  const [holeDrafts, setHoleDrafts] = useState<Record<string, string>>({});
  // Per-group pill category override. Only set when user manually corrects a mis-classification.
  const [holePillOverrides, setHolePillOverrides] = useState<Record<string, HoleCategory>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function flash(msg: string) {
    setInfo(msg);
    window.setTimeout(() => setInfo((cur) => (cur === msg ? null : cur)), 6000);
  }

  const sameT = (a: Target, b: Target) => a.kind === b.kind && a.id === b.id;
  const isSelected = (t: Target) => selected.some((s) => sameT(s, t));

  /** Select a set of targets. additive => toggle them into/out of the selection. */
  function pickTargets(targets: Target[], additive: boolean) {
    setSelected((prev) => {
      if (!additive) return targets;
      const next = [...prev];
      for (const t of targets) {
        const i = next.findIndex((s) => sameT(s, t));
        if (i >= 0) next.splice(i, 1);
        else next.push(t);
      }
      return next;
    });
  }

  // Maps every bore face ID → all face IDs of that hole. When a hole is split into
  // multiple faces (e.g. SolidWorks AP214 180° half-cylinders), clicking any half
  // selects the whole bore instead of just the clicked face.
  const faceToHoleFaces = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const h of (loaded?.mesh.holes ?? [])) {
      for (const id of h.faceIds) m.set(id, h.faceIds);
    }
    return m;
  }, [loaded]);

  /** Viewer click handler: one target (or null for empty space) + modifier state. */
  function onPickTarget(target: Target | null, additive: boolean) {
    if (!target) {
      if (!additive) setSelected([]);
      return;
    }
    // Expand a cylindrical bore face to all faces of that hole so multi-face holes
    // (e.g. SolidWorks 180° split cylinders) always select as a complete unit.
    if (target.kind === "face") {
      const allFaceIds = faceToHoleFaces.get(target.id);
      if (allFaceIds && allFaceIds.length > 1) {
        pickTargets(allFaceIds.map((id) => ({ kind: "face" as const, id })), additive);
        return;
      }
    }
    pickTargets([target], additive);
  }

  // DEBUG: load the demo part once on startup (guarded against StrictMode double-run).
  const didAutoload = useRef(false);
  useEffect(() => {
    if (AUTOLOAD_DEMO && !didAutoload.current) {
      didAutoload.current = true;
      void onLoadDemo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unit system is a part-level detail stored with material/finish (defaults metric).
  const unit: UnitSystem = loaded?.meta.part.units ?? "metric";

  // Sheet chrome (border/title block/note) for the WYSIWYG drawing preview — built from
  // the same layout the PDF uses so the preview matches the export.
  const sheetChrome = useMemo(
    () => (loaded ? buildSheetChromeSvg(loaded.meta.part, (loaded.meta.part.note ?? DEFAULT_NOTE).trim()) : ""),
    [loaded],
  );

  // Annotations actually drawn (not hidden). Drives the viewer labels + highlights;
  // the sidebar list still shows every annotation so hidden ones can be toggled back.
  const visibleAnnotations = useMemo(
    () => (loaded?.meta.annotations ?? []).filter((a) => !a.hidden),
    [loaded],
  );

  const visibleDatums = useMemo(
    () => (loaded?.meta.datums ?? []).filter((d) => !d.hidden),
    [loaded],
  );
  const annotatedFaces = useMemo(() => {
    const s = new Set<number>();
    visibleAnnotations.forEach((a) => a.targets.filter((t) => t.kind === "face").forEach((t) => s.add(t.id)));
    visibleDatums.forEach((d) => { if (d.target.kind === "face") s.add(d.target.id); });
    return s;
  }, [visibleAnnotations, visibleDatums]);

  const annotatedEdges = useMemo(() => {
    const s = new Set<number>();
    visibleAnnotations.forEach((a) => a.targets.filter((t) => t.kind === "edge").forEach((t) => s.add(t.id)));
    visibleDatums.forEach((d) => { if (d.target.kind === "edge") s.add(d.target.id); });
    return s;
  }, [visibleAnnotations, visibleDatums]);

  // Automatic group signature: entry feature + diameter + length + the distinct planar
  // face (axis direction AND offset along it) + through/blind. So holes on different
  // faces, of different lengths, or different end conditions group separately by default.
  function autoHoleKey(h: Hole): string {
    const extra = (h.cboreDiameter ?? h.cskDiameter ?? 0).toFixed(2);
    const axis = h.axis.map((v) => Math.round(v * 1000) / 1000).join(",");
    const offset = Math.round(
      h.rim.center[0] * h.axis[0] + h.rim.center[1] * h.axis[1] + h.rim.center[2] * h.axis[2],
    );
    const end = h.through ? "thru" : "blind";
    return `${h.type}|${h.diameter.toFixed(2)}|${extra}|${h.depth.toFixed(1)}|${axis}|${offset}|${end}`;
  }

  // Holes grouped by their effective key: a manual override group id if the hole is in
  // one (meta.holeGroups), else the automatic signature. Each group gets a color + desc.
  const holeGroups = useMemo(() => {
    const holes = loaded?.mesh.holes ?? [];
    const overrideOf = new Map<number, string>();
    for (const og of loaded?.meta.holeGroups ?? [])
      for (const hid of og.holeIds) overrideOf.set(hid, og.id);

    const byKey = new Map<string, Hole[]>();
    for (const h of holes) {
      const k = overrideOf.get(h.faceId) ?? autoHoleKey(h);
      const g = byKey.get(k);
      if (g) g.push(h);
      else byKey.set(k, [h]);
    }
    const typeOrder = { counterbore: 0, countersink: 1, simple: 2 };
    return [...byKey.entries()]
      .map(([key, hs]) => ({
        key,
        custom: key.startsWith("ovr-"),
        type: hs[0].type,
        diameter: hs[0].diameter,
        holes: hs,
        desc: describeHole(hs[0], unit),
      }))
      .sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || a.diameter - b.diameter)
      .map((g, i) => ({ ...g, color: holeColor(i) }));
  }, [loaded, unit]);

  // Stable human-friendly number for each hole (1-based, by detection order).
  const holeNumbers = useMemo(() => {
    const m = new Map<number, number>();
    (loaded?.mesh.holes ?? []).forEach((h, i) => h.faceIds.forEach((id) => m.set(id, i + 1)));
    return m;
  }, [loaded]);

  // Both axial end circles for each annotation that targets a hole (entry + far end),
  // so the drawing leader can anchor on either opening.
  const holeRims = useMemo(() => {
    type Rim = {
      axis: [number, number, number];
      ends: { center: [number, number, number]; radius: number }[];
    };
    const map: Record<string, Rim> = {};
    if (!loaded) return map;
    const faceToHole = new Map<number, Hole>();
    for (const h of loaded.mesh.holes) for (const f of h.faceIds) faceToHole.set(f, h);
    for (const a of loaded.meta.annotations) {
      for (const t of a.targets) {
        if (t.kind === "face" && faceToHole.has(t.id)) {
          const h = faceToHole.get(t.id)!;
          map[a.id] = {
            axis: h.rim.axis,
            ends: [
              { center: h.rim.center, radius: h.rim.radius },
              { center: h.farEnd.center, radius: h.farEnd.radius },
            ],
          };
          break;
        }
      }
    }
    return map;
  }, [loaded]);

  // When the Holes panel is open, light up each group's faces with its color.
  const highlightFaces = useMemo(() => {
    const map = new Map<number, string>();
    if (holesOpen) {
      for (const g of holeGroups) for (const h of g.holes) for (const f of h.faceIds) map.set(f, g.color);
    }
    // Also highlight the hovered group from the floating table overlay.
    if (hoveredGroup) {
      const g = holeGroups.find((g) => g.key === hoveredGroup);
      if (g) for (const h of g.holes) for (const f of h.faceIds) map.set(f, g.color);
    }
    return map;
  }, [holesOpen, holeGroups, hoveredGroup]);

  /** Resolved hole description: user pill override takes precedence over auto-detection. */
  function effectiveDesc(key: string, hole: Hole): HoleDesc {
    const auto = describeHole(hole, unit);
    const cat = holePillOverrides[key];
    if (!cat || cat === auto.category) return auto;
    if (cat === "hole") return { category: "hole", pill: `${diaU(hole.diameter, unit)} HOLE`, thread: null };
    if (cat === "tap") {
      const tap = confidentTap(hole.diameter, unit);
      return tap ? { category: "tap", pill: `${tap.name} TAP`, thread: tap } : { category: "tap", pill: "TAP", thread: null };
    }
    return auto;
  }

  /** Toggle between tap and hole pill for a simple hole. */
  function togglePill(key: string, currentCat: HoleCategory) {
    const next: HoleCategory = currentCat === "tap" ? "hole" : "tap";
    setHolePillOverrides((o) => ({ ...o, [key]: next }));
    // If the user hasn't written a custom callout, clear the draft so the new default regenerates.
    setHoleDrafts((d) => {
      if (d[key] === undefined) return d;
      const { [key]: _, ...rest } = d;
      return rest;
    });
  }

  // The editable callout text for a group (user edit, else the generated default).
  function calloutFor(key: string, holes: Hole[]): string {
    if (holeDrafts[key] !== undefined) return holeDrafts[key];
    const h0 = holes[0];
    const eff = effectiveDesc(key, h0);
    const auto = describeHole(h0, unit);
    if (eff.category !== auto.category) {
      const qty = holes.length;
      const q = qty > 1 ? `${qty}X ` : "";
      const drill = `${q}${diaU(h0.diameter, unit)} THRU ALL`;
      if (eff.category === "hole") return drill;
      if (eff.category === "tap" && eff.thread) {
        const tol = unit === "imperial" ? "2B" : "6H";
        return `${drill}\n${eff.thread.label.split("×")[0]} - ${tol} THRU ALL`;
      }
    }
    return defaultCallout(h0, holes.length, unit);
  }

  // One annotation linked to every hole/feature in the group.
  function annotateHoles(key: string, holes: Hole[]) {
    const text = calloutFor(key, holes);
    const targets: Target[] = holes.flatMap((h) => h.faceIds.map((id) => ({ kind: "face" as const, id })));
    updateMeta((m) => {
      const ids = new Set(targets.map((t) => t.id));
      const others = m.annotations.filter(
        (a) => !a.targets.some((t) => t.kind === "face" && ids.has(t.id)),
      );
      const ann: Annotation = { id: "a-grp-" + key, targets, text };
      return { ...m, annotations: [...others, ann] };
    });
    flash(`Annotated ${holes.length} hole(s) as one callout`);
  }

  /** Apply one callout annotation to every hole group in a single pass. */
  function annotateAllGroups(showFlash = true) {
    if (holeGroups.length === 0) return;
    updateMeta((m) => {
      let annotations = m.annotations;
      for (const g of holeGroups) {
        const targets: Target[] = g.holes.flatMap((h) =>
          h.faceIds.map((id) => ({ kind: "face" as const, id })),
        );
        const ids = new Set(targets.map((t) => t.id));
        annotations = annotations.filter(
          (a) => !a.targets.some((t) => t.kind === "face" && ids.has(t.id)),
        );
        annotations = [...annotations, { id: "a-grp-" + g.key, targets, text: calloutFor(g.key, g.holes) }];
      }
      return { ...m, annotations };
    });
    if (showFlash) flash(`Annotated all ${holeGroups.length} hole group(s)`);
  }

  /** Remove the given holes from every existing override group (pruning empties). */
  function withoutHoles(groups: { id: string; holeIds: number[] }[], ids: Set<number>) {
    return groups
      .map((g) => ({ ...g, holeIds: g.holeIds.filter((h) => !ids.has(h)) }))
      .filter((g) => g.holeIds.length > 0);
  }

  /** Force the given holes (bore faceIds) into one new manual group. */
  function groupHoles(holeIds: number[]) {
    if (holeIds.length === 0) return;
    const ids = new Set(holeIds);
    updateMeta((m) => {
      const kept = withoutHoles(m.holeGroups ?? [], ids);
      const id = "ovr-" + crypto.randomUUID().slice(0, 8);
      return { ...m, holeGroups: [...kept, { id, holeIds: [...ids] }] };
    });
    flash(`Split ${ids.size} hole(s) into a group`);
  }

  /** Put each given hole into its own one-hole group (fully explode a group). */
  function splitIndividual(holeIds: number[]) {
    if (holeIds.length === 0) return;
    const ids = new Set(holeIds);
    updateMeta((m) => {
      const kept = withoutHoles(m.holeGroups ?? [], ids);
      const indiv = [...ids].map((h) => ({ id: "ovr-" + crypto.randomUUID().slice(0, 8), holeIds: [h] }));
      return { ...m, holeGroups: [...kept, ...indiv] };
    });
    flash(`Split into ${ids.size} individual hole(s)`);
  }

  /** Drop the given holes from any manual group (back to automatic grouping). */
  function ungroupHoles(holeIds: number[]) {
    if (holeIds.length === 0) return;
    const ids = new Set(holeIds);
    updateMeta((m) => ({ ...m, holeGroups: withoutHoles(m.holeGroups ?? [], ids) }));
    flash(`Reset ${ids.size} hole(s) to automatic grouping`);
  }

  async function ingest(
    fileName: string,
    buf: ArrayBuffer,
    handle?: FileSystemFileHandle,
    partDefaults?: Partial<import("./cad/metadata").PartMeta>,
  ) {
    setError(null);
    setBusy("Loading CAD kernel & reading geometry…");
    setSelected([]);
    setSelectedAnnotations(new Set());
    try {
      const bytes = new Uint8Array(buf);
      const stepText = new TextDecoder("utf-8").decode(bytes);
      const found = extractMetadata(stepText);
      const meta = found ?? emptyMetadata();
      if (!found && partDefaults) meta.part = { ...meta.part, ...partDefaults };
      const mesh = await loadStepToMesh(bytes);
      // Seed the drawing-layout maps from any persisted per-annotation placement, and
      // clear stale entries from a previously-loaded part.
      const lo: Record<string, { dx: number; dy: number }> = {};
      const aa: Record<string, number> = {};
      const ae: Record<string, number> = {};
      for (const a of meta.annotations) {
        if (a.label) lo[a.id] = a.label;
        if (a.anchorAngle !== undefined) aa[a.id] = a.anchorAngle;
        if (a.anchorEnd !== undefined) ae[a.id] = a.anchorEnd;
      }
      setLabelOffsets(lo);
      setAnchorAngles(aa);
      setAnchorEnds(ae);
      setLoaded({ fileName, stepText, mesh, meta, handle });
      flash(
        found
          ? `Loaded "${fileName}" — ${meta.annotations.length} annotation(s) found in file`
          : `Loaded "${fileName}" — no embedded metadata (new part)`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(null);
    } finally {
      setBusy(null);
    }
  }

  function onOpen() {
    fileInputRef.current?.click();
  }

  function onDragOver(e: React.DragEvent) {
    const hasStep = [...(e.dataTransfer.items ?? [])].some(
      (i) => i.kind === "file",
    );
    if (!hasStep) return;
    e.preventDefault();
    setDragging(true);
  }

  function onDragLeave(e: React.DragEvent) {
    // Only clear when leaving the root element entirely (not an inner child).
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragging(false);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files].find((f) =>
      /\.(step|stp)$/i.test(f.name),
    );
    if (file) await ingest(file.name, await file.arrayBuffer());
  }

  async function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await ingest(file.name, await file.arrayBuffer());
    e.target.value = ""; // allow re-loading the same file
  }

  async function onLoadDemo() {
    setBusy("Fetching demo part…");
    try {
      const res = await fetch("/demo.step");
      if (!res.ok) throw new Error("demo file not found");
      // Demo loads with every hole pre-annotated (see the auto-annotate effect).
      setAutoAnnotatePending(true);
      await ingest("demo.step", await res.arrayBuffer(), undefined, {
        name: "DEMO PART",
        number: "00000",
        rev: "00",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  // After the demo's geometry loads and its holes are grouped, apply a callout to
  // every group automatically (only if the file carried no embedded annotations).
  const [autoAnnotatePending, setAutoAnnotatePending] = useState(false);
  useEffect(() => {
    if (!autoAnnotatePending || !loaded) return;
    if (loaded.meta.annotations.length === 0 && holeGroups.length > 0) {
      annotateAllGroups(false);
    }
    setAutoAnnotatePending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAnnotatePending, loaded, holeGroups]);

  function updateMeta(fn: (m: Metadata) => Metadata) {
    setLoaded((prev) => (prev ? { ...prev, meta: fn(prev.meta) } : prev));
  }

  // ---- GD&T helpers ----


  function addDatum() {
    const label = datumDraft.trim().toUpperCase() || autoNextDatumLabel();
    if (!label || selected.length === 0) return;
    const target = selected[0];
    updateMeta((m) => ({
      ...m,
      datums: [
        ...(m.datums ?? []).filter((d) => d.label !== label),
        { id: "datum-" + label, label, target },
      ],
    }));
    setDatumDraft("");
  }

  function autoNextDatumLabel(): string {
    const used = new Set((loaded?.meta.datums ?? []).map((d) => d.label));
    for (let i = 0; i < 26; i++) {
      const l = String.fromCharCode(65 + i);
      if (!used.has(l)) return l;
    }
    return "";
  }

  function deleteDatum(id: string) {
    updateMeta((m) => ({ ...m, datums: (m.datums ?? []).filter((d) => d.id !== id) }));
  }
  function toggleDatumHidden(id: string) {
    updateMeta((m) => ({
      ...m,
      datums: (m.datums ?? []).map((d) => (d.id === id ? { ...d, hidden: !d.hidden } : d)),
    }));
  }


  function toggleAnnotationHidden(id: string) {
    updateMeta((m) => ({
      ...m,
      annotations: m.annotations.map((a) => (a.id === id ? { ...a, hidden: !a.hidden } : a)),
    }));
  }
  /** Row click: modifier toggles multi-select; a plain click selects just this one and
   *  highlights its targets in the 3D view. */
  function onAnnotationRowClick(a: Annotation, additive: boolean) {
    if (additive) {
      setSelectedAnnotations((prev) => {
        const next = new Set(prev);
        next.has(a.id) ? next.delete(a.id) : next.add(a.id);
        return next;
      });
    } else {
      setSelectedAnnotations(new Set([a.id]));
      setSelected(a.targets);
    }
  }
  function deleteSelectedAnnotations() {
    if (selectedAnnotations.size === 0) return;
    updateMeta((m) => ({ ...m, annotations: m.annotations.filter((a) => !selectedAnnotations.has(a.id)) }));
    setSelectedAnnotations(new Set());
  }
  function deleteAllAnnotations() {
    updateMeta((m) => ({ ...m, annotations: [] }));
    setSelectedAnnotations(new Set());
  }

  // The annotation shared by the current selection, when they all point at one.
  const selectedAnnotation: Annotation | undefined =
    selected.length === 0
      ? undefined
      : loaded?.meta.annotations.find((a) => selected.every((s) => hasTarget(a, s)));

  /**
   * Apply (or clear) one annotation covering the entire current selection. Targets
   * in the selection are first removed from any other annotation, then re-linked to
   * the new shared callout.
   */
  function setNoteForSelection(text: string) {
    if (selected.length === 0) return;
    updateMeta((m) => {
      const sel = selected;
      let anns = m.annotations
        .map((a) => ({ ...a, targets: a.targets.filter((t) => !sel.some((s) => sameT(s, t))) }))
        .filter((a) => a.targets.length > 0);
      if (text.trim() !== "") {
        const id = "a-sel-" + sel.map((t) => `${t.kind[0]}${t.id}`).join("-");
        anns = [...anns, { id, targets: sel, text }];
      }
      return { ...m, annotations: anns };
    });
  }

  /** Fold the live drawing-layout maps into the metadata so placement persists on save. */
  function withPlacements(meta: Metadata): Metadata {
    return {
      ...meta,
      annotations: meta.annotations.map((a) => {
        const next: Annotation = { ...a };
        if (labelOffsets[a.id]) next.label = labelOffsets[a.id];
        if (anchorAngles[a.id] !== undefined) next.anchorAngle = anchorAngles[a.id];
        if (anchorEnds[a.id] !== undefined) next.anchorEnd = anchorEnds[a.id];
        return next;
      }),
    };
  }

  async function onSave() {
    if (!loaded) return;
    const metaOut = withPlacements(loaded.meta);
    const out = embedMetadata(loaded.stepText, metaOut);
    const n = loaded.meta.annotations.length;
    const parts = loaded.meta.part;
    const partBits = [parts.material && "material", parts.finish && "finish"].filter(Boolean);
    const suffix = partBits.length ? ` + ${partBits.join(" & ")}` : "";

    // Preferred: overwrite the original file in place (Chrome/Edge, picker-opened).
    if (loaded.handle) {
      try {
        const writable = await loaded.handle.createWritable();
        await writable.write(new Blob([out], { type: "model/step" }));
        await writable.close();
        // Keep our in-memory copy in sync for subsequent saves.
        setLoaded((prev) => (prev ? { ...prev, stepText: out } : prev));
        flash(`Saved ${n} annotation(s)${suffix} in place → "${loaded.fileName}"`);
        return;
      } catch (e) {
        setError(
          "Could not write in place (" +
            (e instanceof Error ? e.message : String(e)) +
            "). Falling back to download.",
        );
      }
    }

    // Fallback: download a copy (file input / unsupported browsers).
    const blob = new Blob([out], { type: "model/step" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = loaded.fileName.replace(/\.(step|stp)$/i, "");
    const fname = `${base}.annotated.step`;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    flash(`Saved ${n} annotation(s)${suffix} → "${fname}" (in your Downloads).`);
  }

  async function onExportPdf() {
    if (!loaded || !viewerRef.current) return;
    if (viewMode !== "drawing") {
      setViewMode("drawing");
      flash("Switched to Drawing view — click Export PDF again to capture it.");
      return;
    }
    setBusy("Rendering drawing…");
    try {
      const cap = await viewerRef.current.captureDrawing(4);
      if (!cap) throw new Error("Could not capture the drawing view.");
      // ANSI B (17"×11") landscape sheet, in points.
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: [1224, 792] });
      const W = doc.internal.pageSize.getWidth();
      const H = doc.internal.pageSize.getHeight();
      const part = loaded.meta.part;

      const setLW = (w: number) => doc.setLineWidth(w);
      const font = (size: number, bold = false, gray = 30) =>
        doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(size).setTextColor(gray);
      const T = (s: string, x: number, y: number, align?: "left" | "center" | "right") =>
        doc.text(s, x, y, align ? { align } : undefined);

      // ---- borders + A–D / 1–8 zone frame ----
      const mo = 14;
      const mf = 30;
      setLW(0.75).rect(mo, mo, W - 2 * mo, H - 2 * mo);
      setLW(1).rect(mf, mf, W - 2 * mf, H - 2 * mf);
      const cols = 8;
      const rows = 4;
      const cw = (W - 2 * mf) / cols;
      const rh = (H - 2 * mf) / rows;
      font(7, false, 90);
      for (let i = 0; i < cols; i++) {
        const cx = mf + i * cw + cw / 2;
        T(String(cols - i), cx, mo + (mf - mo) / 2 + 2, "center");
        T(String(cols - i), cx, H - mo - (mf - mo) / 2 + 3, "center");
        if (i > 0) {
          const x = mf + i * cw;
          setLW(0.5);
          doc.line(x, mo, x, mf);
          doc.line(x, H - mf, x, H - mo);
        }
      }
      const rowLetters = ["D", "C", "B", "A"];
      for (let j = 0; j < rows; j++) {
        const cy = mf + j * rh + rh / 2 + 2;
        T(rowLetters[j], mo + (mf - mo) / 2, cy, "center");
        T(rowLetters[j], W - mo - (mf - mo) / 2, cy, "center");
        if (j > 0) {
          const y = mf + j * rh;
          setLW(0.5);
          doc.line(mo, y, mf, y);
          doc.line(W - mf, y, W - mo, y);
        }
      }

      // ---- drawing image (fills the sheet above the bottom title band) ----
      const tbH = 96;
      const tbW = 300;
      const tbX = W - mf - tbW;
      const tbY = H - mf - tbH;
      const imgX = mf + 8;
      const imgY = mf + 8;
      const imgW = W - mf - 8 - imgX;
      const imgH = tbY - 8 - imgY;
      const s = Math.min(imgW / cap.w, imgH / cap.h);
      doc.addImage(
        cap.url,
        "PNG",
        imgX + (imgW - cap.w * s) / 2,
        imgY + (imgH - cap.h * s) / 2,
        cap.w * s,
        cap.h * s,
      );

      // ---- title block (bottom-right) ----
      const hasRev = !!part.rev?.trim();
      setLW(0.9).rect(tbX, tbY, tbW, tbH);
      const r1 = tbY + 26;
      const r2 = tbY + 50;
      doc.line(tbX, r1, tbX + tbW, r1);
      doc.line(tbX, r2, tbX + tbW, r2);
      font(6.5, true, 110);
      T("TITLE:", tbX + 6, tbY + 9);
      font(11, true, 20);
      T((part.name || "").toUpperCase(), tbX + tbW / 2, tbY + 21, "center");
      const sizeW = 40;
      const revW = hasRev ? 44 : 0;
      doc.line(tbX + sizeW, r1, tbX + sizeW, r2);
      if (hasRev) doc.line(tbX + tbW - revW, r1, tbX + tbW - revW, r2);
      font(6, true, 110);
      T("SIZE", tbX + 6, r1 + 9);
      font(12, true, 20);
      T("B", tbX + sizeW / 2, r1 + 20, "center");
      font(6, true, 110);
      T("PART NUMBER:", tbX + sizeW + 6, r1 + 9);
      font(10, true, 20);
      T(part.number || "", tbX + sizeW + (tbW - sizeW - revW) / 2, r1 + 20, "center");
      if (hasRev) {
        font(6, true, 110);
        T("REV:", tbX + tbW - revW + 6, r1 + 9);
        font(10, true, 20);
        T(part.rev!.trim(), tbX + tbW - revW / 2, r1 + 20, "center");
      }
      doc.line(tbX + tbW / 2, r2, tbX + tbW / 2, tbY + tbH);
      font(6.5, true, 110);
      T("SCALE:", tbX + 6, r2 + 14);
      font(8, false, 30);
      T("NTS", tbX + 44, r2 + 14);
      font(7, true, 40);
      T("SHEET 1 OF 1", tbX + tbW / 2 + 8, r2 + 14);

      // ---- material / finish (left of the title block; only when specified) ----
      const hasMat = !!part.material?.trim();
      const hasFin = !!part.finish?.trim();
      if (hasMat || hasFin) {
        const pW = 150;
        const pX = tbX - pW;
        setLW(0.9).rect(pX, tbY, pW, tbH);
        if (hasMat && hasFin) doc.line(pX, tbY + tbH / 2, pX + pW, tbY + tbH / 2);
        if (hasMat) {
          font(6, true, 110);
          T("MATERIAL:", pX + 5, tbY + 12);
          font(8, false, 25);
          T(part.material!.trim().toUpperCase(), pX + 5, tbY + 26);
        }
        const fy = hasMat ? tbY + tbH / 2 : tbY;
        if (hasFin) {
          font(6, true, 110);
          T("FINISH:", pX + 5, fy + 12);
          font(8, false, 25);
          T(part.finish!.trim().toUpperCase(), pX + 5, fy + 26);
        }
      }

      // ---- editable critical-dimension note (top-left) ----
      const noteText = (part.note ?? DEFAULT_NOTE).trim();
      if (noteText) {
        const nx = mf + 12;
        let ny = mf + 20;
        font(8.5, true, 25);
        T("NOTES:", nx, ny);
        ny += 14;
        font(7.5, false, 45);
        const wrapped: string[] = doc.splitTextToSize(noteText, 380);
        doc.text(wrapped, nx, ny);
        // Pill the "X.X" token wherever it lands — the pill marks those dims critical.
        for (let li = 0; li < wrapped.length; li++) {
          const c = wrapped[li].indexOf("X.X");
          if (c < 0) continue;
          const px = nx + doc.getTextWidth(wrapped[li].slice(0, c));
          const tw = doc.getTextWidth("X.X");
          const h = 9.5;
          setLW(0.6);
          doc.roundedRect(px - 2.4, ny + li * 10 - 6.8, tw + 4.8, h, h / 2, h / 2, "S");
          break;
        }
      }

      // Generator footer (keeps the project name on the sheet).
      font(5.5, false, 140);
      T(`DRAWN WITH ${APP_NAME}`, mf + 12, H - mf - 5);

      const baseName =
        part.number || part.name || loaded.fileName.replace(/\.(step|stp)$/i, "") || "drawing";
      doc.save(`${baseName}.pdf`);
      flash("Exported drawing PDF.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={"app" + (dragging ? " drag-over" : "")}
      style={
        { "--label-size": `${fontSize}px`, "--leader-weight": String(lineWeight) } as React.CSSProperties
      }
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-message">Drop STEP file to open</div>
        </div>
      )}
      <header className="topbar">
        <strong className="brand">{APP_NAME}</strong>
        <div className="segmented" role="tablist">
          <button
            className={"seg" + (viewMode === "model" ? " on" : "")}
            onClick={() => switchView("model")}
            title="Engineer view: edit holes & annotations"
          >
            Model
          </button>
          <button
            className={"seg" + (viewMode === "drawing" ? " on" : "")}
            onClick={() => switchView("drawing")}
            disabled={!loaded}
            title="Manufacturer view: annotated drawing"
          >
            Drawing
          </button>
        </div>
        <button
          className={"btn" + (xray ? " primary" : "")}
          onClick={() => setXray((v) => !v)}
          disabled={!loaded}
          title="DEBUG: transparent, non-occluding faces"
        >
          X-ray {xray ? "on" : "off"}
        </button>
        <div className="spacer" />
        <input
          ref={fileInputRef}
          type="file"
          accept=".step,.stp"
          onChange={onFileInput}
          hidden
        />
        <button className="btn" onClick={onOpen}>
          Open STEP…
        </button>
        <button className="btn" onClick={onLoadDemo}>
          Load demo part
        </button>
        <button className="btn" onClick={onExportPdf} disabled={!loaded}>
          Export PDF
        </button>
        <button className="btn primary" onClick={onSave} disabled={!loaded}>
          {loaded?.handle ? "Save (overwrite)" : "Save annotated STEP"}
        </button>
        <a
          className="btn icon-only"
          href="https://github.com/davepreiss/hole_warlock"
          target="_blank"
          rel="noopener noreferrer"
          title="View Hole Warlock on GitHub"
          aria-label="View Hole Warlock on GitHub"
        >
          <GitHubIcon />
        </a>
      </header>

      <div className="body">
        <div
          className={"viewport" + (viewMode === "drawing" ? " drawing" : "")}
          ref={viewportRef}
        >
          <div
            className={"sheet" + (viewMode === "drawing" ? " paper" : "")}
            style={
              viewMode === "drawing" && sheetFit
                ? { width: sheetFit.w * sheetScale, height: sheetFit.h * sheetScale }
                : undefined
            }
          >
            <div className="sheet-draw" style={viewMode === "drawing" ? DRAW_PCT : undefined}>
              {loaded ? (
                <Viewer
                  ref={viewerRef}
                  mesh={loaded.mesh}
                  selected={selected}
                  annotatedFaces={annotatedFaces}
                  annotatedEdges={annotatedEdges}
                  highlightFaces={highlightFaces}
                  onPick={onPickTarget}
                  drawingMode={viewMode === "drawing"}
                  xray={xray}
                  lineWeight={lineWeight}
                  annotations={visibleAnnotations}
                  labelOffsets={labelOffsets}
                  onMoveLabel={(id, dx, dy) => setLabelOffsets((o) => ({ ...o, [id]: { dx, dy } }))}
                  rims={holeRims}
                  anchorAngles={anchorAngles}
                  onMoveAnchor={(id, angle) => setAnchorAngles((a) => ({ ...a, [id]: angle }))}
                  anchorEnds={anchorEnds}
                  onFlipAnchor={(id) =>
                    setAnchorEnds((e) => ({ ...e, [id]: ((e[id] ?? 0) + 1) % 2 }))
                  }
                  datums={visibleDatums}
                  gdtAnnotations={[]}
                />
              ) : (
                <div className="placeholder">
                  {busy ?? "Open a STEP file or load the demo part to begin."}
                </div>
              )}
            </div>
            {viewMode === "drawing" && loaded && (
              <svg
                className="sheet-chrome"
                viewBox={`0 0 ${SHEET.W} ${SHEET.H}`}
                preserveAspectRatio="xMidYMid meet"
                dangerouslySetInnerHTML={{ __html: sheetChrome }}
              />
            )}
          </div>
          {/* Floating hole table — Model view only, shows annotated groups only */}
          {viewMode === "model" && loaded && (() => {
            const annotatedGroups = holeGroups.filter((g) =>
              g.holes.some((h) => h.faceIds.some((id) => annotatedFaces.has(id))),
            );
            if (annotatedGroups.length === 0) return null;
            return (
            <div className="hole-table-overlay">
              <div className="hole-table-header">
                <span>Holes ({annotatedGroups.length})</span>
                <button className="hole-table-toggle" onClick={() => setTableOpen((o) => !o)}>
                  {tableOpen ? "×" : "≡"}
                </button>
              </div>
              {tableOpen && annotatedGroups.map((g) => {
                const active = g.holes.some((h) =>
                  h.faceIds.some((id) => isSelected({ kind: "face", id })),
                );
                const firstLine = calloutFor(g.key, g.holes).split("\n")[0];
                const tDesc = effectiveDesc(g.key, g.holes[0]);
                return (
                  <div
                    key={g.key}
                    className={"hole-table-row" + (active ? " active" : "")}
                    onClick={() =>
                      pickTargets(
                        g.holes.flatMap((h) => h.faceIds.map((id) => ({ kind: "face" as const, id }))),
                        false,
                      )
                    }
                    onMouseEnter={() => setHoveredGroup(g.key)}
                    onMouseLeave={() => setHoveredGroup(null)}
                  >
                    <span className="hole-table-swatch" style={{ background: g.color }} />
                    <span className="hole-table-count">{g.holes.length}×</span>
                    <span className="hole-table-dia">{dia(g.diameter, unit)}</span>
                    <span className={"chip chip-" + tDesc.category}>{tDesc.pill}</span>
                    <span className="hole-table-callout">{firstLine}</span>
                  </div>
                );
              })}
            </div>
            );
          })()}

          {busy && loaded && <div className="toast">{busy}</div>}
          {info && !error && <div className="toast info">{info}</div>}
          {error && <div className="toast error">{error}</div>}
        </div>

        <aside className="panel">
          {loaded ? (
            <>
              <h3>{loaded.fileName}</h3>
              <p className="subtle">
                {loaded.mesh.faceCount} faces · {loaded.mesh.edgeCount} edges ·{" "}
                {loaded.mesh.indices.length / 3} triangles
              </p>

              <section>
                <h4
                  className="collapsible"
                  onClick={() => setPartOpen((o) => !o)}
                >
                  <span className="caret">{partOpen ? "▾" : "▸"}</span>
                  Part Info
                </h4>
                {partOpen && <>
                <label>
                  Part Name
                  <input
                    value={loaded.meta.part.name ?? ""}
                    placeholder="e.g. Mounting Bracket"
                    onChange={(e) =>
                      updateMeta((m) => ({ ...m, part: { ...m.part, name: e.target.value } }))
                    }
                  />
                </label>
                <div className="row2">
                  <label>
                    Part Number
                    <input
                      value={loaded.meta.part.number ?? ""}
                      placeholder="e.g. PRT-0042"
                      onChange={(e) =>
                        updateMeta((m) => ({ ...m, part: { ...m.part, number: e.target.value } }))
                      }
                    />
                  </label>
                  <label className="rev-field">
                    Rev
                    <input
                      value={loaded.meta.part.rev ?? ""}
                      placeholder="00"
                      onChange={(e) =>
                        updateMeta((m) => ({ ...m, part: { ...m.part, rev: e.target.value } }))
                      }
                    />
                  </label>
                </div>
                <label>
                  Material
                  <input
                    value={loaded.meta.part.material ?? ""}
                    placeholder="e.g. 6061-T6 Aluminum"
                    onChange={(e) =>
                      updateMeta((m) => ({ ...m, part: { ...m.part, material: e.target.value } }))
                    }
                  />
                </label>
                <label>
                  Finish
                  <input
                    value={loaded.meta.part.finish ?? ""}
                    placeholder="e.g. Clear anodize, Type II"
                    onChange={(e) =>
                      updateMeta((m) => ({ ...m, part: { ...m.part, finish: e.target.value } }))
                    }
                  />
                </label>
                <label>
                  Units
                  <select
                    value={unit}
                    onChange={(e) =>
                      updateMeta((m) => ({
                        ...m,
                        part: { ...m.part, units: e.target.value as UnitSystem },
                      }))
                    }
                  >
                    <option value="metric">Metric</option>
                    <option value="imperial">Imperial</option>
                  </select>
                </label>
                <label>
                  Drawing Notes
                  <textarea
                    rows={3}
                    value={loaded.meta.part.note ?? ""}
                    placeholder="e.g. Dimensions marked X.X are critical to quality."
                    spellCheck={false}
                    onChange={(e) =>
                      updateMeta((m) => ({ ...m, part: { ...m.part, note: e.target.value } }))
                    }
                  />
                </label>
                </>}
              </section>

              <section>
                <h4
                  className="collapsible"
                  onClick={() => setHolesOpen((o) => !o)}
                >
                  <span className="caret">{holesOpen ? "▾" : "▸"}</span>
                  Holes ({loaded.mesh.holes.length})
                </h4>
                {holesOpen &&
                  (loaded.mesh.holes.length === 0 ? (
                    <p className="subtle">No cylindrical holes detected.</p>
                  ) : (
                    <>
                    <button
                      className="btn small"
                      style={{ width: "100%", marginBottom: 8 }}
                      onClick={() => annotateAllGroups()}
                    >
                      Annotate All
                    </button>
                    {holeGroups.map((g) => {
                      const h0 = g.holes[0];
                      const isSel = g.holes.some((h) => h.faceIds.some((id) => isSelected({ kind: "face", id })));
                      const desc = effectiveDesc(g.key, h0);
                      const callout = calloutFor(g.key, g.holes);
                      const rows = Math.max(2, callout.split("\n").length);
                      const selectedHoles = g.holes.filter((h) =>
                        h.faceIds.some((id) => isSelected({ kind: "face", id })),
                      );
                      const splittable = g.holes.length > 1 && isSel;
                      // "Split Selected" needs a proper subset (some, but not all, deselected).
                      const canSplitSelected =
                        selectedHoles.length > 0 && selectedHoles.length < g.holes.length;
                      return (
                        <div key={g.key} className={"hole-tile" + (isSel ? " active" : "")}>
                          <div
                            className="hole-head"
                            onClick={(e) =>
                              pickTargets(
                                g.holes.flatMap((h) => h.faceIds.map((id) => ({ kind: "face" as const, id }))),
                                e.shiftKey || e.ctrlKey || e.metaKey,
                              )
                            }
                          >
                            <span className="swatch" style={{ background: g.color }} />
                            <strong>{dia(g.diameter, unit)}</strong>
                            <span className="hole-right">
                              {g.custom && (
                                <button
                                  className="link-btn"
                                  title="Reset to automatic grouping"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    ungroupHoles(g.holes.map((h) => h.faceId));
                                  }}
                                >
                                  ↺
                                </button>
                              )}
                              {g.custom && <span className="chip chip-custom">GROUPED</span>}
                              <span className="qty">×{g.holes.length}</span>
                              {g.type === "simple" ? (
                                <button
                                  className={"chip chip-" + desc.category + " chip-toggle"}
                                  title="Click to toggle tap / clearance hole classification"
                                  onClick={(e) => { e.stopPropagation(); togglePill(g.key, desc.category); }}
                                >{desc.pill}</button>
                              ) : (
                                <span className={"chip chip-" + desc.category}>{desc.pill}</span>
                              )}
                            </span>
                          </div>
                          <textarea
                            className="callout-edit"
                            rows={rows}
                            value={callout}
                            spellCheck={false}
                            onChange={(e) => setHoleDrafts((d) => ({ ...d, [g.key]: e.target.value }))}
                          />
                          {splittable && (
                            <>
                              <div className="hole-rows">
                                {g.holes.map((h) => {
                                  const sel = h.faceIds.some((id) => isSelected({ kind: "face", id }));
                                  return (
                                    <button
                                      key={h.faceId}
                                      className={"hole-chip" + (sel ? " on" : "")}
                                      title={h.through ? "Through hole" : "Blind hole"}
                                      onClick={() =>
                                        pickTargets(h.faceIds.map((id) => ({ kind: "face" as const, id })), true)
                                      }
                                    >
                                      Hole {holeNumbers.get(h.faceId)}
                                      <span className="hole-chip-end">
                                        {h.through ? "THRU" : "BLIND"}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                              <div className="hole-split-row">
                                <button
                                  className="btn small"
                                  disabled={!canSplitSelected}
                                  title="Split the selected holes into their own group"
                                  onClick={() => groupHoles(selectedHoles.map((h) => h.faceId))}
                                >
                                  Split selected
                                </button>
                                <button
                                  className="btn small"
                                  title="Split every hole into its own group"
                                  onClick={() => splitIndividual(g.holes.map((h) => h.faceId))}
                                >
                                  Split all
                                </button>
                              </div>
                            </>
                          )}
                          <button
                            className="btn small"
                            title="Auto-Annotate"
                            onClick={() => annotateHoles(g.key, g.holes)}
                          >
                            Apply to {g.holes.length} hole{g.holes.length > 1 ? "s" : ""}
                          </button>
                        </div>
                      );
                    })}
                    </>
                  ))}
              </section>

              {/* ---- GD&T Panel ---- */}
              <section>
                <h4 className="collapsible" onClick={() => setGdtOpen((o) => !o)}>
                  <span className="caret">{gdtOpen ? "▾" : "▸"}</span>
                  GD&amp;T
                </h4>
                {gdtOpen && <>
                  {/* --- Datums --- */}
                  <div className="gdt-sub-head">
                    <span>Datums</span>
                    <div className="gdt-datum-add">
                      <input
                        className="gdt-datum-input"
                        value={datumDraft}
                        placeholder={autoNextDatumLabel() || "A"}
                        maxLength={2}
                        onChange={(e) => setDatumDraft(e.target.value.toUpperCase())}
                        onKeyDown={(e) => e.key === "Enter" && addDatum()}
                        title="Datum label (leave blank to auto-assign)"
                      />
                      <button
                        className="btn small"
                        disabled={selected.length === 0}
                        title={selected.length === 0 ? "Select a face or edge first" : "Assign datum to selection"}
                        onClick={addDatum}
                      >
                        Assign
                      </button>
                    </div>
                  </div>
                  {(loaded?.meta.datums ?? []).length === 0 ? (
                    <p className="subtle">No datums assigned.</p>
                  ) : (
                    <ul className="gdt-list">
                      {(loaded?.meta.datums ?? []).map((d) => (
                        <li
                          key={d.id}
                          className={d.hidden ? "hidden-ann" : ""}
                          onClick={() => setSelected([d.target])}
                        >
                          <span className="datum-badge">{d.label}</span>
                          <span className="gdt-row-info subtle">
                            {d.target.kind === "face" ? "F" : "E"}{d.target.id}
                          </span>
                          <button className={"icon-btn" + (d.hidden ? " off" : "")}
                            title={d.hidden ? "Show" : "Hide"}
                            onClick={(e) => { e.stopPropagation(); toggleDatumHidden(d.id); }}>
                            <EyeIcon off={!!d.hidden} />
                          </button>
                          <button className="icon-btn" title="Delete"
                            onClick={(e) => { e.stopPropagation(); deleteDatum(d.id); }}>
                            <TrashIcon />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                </>}
              </section>

              <section>
                <h4>Selection</h4>
                {selected.length === 0 ? (
                  <p className="subtle">
                    Click a face or edge to select it. Shift/Ctrl-click to select multiple, then add
                    one shared note.
                  </p>
                ) : (
                  <>
                    <p className="subtle">
                      {selected.length === 1
                        ? `${selected[0].kind === "face" ? "Face" : "Edge"} #${selected[0].id}`
                        : `${selected.length} selected (${selected
                            .map((t) => `${t.kind === "face" ? "F" : "E"}${t.id}`)
                            .join(", ")})`}
                      {selected.length > 0 && (
                        <button className="link-btn" onClick={() => setSelected([])}>
                          clear
                        </button>
                      )}
                    </p>
                    <label>
                      Note {selected.length > 1 ? `(applies to all ${selected.length})` : ""}
                      <textarea
                        rows={3}
                        value={selectedAnnotation?.text ?? ""}
                        placeholder="e.g. 0.5 × 45° chamfer, deburr"
                        onChange={(e) => setNoteForSelection(e.target.value)}
                      />
                    </label>
                  </>
                )}
              </section>

              <section>
                <h4>Annotations ({loaded.meta.annotations.length})</h4>
                {loaded.meta.annotations.length === 0 ? (
                  <p className="subtle">None yet.</p>
                ) : (
                  <>
                    <p className="subtle hint">Click to select · Ctrl/Shift-click for multiple</p>
                    <ul className="notes">
                      {loaded.meta.annotations
                        .slice()
                        .sort((a, b) => a.targets[0].id - b.targets[0].id)
                        .map((a) => (
                          <li
                            key={a.id}
                            className={
                              (selectedAnnotations.has(a.id) ? "active" : "") +
                              (a.hidden ? " hidden-ann" : "")
                            }
                            onClick={(e) =>
                              onAnnotationRowClick(a, e.shiftKey || e.ctrlKey || e.metaKey)
                            }
                          >
                            <span className="tag">
                              {a.targets.length > 1 ? `${a.targets.length}×` : ""}
                              {a.targets[0].kind === "face" ? "F" : "E"}
                              {a.targets[0].id}
                            </span>{" "}
                            <span className="note-text">{a.text}</span>
                            <button
                              className={"icon-btn" + (a.hidden ? " off" : "")}
                              title={a.hidden ? "Hidden — click to show" : "Shown — click to hide"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleAnnotationHidden(a.id);
                              }}
                            >
                              <EyeIcon off={!!a.hidden} />
                            </button>
                          </li>
                        ))}
                    </ul>
                    <div className="ann-actions">
                      <button
                        className="btn danger"
                        disabled={selectedAnnotations.size === 0}
                        onClick={deleteSelectedAnnotations}
                      >
                        Delete{selectedAnnotations.size > 0 ? ` ${selectedAnnotations.size}` : ""} selected
                      </button>
                      <button className="btn danger ghost" onClick={deleteAllAnnotations}>
                        Delete all
                      </button>
                    </div>
                  </>
                )}
              </section>
            </>
          ) : (
            <p className="subtle">No part loaded.</p>
          )}
        </aside>
      </div>

      {viewMode === "drawing" && <footer className="bottombar">
        <span className="bb-title">Aesthetics</span>
        <label className="bb-ctl">
          Annotation size
          <input
            type="range"
            min={8}
            max={28}
            step={1}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
          <span className="bb-val">{fontSize}px</span>
        </label>
        <label className="bb-ctl">
          Line weight
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.1}
            value={lineWeight}
            onChange={(e) => setLineWeight(Number(e.target.value))}
          />
          <span className="bb-val">{lineWeight.toFixed(1)}</span>
        </label>
        <div className="spacer" />
        <span className="bb-title">View</span>
        <span className="bb-hint">Ctrl + drag to roll</span>
        <button
          className="btn small"
          onClick={() => viewerRef.current?.resetRoll()}
          title="Reset camera roll back to Z-up"
        >
          Reset roll
        </button>
      </footer>}
    </div>
  );
}
