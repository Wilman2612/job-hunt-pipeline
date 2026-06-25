// Scores each posting in the index against profile/target.json + learned preferences,
// integrating geographic eligibility. Transparent heuristic (0-100) with breakdown and flags.
// Not eligible for Peru -> tombstone in excluded.jsonl (title/company saved, full record deleted).
// Eligible -> scored.jsonl.
// Usage: node scoring/score.mjs
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

  // 1) Role match — title first, body as fallback (0-30)
  const aiTitle = ["ai", "ml", "llm", "genai", "generative", "agent", "machine learning", "applied ai"].some((w) => title.includes(w));
  const engTitle = ["engineer", "developer", "swe", "backend", "architect"].some((w) => title.includes(w));
  const aiBody = ["llm", "large language model", "generative ai", "genai", "rag", "retrieval-augmented", "agent", "agentic", "langchain", "langgraph", "openai", "anthropic", "vector database", "embeddings"].some((w) => hay.includes(w));
  if (aiTitle && engTitle)       bd.role = 30;
  else if (aiTitle)              bd.role = 22;
  else if (engTitle && aiBody)   bd.role = 24; // engineer by title, AI by body
  else if (aiBody)               bd.role = 16; // AI body but vague title
  else if (engTitle)             bd.role = 10;
  else                           bd.role = 4;
  s += bd.role;

  // 2) AI depth (0-25)
  const aiHits = hits(hay, profile.core_keywords);
  bd.ai_depth = Math.min(25, aiHits.length * 4);
  s += bd.ai_depth;

  // 3) Stack match (0-20)
  const stackHits = hits(hay, profile.strong_stack_match);
  bd.stack = Math.min(20, stackHits.length * 3);
  s += bd.stack;

  // 4) Eligibility/region (+10 worldwide/latam, +5 unknown). Ineligible already filtered out.
  bd.region = elig.region === "unknown" ? 4 : 10;
  s += bd.region;

  // 5) Salary (-10..+15)
  let sal = 0;
  const m = (j.salary || "").match(/\$?\s?(\d{2,3})[,k]?\d{0,3}/);
  if (j.salary && m) {
    const k = parseInt(m[1], 10);
    if (k >= 60) sal = 15; else if (k >= 45) sal = 8; else { sal = -8; flags.push(`Low salary? ${j.salary}`); }
  } else flags.push("No salary disclosed");
  bd.salary = sal;
  s += sal;

  // 6) Role exclusions — title types the candidate is not (engineering BUILD-AI roles only).
  //    Flag "Title in avoid list" is also consumed by analyze-queue to skip these before the LLM.
  if (/(data analyst|qa engineer|frontend engineer|research scientist|recruiter|evaluator|solutions architect|pre-?sales|sales engineer|account executive|product manager|program manager|engineering manager|civil engineer|people ops|talent acquisition|data center|field technician)/.test(title)) {
    bd.exclusion = -25; flags.push("Title in avoid list"); s -= 25;
  }
  // Defense/weapons — candidate avoids (digest). Match on COMPANY + specific titles, NOT body "defense"
  // (which appears in "defense in depth", "last line of defense", etc.).
  if (/\b(shield ?ai|anduril|lockheed|raytheon|northrop|general dynamics|bae systems|palantir|saab)\b/.test(lc(j.company)) || /(weapons|munitions|warfare|missile|defense engineer)/.test(title)) {
    bd.defense = -40; flags.push("Defense/weapons (avoid)"); s -= 40;
  }

  // 7) Learned preferences
  if (hits(hay, learned.boost_keywords).length) { s += 8; bd.learned_boost = 8; }
  if (hits(hay, learned.penalize_keywords).length) { s -= 12; bd.learned_penalize = -12; flags.push("Penalized keyword (feedback)"); }
  if ((learned.rejected_companies || []).map(lc).includes(lc(j.company))) { s -= 30; flags.push("Company previously rejected"); }
  const paused = (learned.paused_companies || []).map((p) => lc(p.company || p));
  if (paused.includes(lc(j.company))) { s -= 40; flags.push("⏸ Company paused"); }
  if ((learned.already_applied || []).map(lc).includes(lc(j.company))) { s -= 50; flags.push("Already applied"); }

  if (elig.region === "unknown") flags.push("❓ Uncertain eligibility — verify");

  // 8) Multi-query gate bonus (embed.mjs must run first; jobs.semantic = mean of top-2 positive facet sims).
  // Calibrated to the multi-query scale: good jobs (want>=75&qual>=70) have p50≈0.57, p10≈0.51; all-jobs p90≈0.53.
  const sem = parseFloat(j.semantic) || 0;
  if (sem >= 0.58) { bd.semantic = 12; s += 12; }
  else if (sem >= 0.52) { bd.semantic = 6; s += 6; }
  else if (sem >= 0.47) { bd.semantic = 3; s += 3; }

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
const rescore = process.argv.includes("--rescore");
const all = await jobsForScoring({ rescore });
if (!rescore) console.error("(only jobs without a score — use --rescore to re-score all)");
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

console.error(`Total: ${all.length} | scored (eligible): ${scored.length} | excluded (ineligible): ${excluded}`);
console.error("\nTOP 15:");
for (const j of scored.slice(0, 15)) {
  console.error(`  [${String(j.score).padStart(3)}] ${j.title} @ ${j.company} — ${j.eligibility.region} (${j.source})`);
}
await closePool();
