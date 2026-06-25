// Persists job analyses produced by job-analyst SUBAGENTS back into Postgres. The subagents run on the
// Claude Code plan (not the billed API), read the skill dynamically, and keep the job text out of the
// orchestrator's context. They write a JSON array of results to a file; this script imports it.
// Input file: JSON array of { source, ext_id, model, enrich: { want, qual, ... } }.
// Usage: node scoring/save-enrich.mjs <results.json>
import { readFile } from "node:fs/promises";
import { q, closePool } from "../lib/store.mjs";

const file = process.argv[2];
if (!file) { console.error("Usage: node scoring/save-enrich.mjs <results.json>"); process.exit(1); }

const clampInt = (v) => (v == null || isNaN(+v) ? null : Math.max(0, Math.min(100, Math.round(+v))));
const records = JSON.parse(await readFile(file, "utf8"));
if (!Array.isArray(records)) { console.error("Expected a JSON array of results."); process.exit(1); }

let saved = 0, skipped = 0;
for (const r of records) {
  if (!r.source || !r.ext_id || !r.enrich) { skipped++; console.error(`  skip (missing source/ext_id/enrich): ${JSON.stringify(r).slice(0, 80)}`); continue; }
  const e = { ...r.enrich, _model: r.model || r.enrich._model || "unknown" };
  await q(
    `UPDATE jobs SET enrich=$3, want_score=$4, qual_score=$5, enriched_at=now() WHERE source=$1 AND ext_id=$2`,
    [r.source, String(r.ext_id), JSON.stringify(e), clampInt(e.want), clampInt(e.qual)]
  );
  saved++;
}
console.error(`Saved ${saved} analyses, skipped ${skipped}.`);
await closePool();
