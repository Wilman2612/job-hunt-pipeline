// Autonomous analysis worker: processes the queue of eligible UNANALYZED postings, in priority
// order (semantic similarity desc — best first), calling Claude with the calibrated spec.
// Text flows script → LLM → Postgres (does not inflate the orchestrator's context). Resumable: skips
// already analyzed postings. Uses Claude Sonnet intentionally: strict reasoning for "hard stops"
// (geo, impossible requirements, salary) and structured JSON justify it (see README).
// Usage: node --env-file=.env scoring/analyze-queue.mjs [--limit=N] [--conc=4]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { q, ROOT, closePool } from "../lib/store.mjs";

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANALYZE_MODEL || "claude-3-5-sonnet-latest";
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY in .env"); process.exit(1); }

const args = process.argv.slice(2);
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || 99999);
const CONC = Number(args.find((a) => a.startsWith("--conc="))?.split("=")[1] || 4);

const digest = await readFile(path.join(ROOT, "profile/digest.md"), "utf8");
const spec = await readFile(path.join(ROOT, "profile/enrich-spec.md"), "utf8");

const SYSTEM = `You are the candidate's rigorous head hunter. You analyze ONE posting and return ONLY a JSON object (no extra text, no markdown).

CANDIDATE PROFILE:
${digest}

ANALYSIS SPEC (follow it to the letter; include ALL keys):
${spec}`;

// Extracts the first JSON object from the text (Claude sometimes wraps it in prose or fences).
function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
}

async function analyze(job) {
  const user = `POSTING (source=${job.source}):
TITLE: ${job.title}
COMPANY: ${job.company}
LOCATION: ${job.location}
DESCRIPTION:
${(job.raw_text || "").slice(0, 9000)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.2,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return parseJson((await r.json()).content[0].text);
}

const clampInt = (v) => (v == null || isNaN(+v) ? null : Math.max(0, Math.min(100, Math.round(+v))));

async function save(job, e) {
  await q(
    `UPDATE jobs SET enrich=$3, want_score=$4, qual_score=$5, enriched_at=now() WHERE source=$1 AND ext_id=$2`,
    [job.source, job.ext_id, JSON.stringify(e), clampInt(e.want), clampInt(e.qual)]
  );
}

// Queue: eligible, with text, not yet analyzed, best-first by semantic similarity.
const { rows } = await q(
  `SELECT source, ext_id, title, company, location, raw_text FROM jobs
   WHERE enrich IS NULL AND raw_text IS NOT NULL AND length(raw_text) > 40
     AND (eligibility->>'eligibleForPeru')='true'
   ORDER BY semantic DESC NULLS LAST, score DESC NULLS LAST
   LIMIT $1`,
  [LIMIT]
);

console.error(`Queue: ${rows.length} eligible postings not yet analyzed. Model: ${MODEL}, concurrency: ${CONC}.`);
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
