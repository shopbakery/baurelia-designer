import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const reportPath = process.argv[2];
if (!reportPath) {
  throw new Error("Aufruf: node build-motif-v2-map.mjs <r2-resize-...-apply.jsonl>");
}

const rows = readFileSync(reportPath, "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
if (!rows.length || rows.some((row) => !["copied", "resized", "exists"].includes(row.status))) {
  throw new Error("Der Migrationsbericht ist leer oder enthält Fehler/nicht abgeschlossene Einträge.");
}

const entries = new Map();
for (const row of rows) {
  const source = row.source_key;
  const destination = row.destination_key;
  if (
    typeof source !== "string" ||
    typeof destination !== "string" ||
    !destination.startsWith("motifs-v2/") ||
    source === destination ||
    entries.has(source)
  ) {
    throw new Error(`Ungültiger oder doppelter R2-Schlüssel: ${source}`);
  }
  entries.set(source, destination);
}

const sorted = Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
const moduleText = `// Generated from the verified R2 migration report. Do not edit by hand.\n` +
  `export default Object.freeze(${JSON.stringify(sorted, null, 2)});\n`;
const outputPath = fileURLToPath(new URL("../../app/data/motif-v2-map.js", import.meta.url));
writeFileSync(outputPath, moduleText, "utf8");
console.log(`${entries.size} geprüfte R2-Zuordnungen geschrieben: ${outputPath}`);
