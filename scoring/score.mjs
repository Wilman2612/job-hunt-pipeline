// Puntúa cada oferta del índice contra profile/target.json + preferencias aprendidas,
// integrando elegibilidad geográfica. Heurística transparente (0-100) con desglose y flags.
// No-elegibles para Perú -> tombstone en excluded.jsonl (se guarda título/empresa, se borra el
// registro completo). Elegibles -> scored.jsonl.
// Uso: node scoring/score.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { jobsForScoring, writeScored, addExclusion, ROOT, closePool } from "../lib/store.mjs";
import { classify } from "./eligibility.mjs";

const profile = JSON.parse(await readFile(path.join(ROOT, "profile/target.json"), "utf8"));
let learned = { boost_keywords: [], penalize_keywords: [], rejected_companies: [], paused_companies: [], already_applied: [] };
try { learned = { ...learned, ...JSON.parse(await readFile(path.join(ROOT, "profile/learned.json"), "utf8")) }; } catch {}

const lc = (s) => (s || "").toLowerCase();
const hits = (hay, list) => (list || []).filter((k) => k && hay.includes(lc(k)));

function score(j, elig) {
  const title = lc(j.title);
  const hay = lc(`${j.title} ${j.raw_text || j.description || ""} ${(j.tags || []).join(" ")}`);
  const flags = [];
  let s = 0;
  const bd = {};

  // 1) Role match en título (0-30)
  const aiTitle = ["ai", "ml", "llm", "genai", "generative", "agent", "machine learning", "applied ai"].some((w) => title.includes(w));
  const engTitle = ["engineer", "developer", "swe", "backend"].some((w) => title.includes(w));
  bd.role = aiTitle && engTitle ? 30 : aiTitle ? 22 : engTitle ? 10 : 4;
  s += bd.role;

  // 2) Profundidad AI (0-25)
  const aiHits = hits(hay, profile.core_keywords);
  bd.ai_depth = Math.min(25, aiHits.length * 4);
  s += bd.ai_depth;

  // 3) Stack (0-20)
  const stackHits = hits(hay, profile.strong_stack_match);
  bd.stack = Math.min(20, stackHits.length * 3);
  s += bd.stack;

  // 4) Elegibilidad/región (+10 worldwide/latam, +5 unknown). Las no-elegibles ya se filtraron.
  bd.region = elig.region === "unknown" ? 4 : 10;
  s += bd.region;

  // 5) Salario (-10..+15)
  let sal = 0;
  const m = (j.salary || "").match(/\$?\s?(\d{2,3})[,k]?\d{0,3}/);
  if (j.salary && m) {
    const k = parseInt(m[1], 10);
    if (k >= 60) sal = 15; else if (k >= 45) sal = 8; else { sal = -8; flags.push(`Salario bajo? ${j.salary}`); }
  } else flags.push("Sin salario publicado");
  bd.salary = sal;
  s += sal;

  // 6) Exclusiones por rol
  if (/(data analyst|qa engineer|frontend engineer|research scientist|recruiter|evaluator)/.test(title)) {
    bd.exclusion = -25; flags.push("Título en lista de evitar"); s -= 25;
  }

  // 7) Preferencias aprendidas
  if (hits(hay, learned.boost_keywords).length) { s += 8; bd.learned_boost = 8; }
  if (hits(hay, learned.penalize_keywords).length) { s -= 12; bd.learned_penalize = -12; flags.push("Keyword penalizado (feedback)"); }
  if ((learned.rejected_companies || []).map(lc).includes(lc(j.company))) { s -= 30; flags.push("Empresa rechazada antes"); }
  const paused = (learned.paused_companies || []).map((p) => lc(p.company || p));
  if (paused.includes(lc(j.company))) { s -= 40; flags.push("⏸ Empresa en pausa"); }
  if ((learned.already_applied || []).map(lc).includes(lc(j.company))) { s -= 50; flags.push("Ya postulado"); }

  if (elig.region === "unknown") flags.push("❓ Elegibilidad incierta — verificar");

  return {
    id: String(j.id), source: j.source, title: j.title, company: j.company,
    location: j.location, url: j.url, salary: j.salary || null, posted: j.posted || null,
    easyApply: !!j.easyApply, hasDetail: !!(j.raw_text || j.description),
    eligibility: elig,
    score: Math.max(0, Math.min(100, Math.round(s))),
    breakdown: bd,
    matched: { ai: aiHits.slice(0, 10), stack: stackHits.slice(0, 10) },
    flags,
  };
}

// --- main ---
const all = await jobsForScoring();
const scored = [];
let excluded = 0;

for (const full of all) {
  const elig = classify(full.location, full.raw_text || "", full.source);
  if (!elig.eligibleForPeru) {
    await addExclusion(full, `no-elegible:${elig.region}`);
    excluded++;
    continue;
  }
  scored.push(score(full, elig));
}

scored.sort((a, b) => b.score - a.score);
await writeScored(scored);

console.error(`Total: ${all.length} | scored (elegibles): ${scored.length} | excluidas (no-elegibles): ${excluded}`);
console.error("\nTOP 15:");
for (const j of scored.slice(0, 15)) {
  console.error(`  [${String(j.score).padStart(3)}] ${j.title} @ ${j.company} — ${j.eligibility.region} (${j.source})`);
}
await closePool();
