# Hole Warlock

Hole Warlock is a browser-based tool for adding manufacturing hole callouts to .step files — and an attempt to explore how a **drawing-less, 3D-first** annotation process might work. It runs entirely in the browser — geometry is parsed and meshed client-side, and nothing is uploaded to a server.

If you've used services such as Xometry, JLCPCB/JLCCNC, you may have noticed that a 2D drawing is necessary to convey design intent for features like tapped holes. Hole Warlock lets you add those callouts quickly, directly on the 3D model, to **supplement a .step file*** you're sending out for quoting — without round-tripping through a full CAD package and a formal drawing.

It can also **embed the callout metadata back into the .step file itself**, so a single annotated `.step` carries both the geometry and the manufacturing intent.

## Navigation

In the 3D view:

- **Left-drag** — rotate (orbit)
- **Right-drag** — pan (screen-space)
- **Scroll wheel** — zoom
- **Ctrl + left-drag** — roll the camera around the line of sight (the third axis orbit can't
  reach). This is available in **Drawing** view, where you're framing the part for a sheet, and
  there's a *reset roll* to snap back to Z-up.

## Hole Detection & Tap Guessing

Hole Warlock analyzes the B-rep solid to find hole **features**, grouping coaxial cylindrical and
conical faces by their axis. Each is classified as a:

- **Simple Hole**
- **Tapped Hole** 
- **Counterbore** (a second, larger coaxial bore)
- **Countersink** (a coaxial cone at the entry)

It also determines whether each hole is **through** or **blind**.

Diameters are matched against standard thread tables to guess **tapped holes**, with some tolerances afforded for lasercut parts as per SCS' tapped hole guidelines: https://sendcutsend.com/services/tapping/#guidelines/

### Hole Grouping

Identical holes are **auto-grouped** by a signature (entry feature, diameter, depth, the planar face
they sit on, and through/blind), so a callout like `6X Φ3.30 THRU ALL` covers them all at once. You
can manually **group**, **split**, or **ungroup** holes, and override the auto-detected pill (e.g.
force a hole to read as a tap instead of a plain hole).

## Model & Drawing Views

Hole Warlock has two modes:

- **Model** (engineer view) — inspect the part, pick faces/edges, and edit holes and annotations.
- **Drawing** (manufacturer view) — the annotated part laid out on an **ANSI-B sheet** with a title
  block, material/finish block, an editable notes field (with a critical-dimension callout pill),
  and leader lines to each callout. Export the result to **PDF**.

### Editing Leaders in Drawing View

- **Click** an annotation's arrow to **flip it to the hole's opposite end** (entry ↔ far side).
- **Press and drag** the arrow to swing its anchor around the hole rim.
- Drag the callout **labels** themselves to position them. Placements persist with the annotation, so
  a tuned drawing reloads exactly as you left it.

## GD&T

GD&T support is on the roadmap, but not currently supported. 

## Metadata Storage

When you save an annotated .step, Hole Warlock embeds its data as a **JSON payload** (base64-encoded)
inside an ISO 10303-21 (Part 21) `/* ... */` comment block placed right after the `DATA;` line:

```text
/* METROLOGY-INTEGRATED-V1
eyJ...base64...
METROLOGY-INTEGRATED-END */
```

Part 21 permits comments anywhere whitespace is allowed, so the file stays a **fully valid
.step file** that any CAD tool can open — the comment is simply ignored by other readers, and the
original geometry bytes are left untouched. Base64 guarantees the payload can never contain the
`*/` terminator or perturb tokenizing.

The .step format *does* have a standards-based mechanism for this (XCAF property entities), but we
opted not to use it at this time. The trade-off: a foreign CAD tool that re-saves the file may drop
the comment. (Embedding via XCAF properties so the data survives foreign round-trips is a planned
upgrade.) See [`src/cad/metadata.ts`](src/cad/metadata.ts) for the full implementation.