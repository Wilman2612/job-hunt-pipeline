// Re-aplica la elegibilidad ESTRICTA (eligibility.mjs) a todas las ofertas usando su
// location + raw_text, y actualiza la columna `eligibility` y `enrich.geo`. Determinista,
// sin subagentes. Corregir el deck tras el feedback de the candidate (remoto ≠ tu región).
// Uso: node --env-file=.env scoring/recheck-geo.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { q, closePool, ROOT } from "../lib/store.mjs";
import { classify } from "./eligibility.mjs";

// Empresas donde the candidate NO puede/quiere postular: en pausa (Lemon) o PERUANAS (evita locales).
let blocked = new Set(), peruvian = new Set();
try {
  const L = JSON.parse(await readFile(path.join(ROOT, "profile/learned.json"), "utf8"));
  for (const p of [...(L.paused_companies || []), ...(L.cannot_apply || [])]) blocked.add((p.company || p).toLowerCase());
  for (const p of (L.peruvian_companies || [])) peruvian.add((p.company || p).toLowerCase().trim());
} catch {}
const isPeruvian = (co) => { const c = (co || "").toLowerCase(); return [...peruvian].some((p) => p && c.includes(p)); };

const { rows } = await q("SELECT source, ext_id, company, location, raw_text, enrich FROM jobs");
let ineligible = 0;
for (const r of rows) {
  let e = classify(r.location, r.raw_text || "", r.source);
  if (r.company && blocked.has(r.company.toLowerCase())) e = { region: "no-aplica", eligibleForPeru: false, evidence: "empresa en pausa / no se puede postular" };
  else if (isPeruvian(r.company)) e = { region: "empresa-peruana", eligibleForPeru: false, evidence: "empresa peruana (the candidate evita locales)" };
  // Conservador: si el subagente YA marcó no-elegible, no lo perdemos.
  const prev = r.enrich?.geo;
  let region = e.region, elig = e.eligibleForPeru, note = e.evidence;
  if (prev && prev.eligible_peru === false && e.eligibleForPeru) {
    region = prev.region; elig = false; note = prev.note || e.evidence; // gana lo más restrictivo
  }
  const eligJson = JSON.stringify({ region, eligibleForPeru: elig, evidence: note });
  if (r.enrich) {
    const geo = JSON.stringify({ region, eligible_peru: elig, note });
    await q("UPDATE jobs SET eligibility=$3, enrich=jsonb_set(enrich,'{geo}',$4::jsonb) WHERE source=$1 AND ext_id=$2",
      [r.source, r.ext_id, eligJson, geo]);
  } else {
    await q("UPDATE jobs SET eligibility=$3 WHERE source=$1 AND ext_id=$2", [r.source, r.ext_id, eligJson]);
  }
  if (!elig) ineligible++;
}
console.error(`Reclasificadas ${rows.length} | no-elegibles: ${ineligible} | elegibles: ${rows.length - ineligible}`);
const { rows: bd } = await q("SELECT eligibility->>'region' AS region, count(*) c FROM jobs GROUP BY 1 ORDER BY 2 DESC");
console.error("Por región:");
for (const x of bd) console.error(`  ${x.region}: ${x.c}`);
await closePool();
