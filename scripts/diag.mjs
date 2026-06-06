// Surface the real error when loading the OCCT glue under Node.
try {
  const mod = await import("opencascade.js/dist/opencascade.wasm.js");
  const factory = mod.default;
  console.log("imported glue; typeof factory =", typeof factory);
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const wasmPath = fileURLToPath(
    new URL("../node_modules/opencascade.js/dist/opencascade.wasm.wasm", import.meta.url),
  );
  const wasmBinary = readFileSync(wasmPath);
  const oc = await factory({ wasmBinary });
  console.log("OCCT ready; has BRepPrimAPI_MakeBox_2 =", typeof oc.BRepPrimAPI_MakeBox_2);
} catch (e) {
  console.error("LOAD ERROR:", e && e.message ? e.message : e);
  console.error("STACK (first 5 lines):");
  console.error(String(e && e.stack).split("\n").slice(0, 5).join("\n"));
}
