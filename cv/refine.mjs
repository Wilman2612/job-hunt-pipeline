// MULTI-AGENT CV refinement: three roles with distinct objectives that iterate with feedback.
//   1) ATS screener  → scores parsing + keyword coverage vs the job description.
//   2) Recruiter      → 6-second scan: fit, impact, credibility, red flags.
//   3) Reviser        → rewrites addressing both critiques. GUARDRAIL: only uses facts from the
//                       knowledge base; reframes/emphasizes, NEVER fabricates.
// Loop until ATS and recruiter both pass the threshold or rounds are exhausted.
//
// NO RAG by design: the data (1 CV + 1 JD + 1 KB) fits in context; a vector store would be
// over-engineering for this volume. Direct calls to the Claude API → zero deps.
// (Standalone, but can also be orchestrated with Claude Code.)
//
// Usage:
//   node --env-file=.env cv/refine.mjs --jd=job.txt --kb=cv_base.md [--cv=draft.md] \
//        [--out=cv.final.md] [--rounds=3] [--threshold=80]
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CV_MODEL || "claude-3-5-sonnet-latest";
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY in .env"); process.exit(1); }

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const ROUNDS = Number(arg("rounds", 3));
const THRESHOLD = Number(arg("threshold", 80));
const OUT = arg("out", "cv.final.md");

async function claude(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.3, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).content[0].text;
}
const parseJson = (t) => { const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); return JSON.parse(f ? f[1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); };
const stripFences = (t) => { const f = t.match(/```(?:markdown|md)?\s*([\s\S]*?)```/); return (f ? f[1] : t).trim(); };

// --- Roles (each is an agent with its own system prompt and objective) ---
const ATS_SYS = `You are an Applicant Tracking System (ATS) + first technical filter. You evaluate a CV against a job description the way an ATS parser and screener would. Return ONLY JSON:
{"score":0-100,"missing_keywords":[...],"format_risks":[...],"notes":"1-2 sentences"}
Penalize: key JD keywords missing from the CV; non-standard sections; tables/columns that break parsing; acronyms not expanded at least once.`;

const RECRUITER_SYS = `You are a senior technical recruiter doing the 6-second scan. You evaluate whether the CV SELLS the candidate for THIS role. Return ONLY JSON:
{"score":0-100,"strengths":[...],"weaknesses":[...],"red_flags":[...],"verdict":"1 sentence"}
Look at: does the top third communicate fit?; is there measurable impact?; is it credible or does it sound like hype?; any inflated or inconsistent claims?`;

const REVISER_SYS = `You are a technical CV writer. You rewrite the CV to raise its score with the ATS and the recruiter, addressing their critiques.
INVIOLABLE RULE: you can only use facts present in the KNOWLEDGE BASE. Do NOT invent jobs, metrics, years, or technologies. You may reorder, reframe, emphasize, and align keywords with the JD — never fabricate.
Format: clean markdown, 1-2 pages, standard sections. Return ONLY the CV in markdown, no commentary.`;

const atsReview = (cv, jd) => claude(ATS_SYS, `JOB DESCRIPTION:\n${jd}\n\nCV:\n${cv}`, 700).then(parseJson);
const recruiterReview = (cv, jd) => claude(RECRUITER_SYS, `JOB DESCRIPTION:\n${jd}\n\nCV:\n${cv}`, 700).then(parseJson);

function revise(cv, jd, kb, ats, rec) {
  const crit = `ATS CRITIQUE (score ${ats.score}): missing keywords ${JSON.stringify(ats.missing_keywords)}; format risks ${JSON.stringify(ats.format_risks)}. ${ats.notes}
RECRUITER CRITIQUE (score ${rec.score}): weaknesses ${JSON.stringify(rec.weaknesses)}; red flags ${JSON.stringify(rec.red_flags)}. ${rec.verdict}`;
  return claude(REVISER_SYS, `KNOWLEDGE BASE (only permitted source of facts):\n${kb}\n\nJOB DESCRIPTION:\n${jd}\n\nCURRENT CV:\n${cv}\n\nCRITIQUES TO ADDRESS:\n${crit}`, 2500).then(stripFences);
}
const writeDraft = (jd, kb) =>
  claude(REVISER_SYS, `KNOWLEDGE BASE (only permitted source of facts):\n${kb}\n\nJOB DESCRIPTION:\n${jd}\n\nWrite an initial 1-2 page CV tailored to this role, using ONLY facts from the knowledge base.`, 2500).then(stripFences);

// --- Loop orchestration ---
const jdPath = arg("jd"), kbPath = arg("kb");
if (!jdPath || !kbPath) { console.error("Missing --jd=<job.txt> and --kb=<cv_base.md>"); process.exit(1); }
const jd = await readFile(jdPath, "utf8");
const kb = await readFile(kbPath, "utf8");
let cv = arg("cv") ? await readFile(arg("cv"), "utf8") : (console.error("No draft provided → generating initial CV…"), await writeDraft(jd, kb));

const trace = [];
for (let i = 1; i <= ROUNDS; i++) {
  const [ats, rec] = await Promise.all([atsReview(cv, jd), recruiterReview(cv, jd)]);
  trace.push({ round: i, ats: ats.score, recruiter: rec.score });
  console.error(`Round ${i}:  ATS ${ats.score}  |  Recruiter ${rec.score}`);
  if (ats.score >= THRESHOLD && rec.score >= THRESHOLD) { console.error("✓ Both pass the threshold — done."); break; }
  if (i < ROUNDS) cv = await revise(cv, jd, kb, ats, rec);
}
await writeFile(OUT, cv, "utf8");
console.error(`\nFinal CV → ${OUT}`);
console.error("Trace:", JSON.stringify(trace));
