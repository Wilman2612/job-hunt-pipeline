// Destila decisions.jsonl en profile/learned.json:
//   - keywords sobre-representadas en APROBADAS  -> boost_keywords
//   - keywords sobre-representadas en DESCARTADAS -> penalize_keywords
//   - empresas descartadas (repetidas)            -> rejected_companies
// Compara frecuencias (apruebo vs descarto) sobre título + raw_text de cada oferta.
// Uso: node scoring/learn.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, loadScored, loadDecisions, readJob, closePool } from "../lib/store.mjs";

const LEARNED = path.join(ROOT, "profile/learned.json");
let learned = { boost_keywords: [], penalize_keywords: [], rejected_companies: [], paused_companies: [], already_applied: [], decisions_log: [] };
try { learned = { ...learned, ...JSON.parse(await readFile(LEARNED, "utf8")) }; } catch {}

const STOP = new Set("the and for with you your our are will que con los las una para por del job role team work remote experience years strong have this that from they our who what role about able plus must should within across using build help join looking".split(/\s+/));
const tokenize = (s) => (s || "").toLowerCase().match(/[a-záéíóúñ][a-záéíóúñ.+#/-]{2,}/gi) || [];

const scored = await loadScored();
const byKey = new Map(scored.map((r) => [`${r.source}::${r.id}`, r]));
const decisions = await loadDecisions();

const approvedDocs = [], rejectedDocs = [], rejectedCos = new Map();
for (const [key, d] of decisions) {
  const r = byKey.get(key); if (!r) continue;
  const job = await readJob(r.source, r.id);
  const doc = new Set(tokenize(`${r.title} ${r.title} ${job?.raw_text || ""}`).filter((t) => !STOP.has(t) && t.length > 2));
  if (d.decision === "approve") approvedDocs.push(doc);
  else if (d.decision === "reject") {
    rejectedDocs.push(doc);
    const c = (r.company || "").toLowerCase(); if (c) rejectedCos.set(c, (rejectedCos.get(c) || 0) + 1);
  }
}

function distinctive(plusDocs, minusDocs, minDocs = 2) {
  if (plusDocs.length < minDocs) return [];
  const plus = new Map(), minus = new Map();
  for (const d of plusDocs) for (const t of d) plus.set(t, (plus.get(t) || 0) + 1);
  for (const d of minusDocs) for (const t of d) minus.set(t, (minus.get(t) || 0) + 1);
  const out = [];
  for (const [t, c] of plus) {
    const pRate = c / plusDocs.length;
    const mRate = (minus.get(t) || 0) / Math.max(1, minusDocs.length);
    if (pRate >= 0.5 && pRate - mRate >= 0.34) out.push([t, pRate - mRate]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 20).map((x) => x[0]);
}

const merge = (a, b) => [...new Set([...(a || []), ...b])];
learned.boost_keywords = merge(learned.boost_keywords, distinctive(approvedDocs, rejectedDocs));
learned.penalize_keywords = merge(learned.penalize_keywords, distinctive(rejectedDocs, approvedDocs));
learned.rejected_companies = merge(learned.rejected_companies, [...rejectedCos].filter(([, n]) => n >= 1).map(([c]) => c));
learned.decisions_log = [{ ts: new Date().toISOString(), approved: approvedDocs.length, rejected: rejectedDocs.length }, ...(learned.decisions_log || [])].slice(0, 20);

await writeFile(LEARNED, JSON.stringify(learned, null, 2));
console.error(`Aprendido de ${approvedDocs.length} aprobadas / ${rejectedDocs.length} descartadas.`);
console.error(`boost: [${learned.boost_keywords.slice(0, 12).join(", ")}]`);
console.error(`penalize: [${learned.penalize_keywords.slice(0, 12).join(", ")}]`);
console.error(`rejected_companies: [${learned.rejected_companies.join(", ")}]`);
await closePool();
