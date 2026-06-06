// Thread reference + tap/clearance/fastener suggestions and GD&T-style callouts.
//
// A hole that will be tapped is drilled between the theoretical tap drill and the
// slightly larger size SendCutSend recommends, so each thread has an acceptance
// band [drillLo, drillHi]; a hole in that band is confidently that tap.
// SendCutSend tap table: https://sendcutsend.com/services/tapping/
import type { Hole } from "./holes";

export type UnitSystem = "metric" | "imperial";

export interface ThreadSpec {
  name: string; // "M4", "1/4-20"
  label: string; // "M4×0.7"
  drillLo: number; // mm — low end of the tap-hole acceptance band
  drillHi: number; // mm — high end
  clearance: number; // mm — normal clearance hole
}

// Metric coarse. Band = [tapDrill - 0.1, scsHole + 0.1].
export const METRIC: ThreadSpec[] = [
  { name: "M2", label: "M2×0.4", drillLo: 1.5, drillHi: 1.76, clearance: 2.4 },
  { name: "M2.5", label: "M2.5×0.45", drillLo: 1.95, drillHi: 2.21, clearance: 2.9 },
  { name: "M3", label: "M3×0.5", drillLo: 2.4, drillHi: 2.7, clearance: 3.4 },
  { name: "M4", label: "M4×0.7", drillLo: 3.2, drillHi: 3.51, clearance: 4.5 },
  { name: "M5", label: "M5×0.8", drillLo: 4.1, drillHi: 4.42, clearance: 5.5 },
  { name: "M6", label: "M6×1.0", drillLo: 4.9, drillHi: 5.26, clearance: 6.6 },
  { name: "M8", label: "M8×1.25", drillLo: 6.7, drillHi: 7.06, clearance: 9.0 },
  { name: "M10", label: "M10×1.5", drillLo: 8.4, drillHi: 8.84, clearance: 11.0 },
  { name: "M12", label: "M12×1.75", drillLo: 10.1, drillHi: 10.5, clearance: 13.5 },
];

// Imperial UNC/UNF. Band = SendCutSend recommended hole ± 0.18 mm. clearance ≈ major + 0.4 mm.
export const IMPERIAL: ThreadSpec[] = [
  { name: "4-40", label: "#4-40", drillLo: 2.14, drillHi: 2.5, clearance: 3.3 },
  { name: "6-32", label: "#6-32", drillLo: 2.82, drillHi: 3.18, clearance: 3.9 },
  { name: "8-32", label: "#8-32", drillLo: 3.33, drillHi: 3.69, clearance: 4.6 },
  { name: "10-32", label: "#10-32", drillLo: 3.99, drillHi: 4.35, clearance: 5.3 },
  { name: "1/4-20", label: '1/4"-20', drillLo: 5.13, drillHi: 5.49, clearance: 6.8 },
  { name: "5/16-18", label: '5/16"-18', drillLo: 6.58, drillHi: 6.94, clearance: 8.3 },
  { name: "3/8-16", label: '3/8"-16', drillLo: 8.03, drillHi: 8.39, clearance: 10.0 },
  { name: "1/2-13", label: '1/2"-13', drillLo: 10.87, drillHi: 11.23, clearance: 13.2 },
];

const CLEAR_TOL = 0.4;

export function table(unit: UnitSystem): ThreadSpec[] {
  return unit === "imperial" ? IMPERIAL : METRIC;
}

/** Thread whose tap-drill band contains the diameter (mm), or null. No guessing. */
export function confidentTap(diameter: number, unit: UnitSystem): ThreadSpec | null {
  for (const th of table(unit)) {
    if (diameter >= th.drillLo && diameter <= th.drillHi) return th;
  }
  return null;
}

/** Thread whose clearance hole matches the diameter (mm) within tolerance, or null. */
export function confidentClearance(diameter: number, unit: UnitSystem): ThreadSpec | null {
  let best: { th: ThreadSpec; err: number } | null = null;
  for (const th of table(unit)) {
    const err = Math.abs(th.clearance - diameter);
    if (!best || err < best.err) best = { th, err };
  }
  return best && best.err <= CLEAR_TOL ? best.th : null;
}

// ---- Display helpers ----

/** Diameter formatted in the chosen unit, with the Φ symbol. */
export function dia(mm: number, unit: UnitSystem): string {
  return unit === "imperial" ? `Φ${(mm / 25.4).toFixed(3)}"` : `Φ${mm.toFixed(2)}`;
}
/** Plain length in the chosen unit. */
export function len(mm: number, unit: UnitSystem): string {
  return unit === "imperial" ? `${(mm / 25.4).toFixed(3)}"` : `${mm.toFixed(2)}`;
}

/** A category drives the sidebar pill text + color. */
export type HoleCategory = "tap" | "hole" | "counterbore" | "countersink";
export interface HoleDesc {
  category: HoleCategory;
  pill: string;
  /** Matched thread spec, only when the hole is confidently a tap hole. */
  thread: ThreadSpec | null;
}

/**
 * Describe a hole for the sidebar. Only tap drill sizes are named — clearance-hole
 * detection is intentionally omitted since a hole being "standard clearance size" is
 * not a confident enough signal to label it as such (e.g. 4.5mm == M4 clearance, but
 * the hole might simply be 4.5mm by design). Counterbores/countersinks show their type.
 */
export function describeHole(hole: Hole, unit: UnitSystem): HoleDesc {
  if (hole.type === "counterbore")
    return { category: "counterbore", pill: "COUNTERBORE", thread: null };
  if (hole.type === "countersink")
    return { category: "countersink", pill: "COUNTERSINK", thread: null };

  const tap = confidentTap(hole.diameter, unit);
  if (tap) return { category: "tap", pill: `${tap.name} TAP`, thread: tap };
  return { category: "hole", pill: `${diaU(hole.diameter, unit)} HOLE`, thread: null };
}

/** Dimension with its unit suffix auto-added (MM / inch), upper-case. */
export function dimU(mm: number, unit: UnitSystem): string {
  return unit === "imperial" ? `${(mm / 25.4).toFixed(3)}"` : `${mm.toFixed(2)} MM`;
}
/** Diameter (Φ) with unit suffix. */
export function diaU(mm: number, unit: UnitSystem): string {
  return `Φ${dimU(mm, unit)}`;
}

/**
 * Default, editable, multi-line GD&T callout for a hole feature. The user can edit
 * any line/aspect afterward. Symbols: Φ dia, ⌴ counterbore, ⌵ countersink, ↧ depth.
 * Assumes through holes ("THRU ALL"); units auto-added.
 *
 *   4X Φ3.30 mm THRU ALL
 *   M4 - 6H THRU ALL
 */
export function defaultCallout(hole: Hole, qty: number, unit: UnitSystem): string {
  const q = qty > 1 ? `${qty}X ` : "";
  const d = describeHole(hole, unit);
  const tol = unit === "imperial" ? "2B" : "6H";
  const drill = `${q}${diaU(hole.diameter, unit)} THRU ALL`;

  if (hole.type === "counterbore") {
    const cb = `⌴ ${diaU(hole.cboreDiameter ?? 0, unit)} ↧ ${dimU(hole.cboreDepth ?? 0, unit)}`;
    return `${drill}\n${cb}`;
  }
  if (hole.type === "countersink") {
    const cs = `⌵ ${diaU(hole.cskDiameter ?? 0, unit)} × ${(hole.cskAngleDeg ?? 90).toFixed(0)}°`;
    return `${drill}\n${cs}`;
  }
  if (d.category === "tap") return `${drill}\n${d.thread!.label.split("×")[0]} - ${tol} THRU ALL`;
  return drill;
}
