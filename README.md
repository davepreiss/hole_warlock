# Hole Warlock

A browser-based tool for adding manufacturing hole callouts to STEP files — and an attempt to explore what **drawing-less, 3D-first** drawing generation might look like.

## Why

If you've used services such as Xometry, JLCPCB/JLCCNC, or SendCutSend, you may have noticed that uploading a `.step` file alone isn't enough. A STEP file carries geometry, not intent: it can't tell the shop which holes are tapped, what thread, or which dimensions are critical. That information normally lives in a 2D drawing.

Hole Warlock lets you add those callouts quickly, directly on the 3D model, to **supplement** a STEP file you're sending out for quoting — without round-tripping through a full CAD package and a formal drawing.

It can also **embed the callout metadata back into the STEP file itself**, so a single annotated `.step` carries both the geometry and the manufacturing intent.

## How the metadata is stored

When you save an annotated STEP, Hole Warlock embeds its data as a **JSON payload** (base64-encoded) inside an ISO 10303-21 (Part 21) `/* ... */` comment block placed right after the `DATA;` line:

```text
/* HOLE-WARLOCK-V1
eyJ...base64...
HOLE-WARLOCK-END */
```

Part 21 permits comments anywhere whitespace is allowed, so the file stays a **fully valid STEP file** that any CAD tool can open — the comment is simply ignored by other readers, and the original geometry bytes are left untouched. Base64 guarantees the payload can never contain the `*/` terminator or perturb tokenizing.

The STEP format *does* have a standards-based mechanism for this (XCAF property entities), but we opted not to use it at this time. The trade-off: a foreign CAD tool that re-saves the file may drop the comment. (Embedding via XCAF properties so the data survives foreign round-trips is a planned upgrade.) See [`src/cad/metadata.ts`](src/cad/metadata.ts) for the full implementation.

## Navigation

In the 3D view:

- **Left-drag** — rotate (orbit)
- **Right-drag** — pan (screen-space)
- **Scroll wheel** — zoom
- **Ctrl + left-drag** — roll the camera around the line of sight (the third axis orbit can't reach). This is available in **Drawing** view, where you're framing the part for a sheet, and there's a *reset roll* to snap back to Z-up.

## Hole detection & tap guessing

Hole Warlock analyzes the B-rep solid to find hole **features**, grouping coaxial cylindrical and conical faces by their axis. Each is classified as a:

- **Simple hole**
- **Counterbore** (a second, larger coaxial bore)
- **Countersink** (a coaxial cone at the entry)

It also determines whether each hole is **through** or **blind**.

Diameters are matched against standard thread tables to guess **tapped holes**. A hole that will be tapped is drilled somewhere between the theoretical tap-drill size and the slightly larger hole SendCutSend recommends, so each thread carries an **acceptance band** `[drillLo, drillHi]`; a hole whose diameter falls inside that band is confidently labeled as that tap. Both **metric coarse** and **imperial (UNC/UNF)** tables are included, with bands built from typical tap-drill sizes and the SendCutSend tolerance recommendations for laser-cut parts.

Clearance-hole *naming* is intentionally omitted — a hole being a "standard clearance size" isn't a confident enough signal (a 4.5 mm hole might be an M4 clearance, or just a 4.5 mm hole by design), so those are left as plain diameter callouts. See [`src/cad/taps.ts`](src/cad/taps.ts) and [`src/cad/holes.ts`](src/cad/holes.ts).

### Hole grouping

Identical holes are **auto-grouped** by a signature (entry feature, diameter, depth, the planar face they sit on, and through/blind), so a callout like `6X Φ3.30 THRU ALL` covers them all at once. You can manually **group**, **split**, or **ungroup** holes, and override the auto-detected pill (e.g. force a hole to read as a tap instead of a plain hole).

## Model & Drawing views

Hole Warlock has two modes:

- **Model** (engineer view) — inspect the part, pick faces/edges, and edit holes and annotations.
- **Drawing** (manufacturer view) — the annotated part laid out on an **ANSI-B sheet** with a title block, material/finish block, an editable notes field (with a critical-dimension callout pill), and leader lines to each callout. Export the result to **PDF**.

### Editing leaders in Drawing view

- **Click** an annotation's arrow to **flip it to the hole's opposite end** (entry ↔ far side).
- **Press and drag** the arrow to swing its anchor around the hole rim.
- Drag the callout **labels** themselves to position them. Placements persist with the annotation, so a tuned drawing reloads exactly as you left it.

## GD&T

Beyond plain callouts, you can add basic GD&T:

- **Datums** — assign labels (A, B, C…) to faces or edges.
- **Feature control frames** — position, parallelism, perpendicularity, circularity, and angularity, each with a tolerance value and an optional MMC/LMC modifier and datum references.

## Development

```bash
npm install
npm run dev      # start the Vite dev server
npm run build    # type-check + production build
npm run preview  # preview the production build
```

Hole Warlock runs entirely in the browser — geometry is parsed and meshed client-side, and nothing is uploaded to a server.
