// The manufacturing-metadata model + how it is embedded in a STEP file.
//
// EMBEDDING (M0): the metadata JSON is base64-encoded and written as an ISO
// 10303-21 (Part 21) comment block placed right after the `DATA;` line:
//
//   /* HOLE-WARLOCK-V1
//   eyJ...base64...
//   HOLE-WARLOCK-END */
//
// Part-21 permits /* ... */ comments anywhere whitespace is allowed, so the file
// remains a fully valid STEP file that any CAD tool can open; the comment is
// ignored by other readers. Base64 guarantees the payload can never contain the
// `*/` terminator or otherwise perturb tokenizing. Because we leave the original
// geometry bytes untouched, face indices are stable across our own round-trips
// (this is the M0 anchoring mechanism — see ANCHORING below).
//
// Limitation (documented, accepted for MVP): a foreign CAD tool that re-saves the
// file may drop the comment. A future upgrade embeds the same data as XCAF
// property entities so it survives foreign round-trips (see plan, embedding path 2).
//
// ANCHORING (M0): an annotation targets a face by `faceId`, which is the 0-based
// index of that face in OCCT's TopExp_Explorer iteration order. That order is
// deterministic for a fixed geometry, and we never rewrite the geometry, so the
// mapping is stable load→save→reload.
import { z } from "zod";

export const SCHEMA_VERSION = "0.6";
export const GENERATOR = "Hole Warlock v0.0.1";

/** What a note points at: a B-rep face or edge, identified by its TopExp index. */
export const TargetSchema = z.object({
  kind: z.enum(["face", "edge"]),
  id: z.number().int().nonnegative(),
});
export type Target = z.infer<typeof TargetSchema>;

export function targetKey(t: Target): string {
  return `${t.kind}:${t.id}`;
}

/** A note attached to one or more faces/edges (multiple targets = one shared callout). */
export const AnnotationSchema = z.object({
  id: z.string(),
  targets: z.array(TargetSchema).min(1),
  text: z.string(),
  /** Hidden from the drawing (still stored). Absent/false = shown. */
  hidden: z.boolean().optional(),
  /**
   * Hand-placed drawing layout (absent = auto-placed on load). Persisted so a tuned
   * drawing reloads exactly as left. `label` is the screen-px offset of the label from
   * its feature anchor; `anchorAngle` is the leader anchor angle (radians) around a hole
   * rim; `anchorEnd` is which axial end (0 = entry, 1 = far) the leader points at.
   */
  label: z.object({ dx: z.number(), dy: z.number() }).optional(),
  anchorAngle: z.number().optional(),
  anchorEnd: z.number().int().optional(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

/** True if the annotation points at the given target. */
export function hasTarget(a: Annotation, t: Target): boolean {
  return a.targets.some((x) => x.kind === t.kind && x.id === t.id);
}

/**
 * A manual hole-group override: the listed holes (by stable bore faceId) are forced into
 * one group, regardless of the automatic signature grouping. Absent holes are ignored.
 */
export const HoleGroupSchema = z.object({
  id: z.string(),
  holeIds: z.array(z.number().int().nonnegative()),
});
export type HoleGroupOverride = z.infer<typeof HoleGroupSchema>;

/** A datum label (A, B, C…) assigned to a face or edge for GD&T reference. */
export const DatumSchema = z.object({
  id: z.string(),
  label: z.string().max(2),
  target: TargetSchema,
  hidden: z.boolean().optional(),
});
export type Datum = z.infer<typeof DatumSchema>;

export const GdtSymbolSchema = z.enum([
  "position",
  "parallelism",
  "perpendicularity",
  "circularity",
  "angularity",
]);
export type GdtSymbol = z.infer<typeof GdtSymbolSchema>;

export const GdtModifierSchema = z.enum(["none", "mmc", "lmc"]);
export type GdtModifier = z.infer<typeof GdtModifierSchema>;

/** A feature control frame (FCF) attached to one or more faces/edges. */
export const GdtAnnotationSchema = z.object({
  id: z.string(),
  symbol: GdtSymbolSchema,
  targets: z.array(TargetSchema).min(1),
  tolerance: z.number().positive(),
  modifier: GdtModifierSchema.default("none"),
  datumRefs: z.array(z.string().max(2)).max(3).default([]),
  hidden: z.boolean().optional(),
});
export type GdtAnnotation = z.infer<typeof GdtAnnotationSchema>;

export const GDT_SYMBOL_CHAR: Record<GdtSymbol, string> = {
  position: "⊙",
  parallelism: "∥",
  perpendicularity: "⊥",
  circularity: "○",
  angularity: "↗",
};

export const GDT_SYMBOL_LABEL: Record<GdtSymbol, string> = {
  position: "Position",
  parallelism: "Parallelism",
  perpendicularity: "Perpendicularity",
  circularity: "Circularity",
  angularity: "Angularity",
};

export const PartMetaSchema = z.object({
  name: z.string().optional(),
  number: z.string().optional(),
  rev: z.string().optional(),
  material: z.string().optional(),
  finish: z.string().optional(),
  units: z.enum(["metric", "imperial"]).optional(),
  /** Editable drawing note (the critical-dimension note on the exported sheet). */
  note: z.string().optional(),
});
export type PartMeta = z.infer<typeof PartMetaSchema>;

export const MetadataSchema = z.object({
  schemaVersion: z.string(),
  generator: z.string(),
  part: PartMetaSchema,
  annotations: z.array(AnnotationSchema),
  /** Manual hole-group overrides (see HoleGroupSchema). */
  holeGroups: z.array(HoleGroupSchema).optional(),
  /** GD&T datum labels. */
  datums: z.array(DatumSchema).optional(),
  /** GD&T feature control frames. */
  gdtAnnotations: z.array(GdtAnnotationSchema).optional(),
});
export type Metadata = z.infer<typeof MetadataSchema>;

export function emptyMetadata(): Metadata {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: GENERATOR,
    part: {},
    annotations: [],
    datums: [],
    gdtAnnotations: [],
  };
}

const BEGIN = "/* HOLE-WARLOCK-V1";
const END = "HOLE-WARLOCK-END */";
// Matches our whole comment block (incl. surrounding newlines) so we can strip/replace it.
// Also matches the legacy METROLOGY-INTEGRATED marker so files saved before the rename
// (e.g. the bundled demo/sample parts) still load and get rewritten with the new marker.
const BLOCK_RE = /\r?\n?\/\* (?:HOLE-WARLOCK|METROLOGY-INTEGRATED)-V1\r?\n([\s\S]*?)\r?\n(?:HOLE-WARLOCK|METROLOGY-INTEGRATED)-END \*\//;

function toBase64(s: string): string {
  // UTF-8 safe base64 for the browser.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Read our metadata block out of STEP text, or null if none / invalid. */
export function extractMetadata(stepText: string): Metadata | null {
  const m = BLOCK_RE.exec(stepText);
  if (!m) return null;
  const b64 = m[1].trim();
  try {
    const json = JSON.parse(fromBase64(b64));
    migrateLegacy(json);
    return MetadataSchema.parse(json);
  } catch {
    return null;
  }
}

/**
 * Migrate older annotation shapes in place:
 *   v0.1: { faceId }          -> { targets: [{ kind:"face", id }] }
 *   v0.2: { target: {kind,id} } -> { targets: [target] }
 */
function migrateLegacy(json: unknown): void {
  if (!json || typeof json !== "object") return;
  const obj = json as Record<string, unknown>;
  // Default new arrays so Zod parse never fails on old files.
  if (!Array.isArray(obj.datums)) obj.datums = [];
  if (!Array.isArray(obj.gdtAnnotations)) obj.gdtAnnotations = [];

  const anns = obj.annotations;
  if (!Array.isArray(anns)) return;
  for (const a of anns) {
    if (!a || typeof a !== "object" || "targets" in a) continue;
    const rec = a as { faceId?: number; target?: Target; targets?: Target[] };
    if ("target" in rec && rec.target) {
      rec.targets = [rec.target];
      delete rec.target;
    } else if ("faceId" in rec && typeof rec.faceId === "number") {
      rec.targets = [{ kind: "face", id: rec.faceId }];
      delete rec.faceId;
    }
  }
}

/**
 * Return STEP text with `meta` embedded: strips any existing block, then inserts
 * a fresh one immediately after the first `DATA;`. Geometry is untouched.
 */
export function embedMetadata(stepText: string, meta: Metadata): string {
  const stripped = stepText.replace(BLOCK_RE, "");
  const b64 = toBase64(JSON.stringify(meta));
  const block = `\n${BEGIN}\n${b64}\n${END}`;
  const dataIdx = stripped.indexOf("DATA;");
  if (dataIdx === -1) {
    // No DATA section? Append at end as a last resort (still a valid comment).
    return stripped + block + "\n";
  }
  const insertAt = dataIdx + "DATA;".length;
  return stripped.slice(0, insertAt) + block + stripped.slice(insertAt);
}
