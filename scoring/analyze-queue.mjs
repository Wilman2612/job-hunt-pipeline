// Autonomous analysis worker: processes the queue of eligible UNANALYZED postings, in priority
// order (semantic similarity desc — best first), calling Claude with the calibrated spec.
// Text flows script → LLM → Postgres (does not inflate the orchestrator's context). Resumable: skips
// already analyzed postings. Uses Claude Sonnet intentionally: strict reasoning for "hard stops"
// (geo, impossible requirements, salary) and structured JSON justify it (see README).
// Usage: node --env-file=.env scoring/analyze-queue.mjs [--limit=N] [--conc=4]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { q, ROOT, closePool } from "../lib/store.mjs";
import { callJson, hasKey, DEFAULT_MODEL, PROVIDER } from "../lib/llm.mjs";

// Model is swappable (lib/llm): ANALYZE_MODEL overrides; else the provider default.
const MODEL = process.env.ANALYZE_MODEL || DEFAULT_MODEL;
if (!hasKey()) { console.error(`Missing API key for LLM_PROVIDER=${PROVIDER} (set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env)`); process.exit(1); }

const args = process.argv.slice(2);
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || 99999);
const CONC = Number(args.find((a) => a.startsWith("--conc="))?.split("=")[1] || 4);
// Multi-query gate floor: only spend the LLM on postings whose gate score clears the productive zone.
// 0.48 ≈ 95%+ recall of good jobs while cutting ~80% of the pool (see profile/facets.json + README).
const FLOOR = Number(args.find((a) => a.startsWith("--floor="))?.split("=")[1] || 0.48);

const digest = await readFile(path.join(ROOT, "profile/digest.md"), "utf8");
const spec = await readFile(path.join(ROOT, "profile/enrich-spec.md"), "utf8");

const SYSTEM = `You are the candidate's rigorous head hunter. You analyze ONE posting and return ONLY a JSON object (no extra text, no markdown).

CANDIDATE PROFILE:
${digest}

ANALYSIS SPEC (follow it to the letter; include ALL keys):
${spec}`;

async function analyze(job) {
  const user = `POSTING (source=${job.source}):
TITLE: ${job.title}
COMPANY: ${job.company}
LOCATION: ${job.location}
DESCRIPTION:
${(job.raw_text || "").slice(0, 9000)}`;
  return callJson({ system: SYSTEM, user, model: MODEL, maxTokens: 1500, temperature: 0.2 });
}

const clampInt = (v) => (v == null || isNaN(+v) ? null : Math.max(0, Math.min(100, Math.round(+v))));

async function save(job, e) {
  // Record provenance so "which model analyzed this?" is never ambiguous again.
  const enriched = { ...e, _model: MODEL };
  await q(
    `UPDATE jobs SET enrich=$3, want_score=$4, qual_score=$5, enriched_at=now() WHERE source=$1 AND ext_id=$2`,
    [job.source, job.ext_id, JSON.stringify(enriched), clampInt(e.want), clampInt(e.qual)]
  );
}

// Queue: eligible, with text, gate-cleared, not yet analyzed, best-first by gate score.
// The FLOOR realizes "don't analyze the far ones": postings below it are left unanalyzed (not deleted)
// — they stay visible in the dashboard, just not worth the LLM. Run scoring/embed.mjs first so semantic exists.
const { rows } = await q(
  `SELECT source, ext_id, title, company, location, raw_text FROM jobs
   WHERE enrich IS NULL AND raw_text IS NOT NULL AND length(raw_text) > 40
     AND (eligibility->>'eligibleForPeru')='true'
     AND semantic >= $2
     AND NOT (flags && ARRAY['Title in avoid list','Defense/weapons (avoid)']::text[])
   ORDER BY semantic DESC NULLS LAST, score DESC NULLS LAST
   LIMIT $1`,
  [LIMIT, FLOOR]
);

console.error(`Queue: ${rows.length} eligible + gated (semantic>=${FLOOR}) not yet analyzed. ${PROVIDER}/${MODEL}, concurrency: ${CONC}.`);
let done = 0, fail = 0;
const queue = [...rows];
async function worker() {
  while (queue.length) {
    const job = queue.shift();
    try { await save(job, await analyze(job)); done++; }
    catch (err) { fail++; console.error(`  ✗ ${job.company}: ${err.message}`); }
    if ((done + fail) % 25 === 0) process.stderr.write(`  progress ${done + fail}/${rows.length} (ok ${done}, fail ${fail})\n`);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
console.error(`\nQueue analysis: ${done} saved, ${fail} failed.`);
await closePool();
